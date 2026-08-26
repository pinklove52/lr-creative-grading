# 修复与防再发方案（Remediation Plan）

> 日期：2026-08-22
> 输入：实机验收暴露的 7 项问题（温度单位混乱 / 回滚假成功 / 快照保障不完整 /
> 事务仅内存 / 隔离失败堵死队列 / 代码漂移未拦截 / 阶段报告误判）
> 关联文档：`LIGHTROOM_BRIDGE_RELIABILITY_PLAN.md`（v1 要求）、
> `LIGHTROOM_BRIDGE_EXECUTION_PLAN.md`（v2 执行方案）、`LIVE_VALIDATION_CHECKLIST.md`

---

## 1. 为什么会出现——四层根因链

问题清单是表象，根因是一条四层的因果链，**每一层都为下一层开了门**：

### 1.1 验证自指（总根因）

Mock、假插件、实现代码出自同一个作者、同一套假设。测试只能证明"实现与假设自洽"，
不能证明"假设与 Adobe 现实相符"。最典型的证据：旧 mock 里手写的
`temperature: [2000, 50000]`（开尔文语义）让我方 54 项测试全绿——绿灯验证的是我
自己的想象。v1 方案白纸黑字写着"不把 Mock 通过等同于实机通过"，但没有任何
**机制**强制这条原则，于是它只停留在纸面。

### 1.2 复用免审

"原样复用 BridgeCore"时，验证了传输解耦、字节一致、旧测试通过——唯独没有做
**条款对照审计**：把 v1 的每条验收要求（回滚后全量比对、禁止静默降级、快照失败
必须拒绝写入）逐条映射到代码行。旧代码写于 v1 方案之前，本来就不满足其中若干条。
"旧测试通过"被错误等同于"满足 v1 要求"。

### 1.3 门禁未 fail-closed

v1 的核心原则是"不确定即拒绝"，但执行中留下了两个反向通道：
- environment-doctor 把插件完整性设为软检查（`ok=true` 仍可返回）；
- verify-stages 的阶段标签是自由文本，模拟证据可以标成 M4。

结果是"未验收状态"可以伪装成"已通过"。**凡是靠自觉遵守的规则，最终都会被
赶工期绕过。**

### 1.4 纪律无强制力

改了插件代码不需要重发校验和、不需要重跑阶段验收；模拟器比真实现更宽容
（假插件隔离前先删目标，Lua 没有），分叉无人发现。没有把"改代码 → 重验"变成
流程上的必经节点。

**一句话：不是因为问题难发现，而是因为发现问题的责任被交给了"本应会做的自觉"，
而没有交给"不做就会失败的机制"。**

---

## 2. 防再发机制（六条，全部落到工件，不靠自觉）

| # | 机制 | 落地工件 | 强制方式 |
|---|---|---|---|
| 1 | **探测驱动能力表** | 插件实机探测 → 写 `queue-root/capabilities-<lrver>.json`；写事务只接受探测过的参数 | 未探测参数 → 写事务整单拒绝（`UNPROBED_PARAMETER`） |
| 2 | **假设登记簿** | `docs/ASSUMPTIONS.md`：每条 SDK 假设一行（内容 / 状态 unverified→probed / 证据链接）；mock 中每个范围必须能对应登记条目 | 契约测试：mock 范围无登记条目或状态非 probed → 测试失败 |
| 3 | **fail-closed 门禁** | doctor：完整性、版本白名单在写阶段为硬检查；verify-stages：阶段标签必须匹配已存在的实机证据文件 | 缺证据 → 拒发报告、`ok:false`；软检查必须显式列出 |
| 4 | **对抗测试** | 每个安全机制至少一条"机制自身失败"的测试（隔离失败、回滚验证失败、doctor 失败、证据缺失） | 测试清单评审时逐条勾选 |
| 5 | **复用审计清单** | `docs/REUSE_AUDIT.md`：复用代码必须逐条映射治理方案的条款到代码行，偏离必须显式登记 | 无审计记录 → 不得声明阶段完成 |
| 6 | **变更纪律** | `scripts/release-plugin.mjs`：重发校验和 + 断言插件副本==母本；插件文件变更后必须跑它 + verify-stages | 契约测试断言副本==母本（已有），release 脚本作为标准动作写入 README |

---

## 3. 具体修改方案

### P0-1 修复：隔离失败堵死队列（问题 5）

**文件**：`FileQueueBridge.lrplugin/QueueTransport.lua` 的 `moveToFailed`

1. 隔离目标名加唯一后缀：`<原名>-<os.time()>-<序号>.json`，杜绝 `next.json` 撞名。
2. 移动采用与 `publishFile` 相同的 exists→delete→move 次序（当前缺失）。
3. **终极兜底**：改名仍失败时，读取坏文件内容写入 sidecar（内容内联保存）后
   直接删除 `inbox/next.json`——**丢一个坏请求永远比堵死单槽队列安全**。
   任何路径都不允许 `next.json` 留在 inbox 返回。
4. 同步修正 JS 假插件：新增 `failQuarantineMove` 故障模式（当前它比 Lua 宽容，
   掩盖了真实现的缺陷）。

**新增测试**：
- `moveToFailed` 目标撞名 → 队列继续处理下一个请求（槽位自愈）。
- 隔离持续失败 → `next.json` 被兜底清除，心跳保持，后续正常请求成功。

**通过标准**：任意坏请求序列之后，`next.json` 不滞留 inbox 超过一个轮询周期。

### P0-2 修复：回滚假成功（问题 2）

**文件**：`BridgeCore.lua` 的 `restoreTransaction`（v1 §8 原文要求，本次补齐）

固定顺序改造：

```text
applyDevelopSnapshot / 降级 applyDevelopSettings(before)
→ photo:getDevelopSettings() 全量回读
→ 与 transaction.before_settings 规范化比对（复用基线摘要同源函数）
→ 一致 → ROLLED_BACK
→ 不一致 → 新状态 ROLLBACK_VERIFICATION_FAILED（终态，带 diff 摘要）
```

- 降级路径显式化：`rollback_method = "full_develop_settings_fallback"` 且
  `degraded = true` 返回给调用方；降级后同样必须过回读验证。
- 只凭"API 未抛异常"判成功的路径全部删除。

**新增测试**：快照恢复后关键字段仍偏移（mock 注入）→ 必须报
`ROLLBACK_VERIFICATION_FAILED`，不得出现 `restored:true`。

### P0-3 修复：快照保障 + 事务持久化（问题 3、4）

**文件**：`BridgeCore.lua`、`QueueTransport.lua`、Node 侧 `grade-session.mjs`

1. **写前快照解析**：`createDevelopSnapshot` 成功后按名回查 `snapshotID`
   （现有 `getDevelopSnapshots` 查找逻辑保留）；**ID 解析失败 → 拒绝写入**
   （`SNAPSHOT_UNRESOLVED`），落实 v1 阶段 4"快照失败必须拒绝"。
2. **事务落盘**：新建 `queue-root/transactions/<transaction_id>.json`，内容：
   `transaction_id / target 三元组 / before_settings / snapshot_id+name /
   state / applied_at / rolled_back_at / rollback_method`。
   状态迁移（APPLIED→VERIFIED / ROLLED_BACK / ROLLBACK_VERIFICATION_FAILED）
   时原子重写该文件。
3. **插件重启恢复**：`Queue.start()` 时加载 `transactions/` 目录到内存；
   APPLIED 状态的事务重启后标记 `recovered=true`，rollback 前强制先 readback
   确认现场，**绝不自动回滚**。
4. **GradeSession 持久化**：apply 响应中的 `transaction_id / snapshot_id`
   由 Node 合并回 `grading_sessions/<会话>/grade_session.json`，会话跨重启可续。

**新增测试**：应用 → 模拟插件重启 → readback → rollback 全链路跨重启可用；
重启后直接 rollback（未 readback）被拒绝。

### P0-4 修复：完整性硬门禁（问题 6）

**文件**：`environment-doctor.mjs`、新增 `scripts/release-plugin.mjs`

1. doctor 硬检查加入 `plugin_integrity`（checksums.txt 存在且全部匹配，否则
   `ok:false`）；`lr_version_whitelist` 在存在写阶段会话（`--require-write` 或
   session.json 的 `stage >= M3`）时升级为硬检查。
2. 报告增加 `soft_checks` 列表：所有非硬检查显式列出，杜绝"软失败藏在 ok 里"。
3. `release-plugin.mjs`：校验插件内 `BridgeCore/Json/ParameterCatalog` 与母本
   字节一致 → 重新生成 `checksums.txt` → 提示重跑 verify-stages。
   任何插件代码修改后的标准动作（写入 README 与验收清单第 0 节）。

**通过标准**：篡改任一插件文件后，doctor 返回 `ok:false` 且 `plugin_integrity=false`。

### P0-5 修复：阶段报告绑定证据（问题 7）

**文件**：`verify-stages.mjs`、新增 `scripts/live-evidence.mjs`

1. verify-stages 的 `--stage` 只接受 M1~M4，且**每个标签对应必须存在的证据**：
   - M1：模拟测试 + 假插件端到端（现状）；
   - M2/M3/M4：必须存在 `artifacts/live-evidence/<阶段>.json`（由 live-evidence
     生成），否则拒绝输出该阶段报告并以错误退出。
2. 报告新增字段：`simulated_only: true/false`、`evidence_sources: [...]`、
   每项证据的 SHA-256。
3. `live-evidence.mjs`：引导式实机取证——通过 bridge-cli 对真实插件逐项执行
   清单检查项，结果 + 时间戳 + 环境快照写入证据文件。**模拟链路永远无法生成
   实机证据文件**（文件头带 `source: "live"`，verify-stages 校验其来源字段）。

**通过标准**：无实机证据时尝试 `--stage M3` → 报错退出，不产生 M3 报告。

### P1-1 修复：Temperature 单一语义（问题 1）

**文件**：`ParameterCatalog.lua`、`BridgeCore.lua`、`test/mock-lightroom.mjs`

1. **一参一引擎**：目录为每个参数声明唯一 `engine`，契约测试禁止混用。
   `temperature / tint` 改为 `engine = "develop_settings"`——直接以开尔文/
   绝对值走 `applyDevelopSettings` 批量路径，回读同单位比对，
   **彻底绕开控制器归一化（−100~100）与 RAW 对数特性的换算陷阱**；
   控制器路径保留给本身就是归一化的滑杆参数。
2. **探测回写**（配合 §2 机制 1）：`capabilities()` 实机探测每个参数的
   getRange/当前值，写入 `queue-root/capabilities-<lrver>.json`；
   `apply_transaction` 预检阶段拒绝任何不在探测表中的参数
   （`UNPROBED_PARAMETER`）。
3. **mock 退休**：mock-lightroom 的手写范围表降级为"无探测表时的显式模拟模式"，
   测试必须显式声明 `SIMULATED_RANGES=1` 才允许使用；有探测表时 mock 加载探测表。
   手写表与 `docs/ASSUMPTIONS.md` 登记条目一一对应（§2 机制 2）。

**通过标准**：实机 RAW 照片上 temperature 目标 3807 → 应用 → 回读 3807（容差内），
不再出现夹取到 100 的 READBACK_MISMATCH。

### P1-2：GradSession 会话收口

当前多个测试会话停留在 APPLIED。P0-3 落地后：对每个 APPLIED 会话执行
readback → 与 before_settings 比对 → 明确置为 VERIFIED 或人工授权后 rollback，
不允许长期悬置。

---

## 4. 实施顺序与总验收

```text
第 1 批（P0，互相独立可并行）：
  P0-1 队列自愈 → P0-4 完整性硬门禁 → P0-5 证据绑定
  （先修"防再发"，保证后续修复过程本身不再带病推进）
第 2 批：P0-2 回滚真验证 + P0-3 快照/事务持久化（动 BridgeCore，一次改完一次审计）
第 3 批（P1）：P1-1 温度语义 + 探测回写 → P1-2 会话收口
每批收尾：release-plugin.mjs 重发校验和 → npm test 全绿 → verify-stages 按当前
真实阶段出报告（不许越级）→ 实机清单对应小节重跑。
```

**总验收标准**（全部满足才算修复完成）：

1. 7 项问题各有对应回归测试，且每条安全机制至少一条"机制自身失败"的对抗测试。
2. doctor 与 verify-stages 在缺证据/代码漂移时 fail-closed。
3. 探测表成为参数范围唯一事实来源，mock 手写表被显式降级。
4. `docs/REUSE_AUDIT.md`、`docs/ASSUMPTIONS.md` 建立并回填完成。
5. 实机按 `LIVE_VALIDATION_CHECKLIST.md` 重跑 M1 → M2 → M3，温度事务在 RAW
   上回读一致，回滚后基线摘要与写入前完全一致。

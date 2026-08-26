# Lightroom Bridge 失败账本

> 新失败必须先取证、登记，再修改。历史回填条目缺少当时日志尾部的，明确标为
> `evidence_gap`，不得把回忆包装成完整证据。

## 状态汇总

| ID | 问题 | 状态 | 是否计入同问题连续失败 |
|---|---|---|---|
| F-20260822-01 | GradeSession 恢复字段被 Node 白名单剥离 | resolved | 否 |
| F-20260822-02 | 未知 Lightroom 版本通过写硬门禁 | resolved_offline | 否 |
| F-20260822-03 | Library 中快照回滚 API 返回但未恢复 | resolved_live | 否 |
| F-20260822-04 | apply 响应持久化了应用前摘要而非应用后摘要 | resolved_live | 否 |
| F-20260822-05 | 恢复事务的最小 desired 覆盖已审阅 GradeSession intent | resolved_live | 否 |
| F-20260822-06 | 模拟 M1 报告误标为 M4 | resolved_offline | 否；治理缺口 |
| F-20260822-07 | Codex 沙箱拒绝读取实机队列目录 | resolved_environment | 否；执行环境权限 |
| F-20260822-08 | 运行中 Reload 孤儿化旧桥，M1/M2 双任务争用队列 | resolved_live | 否；首次诊断 |
| F-20260823-09 | capabilities 将“可读”误标成“可写支持” | resolved_live | 否；Core33 33/33 已实机探测 |
| F-20260823-10 | 候选配方与 JPG Core33 发布范围不一致 | resolved_offline | 否；候选与三层硬门已完成，实机预览待重做 |
| F-20260823-11 | Core33 首轮探测超时且写后/恢复后观察未等待稳定 | resolved_live | 否；修复后 33/33 与矩阵通过 |
| F-20260825-14 | M3 虚拟副本取证脚本持久化与恢复字段错误 | resolved_live | 否；验收脚本问题，照片均已恢复 |
| F-20260825-15 | M4 入口预检发现发布插件换行符漂移 | resolved_offline | 否；非功能性字节漂移 |

## F-20260822-01 — 跨重启恢复字段丢失

- 预期：重启后 rollback 通过 snapshot journal 恢复。
- 实际：Node `normalizeTransactionReference` 仅保留 transaction/target/current digest，Lua 返回 `TRANSACTION_NOT_FOUND`。
- 诊断层：Node GradeSession → MCP/Lua 接缝。
- 修复：透传 snapshot ID/name、pre digest、compiled parameters、settings summary；增加 Node/Python 接缝测试。
- 验证：Node 65/65；最终 GradeSession 的 `history.recovered_from_grade_session=true`。
- evidence_gap：修复前 bridge/node 日志尾部未按新制度留档。

## F-20260822-02 — 未知版本硬门禁放行

- 预期：写模式读不到 LR 版本必须失败。
- 实际：旧逻辑 `actual === null` 时 accepted=true。
- 诊断层：environment doctor / version policy。
- 修复：`evaluateLrVersion(null|undefined|blank)` 返回 `known=false, accepted=false`。
- 验证：版本策略单测通过；尚未对实机版本读取失败做故障注入，故状态为 `resolved_offline`。
- evidence_gap：无对应实机失败日志。

## F-20260822-03 — Library 模块快照恢复无效

- 预期：snapshot ID 恢复应用前摘要。
- 实际：首次跨重启 rollback 返回 `ROLLBACK_FAILED`；diff 为 `Clarity2012 / Contrast2012 / Vibrance`。
- 诊断层：Lightroom SDK 模块前置条件。
- 修复：`rollback()` 首行强制 `ensureDevelopModule()`。
- 验证：事务 `AB27F4F5-...` 跨重启直接回滚，`method=develop_snapshot`、`digest_verified=true`。
- 证据：`grading_sessions/DSC_4458_restart_rollback_m3_final/grade_session.json`。
- evidence_gap：当时 AppData 日志尾部未复制进仓库工件。

## F-20260822-04 — 应用后摘要记录错误

- 预期：rollback expected-current 等于应用后的稳定摘要。
- 实际：首次请求用应用前 `d2c093...` 对比实际应用后 `71d996...`，安全返回 `BASELINE_CHANGED`。
- 诊断层：Lua apply readback 发布时序 + Python transaction reference 优先级。
- 修复：`waitForAppliedDigest`；execution patch 新增 `applied_edit_digest`；Python 优先使用该字段。
- 验证：最终事务应用前 `e188246...`、应用后 `167bce4...`；重启后仍为 `167bce4...`，rollback 成功。
- 证据：最终 GradeSession。

## F-20260822-05 — 回滚合并破坏会话 intent

- 预期：ROLLED_BACK 只追加恢复结果，保留用户审阅的完整 desired。
- 实际：恢复事务仅携带 compiled parameters，merge 后触发 `execution.desired does not match selection`。
- 诊断层：Python execution_patch merge。
- 修复：ROLLED_BACK patch 不覆盖 `desired/applied`；增加 Python 回归测试。
- 验证：Python 35/35；最终会话 `valid=true, state=ROLLED_BACK`。

## F-20260822-06 — 伪 M4 阶段证据

- 预期：M4 只能由完整实机证据解锁。
- 实际：`verify-M4-2026-08-21T11-49-31-370Z` 只有 M1 fake-plugin 100 ping，却标记 stage=M4。
- 诊断层：阶段报告标签未绑定证据。
- 已处理：原目录移至 `artifacts/_invalid/`，保留历史但排除一级证据扫描；当前 verify 脚本拒绝非 M1。
- 修复：新增 `live-evidence.mjs`，要求真实插件只读探针、完整清单、时间戳与附件摘要；
  `verify-stages.mjs` 复核来源、阶段、附件/观察清单 SHA-256、前序实机报告，拒绝
  `_invalid` 和非 M1 缺证据运行。报告显式写入 `simulated_only/evidence_sources`。
- 验证：Node 证据链契约测试全绿；`verify-stages --stage M3` 在缺少
  `artifacts/live-evidence/M3.json` 时退出 1，且未创建 M3 报告。
- 状态：`resolved_offline`。机制缺口已关闭；M1/M2/M3 的新实机证据尚未采集，
  因此认证阶段仍为 M?。

## F-20260822-07 — 实机取证命令被沙箱拒绝

- 预期：M1 插件启动后，doctor、bridge-cli 与心跳采样读取 `%APPDATA%` 队列。
- 实际：Lightroom 弹窗已确认 `Stage: M1 / State: running`，但命令侧对队列目录的
  mkdir/read 均返回 `EPERM`；doctor 仅 `queue_writable=false`，其余硬检查通过。
- 环境：LR 正在运行、插件已 Reload 并手动 Start；因沙箱拒绝读取，session、heartbeat、
  inbox/processing/outbox/failed 与两份日志内容本轮首次调用无法取证。
- 已尝试：doctor、ping/capabilities/status、20 ping、6 秒 heartbeat 采样；均未重试写操作。
- 诊断层：Codex workspace sandbox 不包含 `%APPDATA%`，不是插件协议或 Lightroom SDK 失败。
- 下一步：以受控提权重跑相同只读/队列检查；不修改代码。
- 结果：受控授权后 doctor `ok:true`，实机 ping/capabilities/status、20/20 ping 与
  6 秒心跳采样全部通过；确认根因仅为首轮沙箱权限，状态关闭。

## F-20260822-08 — 运行中 Reload 后 M1/M2 双桥争用

- 预期：Lightroom 完全重启并 Start 后只存在一个 M2 桥；ping、capabilities、status
  应连续成功且 session/heartbeat 均声明 M2。
- 实际：M2 ping 首次成功；紧随其后的 capabilities/status 均返回
  `BRIDGE_UNAVAILABLE`。诊断时 `session.json.stage=M2`，但持续更新的
  `heartbeat.json.stage=M1`；旧 M1 与新 M2 任务同时轮询同一单槽队列。
- 环境：Lightroom PID 9812，进程响应正常；插件 session 为 M2，启用方法包含
  `get_target_photo/get_settings/get_proxy`；heartbeat 为 M1。`inbox/processing/outbox`
  未发现可作为正常完成响应的条目，失败目录新增认证隔离记录。
- `bridge.log` 尾部关键事实：
  - `bridge_started stage=M2 ts=1787408377`；
  - 后续 `bridge_stopped ts=1787409274`、再次 `bridge_started stage=M2 ts=1787409278`；
  - M2 ping 于 `ts=1787409349` 成功；
  - capabilities/status 请求随后分别被隔离为 `AUTHENTICATION_FAILED`，文件为
    `1787409370-...next.json`、`1787409379-...next.json`。
- `node-bridge.log` 尾部关键事实：M2 ping request completed；capabilities/status 只有
  request_sent，没有完成记录。
- 已尝试：只读 ping/capabilities/status；故障出现后未重试业务请求、未执行写操作；
  收集进程、session、heartbeat、队列目录与两份日志尾部。
- 诊断层：Lua 插件生命周期。`QueueTransport.lua` 的 `Queue.running` 是模块局部状态，
  poll/heartbeat 异步任务闭包持有旧 Queue；运行中 Reload 创建新模块状态后，Stop
  无法可靠控制旧任务，新 Start 因而产生第二个桥。两个任务使用不同 session token，
  旧任务会抢取并隔离新任务请求。
- 修复：以 `session.json.token` 作为跨模块唯一所有权；poll 在观察/认领单槽前、
  heartbeat 在发布前均重验所有权，失权循环记录 `bridge_superseded` 后退出。Stop 即使
  当前模块 `running=false` 也删除公共 session/heartbeat，使 Reload 后的新模块能够
  停止旧模块。操作手册同时硬化为 Stop 经 ping 确认后才允许 Reload。
- 验证：静态 Reload 所有权契约测试 9/9，完整 Node 测试 73/73；完全退出 Lightroom
  清除故障现场并加载修复版后，M2 ping/capabilities/status 连续成功，session 与
  heartbeat 均为 M2，status `failed_requests=0`，日志只出现新 M2 请求完成记录，未再
  新增 `AUTHENTICATION_FAILED`。状态关闭。

## F-20260823-09 — 可读能力被误标为可写支持

- 预期：只有完成“写入 → 回读 → 回滚 → 全量摘要恢复”的实机参数才可进入写事务。
- 实际：`BridgeCore.probeParameter()` 只要 `LrDevelopController.getRange/getValue`
  成功，就返回 `status="supported"`；它证明的是可读性，不是可写性。
- 影响：除已做过历史实机事务的少量参数外，其余参数可能在单位、量化、关联字段、
  格式或回滚上失败，却仍被写预检放行。
- 诊断层：Lua capability model + Node/Python 缺少发布范围与实机证据门禁。
- 用户决策：2026-08-23 明确降级为 Lightroom 15.0.1 / Windows 11 / JPG Core33，
  并明确授权执行 `JPG_CORE33_M3_EXECUTION_PLAN.md`。
- 修复要求：建立唯一 scope；区分 readable/write_probed；未探测参数整单拒绝；
  自动生成逐参数实机证据。
- 已实现：唯一 Core33 scope、Lua/Node/Python 三层范围门、`read_status/write_status`
  分离、`UNPROBED_PARAMETER`、自动 `probe_core33_jpg`、持久能力表加载、专用 JPG
  测试图。Node 74/74、Python 35/35，发布校验通过。
- 实机现状：2026-08-23 `doctor --live` 返回 `PLUGIN_NOT_RUNNING`；未执行任何写入，
  33 项仍不得标记为 `write_probed`。
- 验收配置：`Config.stage=M3` 仅用于加载受限探测入口；正式认证仍是 M2。没有当前构建
  33/33 能力表时，普通 `apply_transaction` 由 `UNPROBED_PARAMETER` 整单拒绝。
- 实机关闭证据：`capabilities-lr15.0.1-jpg-core33.json` 为 33/33 `write_probed`，
  基线恢复；精确 1/5/25 与越界原子拒绝矩阵全部通过。
- 状态：`resolved_live`。

## F-20260823-10 — 候选配方超出 JPG Core33

- 预期：本版本 Native、Amplify、Break 只能生成用户批准的 33 个参数。
- 实际：当前配方仍包含 Vibrance、Color Grading、Grain、Blue Primary，并在离线预览
  使用 Temperature、duotone、channel matrix 等无法由 Core33 等价执行的操作。
- 影响：用户审阅的预览与最终 Lightroom 写入范围可能不一致；旧 GradeSession 也可能
  携带范围外配方继续申请写入。
- 诊断层：Python candidate compiler / preview renderer / GradeSession validation。
- 修复要求：候选重写为 Core33；scope ID/digest 写入会话；旧预览和选择失效；
  Python、Node、Lua 三层拒绝范围外参数。
- 已实现：Native/Amplify/Break 已重写为稀疏 Core33；离线预览只使用曝光、对比、
  质感、黑位和与同一 HSL 配方绑定的 mixer 操作；GradeSession 写入 scope id/digest；
  旧 scope、非 JPG、Tint/曲线等范围外参数均在 Node/Python/Lua 写前拒绝。
- 验证：Node 74/74、Python 35/35；旧 25 参数/DNG 夹具已替换为 JPG Core33。
- 状态：`resolved_offline`。真实 JPG 的三方案预览和应用属于后续实机 P6，不把离线
  结果表述为 Lightroom 实机通过。

## F-20260823-11 — Core33 首轮实机探测超时与观察时序错误

- 预期：`probe-core33-jpg.mjs` 等待插件完成；每项正写和反写后等待 controller 与完整
  develop settings 稳定，再比较字段；33 项分别恢复，最终生成能力表。
- 实际：插件用 33 秒完成并返回 `ok:true`，Node 固定 30 秒先报 `BRIDGE_TIMEOUT`，没有
  生成正式能力表。孤儿响应中 33 项全部被标为 `unsupported`：正向 diff 经常带入之前
  参数的负值，负向 diff 经常为 0，说明快照摘要恢复后 controller/develop settings
  发布尚未稳定就进入下一阶段，而不是证明 33 个参数全部不可写。
- 安全结果：孤儿响应的 `baseline_edit_digest` 与 `final_edit_digest` 均为
  `e0803726ebe9da27d12fc492ba29ea24f2e080590e64c4cc10b0ea108fdb82b8`；测试图最终完整
  基线已恢复。0/33 被升级为 `write_probed`，普通写事务仍 fail-closed。
- 实机环境：Lightroom 15.0.1 build `202511041508-dddee541`，Develop 模块；插件
  `0.3.0-core33-probe.3`，stage 配置 M3 验收态；目标
  `core33-test-chart.jpg`，photo_id `612388`，JPG 1800×1200；scope
  `jpg-core33-v1` / `69a976dc...a94545a`。
- 队列现场：`session.json` 与心跳存在；请求从 inbox 被认领，processing 最终为空；
  outbox 留下 `5065b799-03dd-41b4-9a79-0265cb366f48.json`（74,878 bytes）；failed
  没有本次新增原因文件。
- `node-bridge.log` 尾部：`03:59:14.712Z request_sent probe_core33_jpg`；
  `03:59:44.769Z request_failed code=BRIDGE_TIMEOUT`。
- `bridge.log` 尾部：同一 request_id 的 `probe_core33_jpg ok=true duration_seconds=33`。
- 已尝试：只执行一次自动探测；失败后未重试、未修改代码；孤儿响应已复制到
  `artifacts/core33/failed-probe-2026-08-23-timeout-response.json`。
- 诊断层：两处独立实现缺口：Node 探测专用超时不足；Lua 只等待快照摘要恢复，没有在
  每次 setValue 和 restore 后同时等待 controller 值与 develop settings 摘要稳定。
- 拟议最小修复：探测 runner 使用显式长超时；Lua 每个阶段加入有界稳定等待并在稳定后
  重新抓取 baseline settings，之后再比较正/反向字段集合。不得放宽字段一致性规则。
- 修复与实机复验：探测稳定等待及专用长超时已生效，33/33 参数完成正写、反写、回读与
  逐项恢复；后续 1/5/25/33 参数事务矩阵均恢复到同一基线摘要。
- 状态：`resolved_live`。

## F-20260825-14 — M3 虚拟副本取证脚本持久化与恢复字段错误

- 预期：虚拟副本应用后保存事务与代理；同配方应用母片、像素比较，并回滚两者。
- 实际一：代理目标目录未预先创建，`copyFile` 返回 `ENOENT`；应用与 readback 已成功，
  但本地证据尚未写盘。通过只读 Lightroom 快照表定位最新事务，未重复应用地恢复证据。
- 实际二：母片与副本 JPEG 字节摘要不同，旧断言提前退出。解码后两图 1800×1200 RGB
  逐通道差异为 0，证明差异来自 JPEG 容器/元数据而非画面；改为像素级比较。
- 实际三：等待用户操作期间桥被重新启动，事务内存丢失；验收脚本恢复回滚时漏传
  `pre_transaction_edit_digest`，快照实际恢复到 `645bbd...0f36`，但桥用应用后摘要作为
  预期值而返回 `ROLLBACK_FAILED`。只读复核确认照片已恢复。
- 修复：代理导出前创建目录；持久化 snapshot name；回滚恢复请求显式传递
  `pre_transaction_edit_digest / compiled_parameters`；写前摘要从固定 target 读取；
  字节摘要只作容器诊断，正式外观比较使用解码 RGB 像素。
- 验证：追加虚拟副本短事务 `apply -> readback -> rollback` 获得明确成功响应；母片和副本
  最终摘要均为 `645bbd625cc4d169b6990ac7b457403e7febc4b3c78bf0ce8fe89e71b0d00f36`；
  `artifacts/core33/m3-virtual-copy-acceptance/evidence.json` 为 `complete:true`。
- 状态：`resolved_live`。这是验收脚本缺陷，不是插件写入或照片恢复失败。

## F-20260823-12 — DONE 会话实际回滚后无法合并回滚证据

- 预期：任何已经创建事务快照且尚未回滚的 GradeSession，都可以在最终 `DONE` 后执行
  回滚，并把桥返回的 `ROLLED_BACK` 合并进会话。
- 实际：Lightroom 桥已经恢复快照并把编辑摘要从
  `88f82ee31c0c8cd7c9e320e11326bb03a096aabd79352c0d4e870b780285131f`
  恢复为应用前的
  `645bbd625cc4d169b6990ac7b457403e7febc4b3c78bf0ce8fe89e71b0d00f36`，但 Python
  `_merge_execution_patch()` 没有允许 `DONE -> ROLLED_BACK`，因此首次命令返回
  `SessionValidationError`，本地 GradeSession 暂时仍停在 `DONE`。
- 安全结果：只读重新获取当前目标，确认 photo_id `612388`、source digest 与原目标
  一致，当前编辑摘要精确等于事务前摘要；没有重复修改照片。
- 根因：CLI patch 合并白名单、引擎状态推进表和历史校验表都遗漏了
  `DONE -> ROLLED_BACK`，与“快照创建后可回滚”的会话契约不一致。
- 修复：三处状态表统一加入 `DONE -> ROLLED_BACK`；增加完成态回滚合并回归测试。
- 验证：Python 39/39；利用桥的幂等回滚响应重新合并事务
  `1DD8813C-9A77-424C-89D8-FA7147863F28`，GradeSession 最终
  `valid=true / state=ROLLED_BACK / warnings=[]`，Lightroom 当前摘要仍等于事务前摘要。
- 状态：`resolved_live`。

## F-20260823-13 — 明亮真实照片的 Amplify 过曝与候选方向不一致

- 预期：候选参数由当前照片亮度和高光余量决定；候选文字、QC 目标与实际配方方向一致。
- 实际一：`DSC_0071.JPG` 首轮 Amplify 118% 仍固定增加 Exposure，离线预览高光裁切约
  25%，被 `preview_accidental_clipping` 正确阻止选择。
- 实际二：去掉机械加曝光并加入 Highlights/Whites 保护后，配方目标已经变成“压高光、
  增强层次、保持整体亮度”，但候选级方向仍继承全局“变亮”，被
  `preview_intent_mismatch` 再次阻止选择。
- 安全结果：v1、v2 都停在 PREVIEWED，均写入 `INVALIDATION.md`，没有修改 Lightroom。
- 根因：候选生成器用固定 Exposure 增量处理所有明亮语义；Native、Amplify、Break 共用
  一个 tone direction，不能表达不同路线各自的明暗目标。
- 修复：根据 PhotoDNA `tone.mean / p95` 计算曝光余量；明亮场景的 Amplify 不再增加
  Exposure，自动加入 Highlights/Whites 保护；每个候选持久化独立
  `route_tone_direction`，高光保护 Amplify 使用中性亮度目标，Break 使用压暗重构目标。
- 验证：Python 41/41；v3 三候选预览 `warnings=[]`；Amplify 118% 在真实 JPG 上原子写入
  9 项，正式读回 9/9 一致；整体和船上人物前后对比通过；GradeSession
  `valid=true / state=DONE / warnings=[]`。事务
  `B2631474-8E29-497F-A030-C4E14B2F7165`。
- 状态：`resolved_live`。

## F-20260825-15 — M4 入口预检发现发布插件换行符漂移

- 预期：M3 认证后的发布插件应继续与 `checksums.txt` 逐字节一致，M4 入口
  `environment-doctor` 应返回 `plugin_integrity=true`。
- 实际：2026-08-25 19:51:47，先前被用户中断的 Temperature 探针补丁没有留下任何
  功能代码或版本变化，但把 `Info.lua`、`Config.lua`、`BridgeCore.lua` 的 LF 换行机械
  改成 CRLF；19:37 生成的 M3 清单因此报告三项 digest mismatch。
- 完整性诊断：当前三文件按 LF 规范化后的 SHA-256 分别为
  `1c750ed8...7d159`、`3bb7de5a...20f78`、`621d2ade...d332b`，与
  `checksums.txt` 三项完全一致；`Config.stage=M3`、插件版本
  `0.3.0-core33-probe.7`、BridgeCore 功能文本均未改变。
- 实机现场：Lightroom 15.0.1 正在运行；`session.json`、心跳存在；`ping/status` 成功；
  inbox/processing/outbox 均为 0；failed 中只有 10 个历史故障注入/探测文件；最近 24 小时
  Windows Lightroom 崩溃/错误事件为 0。
- `bridge.log` 尾部：M3 取证最后三项 `ping/capabilities/status` 均 `ok=true`；此后没有
  写事务；桥仍为 stage M3。`node-bridge.log` 尾部对应三次请求均成功。
- 沙箱说明：首次队列探针因 Codex 文件权限返回 EPERM；经用户批准的只读诊断在沙箱外
  成功，证明这不是 Lightroom、插件或队列 ACL 故障。
- 已尝试：只读哈希、换行统计、内存中 LF 规范化哈希、实机只读 ping/status；尚未修改
  插件、校验和或照片。
- 诊断层：工作区字节格式；根因是被中断补丁的换行重写，不是运行时代码缺陷。
- 拟议最小修复：只把上述三文件 CRLF 恢复为 LF，保持既有
  `checksums.txt` 不变；随后重跑 doctor、完整 Node/Python 测试及 M3 证书摘要复核。
- 修复：用户明确回复“可以修改”后，将发布插件 `Info.lua / Config.lua / BridgeCore.lua`
  与母本 `BridgeCore.lua` 统一恢复为 LF；运行 `release-plugin.mjs`，清单内容与 M3
  认证时保持一致，构建号未变化。
- 验证：Node 81/81、Python 43/43；母本==副本契约通过；`environment-doctor`
  `ok=true / plugin_integrity=true / mismatches=[]`；最近 24 小时 Lightroom 错误事件仍为 0。
- 状态：`resolved_offline`。这是精确恢复已认证字节，不新增或改变运行能力；M4 可继续。

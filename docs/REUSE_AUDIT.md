# BridgeCore 复用条款审计

> 审计对象：`lightroom-bridge/plugin/LrCreativeGradingBridge.lrplugin/BridgeCore.lua`
> 受控副本：`lightroom-file-polling-bridge/plugin/FileQueueBridge.lrplugin/BridgeCore.lua`
> 本表是改动 BridgeCore 前置工件；偏离不得隐含处理。

| 条款 / 风险 | 代码位置 | 当前结论 | 偏离或待办 |
|---|---|---|---|
| 目标身份与 baseline 写前双重校验 | `BridgeCore.lua:194 assertTarget`；`:209` baseline 比对 | 已实现 | 无 |
| 写前创建唯一快照并解析 snapshot ID | `BridgeCore.lua:738 createSnapshot` | 已实现 | 需在虚拟副本上实机验证 |
| 回滚不能只凭 API 未抛错判成功 | `BridgeCore.lua:851 restoreTransaction`；`:819 waitForBaselineDigest` | 已实现摘要严格验证 | 完整摘要规范化风险仍按 `ASSUMPTIONS SDK-003` 跟踪 |
| 回滚失败应给字段级诊断 | `BridgeCore.lua:96 diffSettingsSummaries`；`restoreTransaction` 的 top-20 details | 已实现并在首轮失败中实机触发 | 表值仅给 digest/count，不展开敏感或超大结构 |
| rollback 必须在 Develop 执行 | `BridgeCore.lua:1271 rollback` 调用 `ensureDevelopModule()` | 已实现、实机证明 | 该要求来自 SDK 行为，已登记 `SDK-001` |
| 应用后摘要必须在 Lightroom 发布后持久化 | `BridgeCore.lua:828 waitForAppliedDigest`；apply 响应 `applied_edit_digest` | 已实现、跨重启一致 | 只覆盖已观察最长 2 秒发布窗口 |
| 跨重启恢复字段不得被 Node 剥离 | `grade-session.mjs:481 normalizeTransactionReference`；Python `_transaction_reference` | 已实现并有接缝测试 | 新增恢复字段时必须同步 MCP schema 与测试 |
| 跨重启事务持久化 | GradeSession 持久化 snapshot/pre/applied/compiled/summary；`BridgeCore.lua:1184 transactionFromParams` 重建 | 有意采用 GradeSession journal | **偏离 REMEDIATION P0-3 的 queue-root/transactions 方案**；当前不会把完整 `before_settings` 落队列盘，需用户决定是否回归原方案 |
| 部分应用失败必须自动回滚 | applyTransaction 的 failure 分支 → `restoreTransaction(..., true)` | 已实现 | 中途强退 Lightroom 尚未实机验证 |
| 坏请求隔离失败不能堵死单槽队列 | `QueueTransport.lua:150 moveToFailed` | 已实现防御与删除降级；有静态/模拟测试 | 仍缺实机非法 JSON 与隔离失败取证 |
| 插件副本必须与母本字节一致 | `scripts/release-plugin.mjs`；契约测试 `reused BridgeCore...` | 已实现变更闸 | 每次插件变更后必须先运行 release，再跑测试和阶段验证 |
| Lightroom 版本未知必须 fail-closed | `version-policy.mjs:9 evaluateLrVersion`；environment doctor hard checks | 已实现并有单测 | 未知版本实机故障注入未做 |
| 参数能力必须来自实机探测表 | 当前 capabilities 运行时探测；无持久探测表硬门禁 | 未完成 | REMEDIATION P1-1；完成前不能声明完整 M3，Temperature 保持禁写 |
| 阶段标签必须绑定 live evidence | `live-evidence.mjs` 取证；`verify-stages.mjs` 校验摘要、完整清单、前序报告并排除 `_invalid` | 已完成（机制） | 实机证据尚待按 M1 → M2 → M3 重新采集，当前认证阶段仍为 M? |

## 改动前检查

- [ ] 本次条款与代码位置已登记；新增偏离有用户决定。
- [ ] `docs/FAILURE_LEDGER.md` 无触发熔断的连续失败。
- [ ] SDK 新假设已进入 `docs/ASSUMPTIONS.md`。
- [ ] 修改母本后同步受控副本。
- [ ] 运行 `node scripts/release-plugin.mjs`。
- [ ] `npm test` 全绿。
- [ ] 按当前认证阶段运行 `verify-stages`，不越级命名。
# JPG Core33 M3 变更审计（2026-08-23）

| 新方案条款 | 母本代码位置 | 受控副本 | 结论 |
|---|---|---|---|
| P2：仅 JPG、仅 Core33、scope 不匹配整单拒绝 | `BridgeCore.lua` 的 `validateTargetShape`、`assertTarget`、`buildPlan` | `FileQueueBridge.lrplugin/BridgeCore.lua` | 按方案实现；非 JPG、范围外、scope 不匹配均在首个写入前失败 |
| P2/P3：可读不等于可写 | `BridgeCore.lua` 的 `probeParameter`、`capabilities` | 同左受控副本 | `read_status` 与 `write_status` 分离；初始 33 项均为 `unprobed` |
| P3：未完成实机探测不得正常写 | `BridgeCore.lua` 的 `buildPlan` | 同左受控副本 | `UNPROBED_PARAMETER` fail-closed；探测专用入口仍待实现 |

偏离说明：本次登记晚于母本的第一轮最小修改，原因是执行顺序疏漏；已在同步受控副本、发布和实机动作之前补齐。该疏漏不作为放行依据。

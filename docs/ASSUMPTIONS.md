# Adobe SDK 假设登记簿

> 状态只允许 `unverified` 或 `probed`。Mock 与静态目录不能把假设升级为事实；
> `probed` 必须指向 Lightroom 实机证据。当前 Lightroom：15.0.1。

| ID | 假设 | 状态 | 适用范围 | 证据 / 后续动作 |
|---|---|---|---|---|
| SDK-001 | `photo:applyDevelopSnapshot(snapshotID)` 在 Develop 模块可恢复快照；Library 中调用可能返回但不生效 | probed | LR 15.0.1 / JPG | `grading_sessions/DSC_4458_restart_rollback_m3_final/grade_session.json`：`method=develop_snapshot`、`digest_verified=true`；BridgeCore `rollback()` 强制 `ensureDevelopModule()` |
| SDK-002 | 应用后完整开发设置摘要在正常 Lightroom 重启后保持一致，可作为 rollback 的 expected-current 门禁 | probed | LR 15.0.1 / DSC_4458.JPG / 4 参数事务 | 应用前持久化 `167bce4e...`，重启后 `get_target_photo` 同摘要；最终 GradeSession 记录成功回滚 |
| SDK-003 | 快照恢复后的完整开发设置可能在后续 Lightroom 重启时发生规范化，即使可见参数不变 | unverified | LR 15.0.1 / JPG | 首轮观察 `d2c093... -> e188246...`；需保存字段级 before/after 探测证据后才能归因于具体字段 |
| SDK-004 | Temperature/Tint 可沿用同一数值表示 | unverified | 历史范围；不属于 JPG Core33 | 2026-08-25 用户接受受限 M3；live write 继续禁用。只有创建新 scope 并分别完成 JPG/RAW 实测后才能恢复 |
| SDK-005 | Controller 数值存在参数专属量化，统一容差可安全外推到 Core33 | probed | LR 15.0.1 / JPG Core33 | `capabilities-lr15.0.1-jpg-core33.json` 逐项记录 33/33 写入、回读、容差与恢复 |
| SDK-006 | Mock 中的参数范围可以代表真实 Lightroom 能力 | unverified | 仅 SIMULATED 测试 | 禁止用于实机写门禁；必须由 `capabilities-<LR版本>.json` 替代。当前探测表工件尚未落地 |
| SDK-007 | 虚拟副本创建、快照、代理渲染与母片隔离行为满足最终预览闭环 | probed | LR 15.0.1 / JPG 虚拟副本 | `artifacts/core33/m3-virtual-copy-acceptance/evidence.json`：母片隔离、同配方回读、RGB 像素一致和双端恢复通过 |
| SDK-008 | Core33 在 LR 15.0.1 / JPG 上均可同事务写入、回读和回滚 | probed | JPG Core33 | 33/33 能力表、精确 1/5/25 与全 33 参数事务矩阵均通过并恢复同一基线摘要 |

## 登记规则

1. 新增或修改任何 SDK mock、范围、返回值或模块行为前先登记 ID。
2. `probed` 证据必须包含 LR 版本、介质类型、目标照片/副本、请求与结果路径。
3. 一个版本或介质上的 `probed` 不自动外推到其他版本、JPG、RAW 或 DNG。
4. 未探测参数在写模式下必须整单拒绝；禁止静默跳过或使用 mock 范围放行。

# M3 完成计划

> 当前认证阶段：M3。
> 正式报告：`artifacts/verify-M3-2026-08-25T11-37-33-767Z/report.json`，
> `ok:true / simulated_only:false / Node 81/81`。当前 `Config.stage=M3` 已与认证结论一致。

## 已取得但不足以放行 M3 的证据

- [x] `DSC_4458.JPG` 4 参数 Native 事务：应用成功。
- [x] 应用后摘要持久化，并在 Lightroom 完全重启后保持一致。
- [x] 重启后从 GradeSession 恢复事务，通过 snapshot ID 回滚。
- [x] rollback 自动进入 Develop；恢复后摘要严格等于写前摘要。
- [x] 回滚失败 details 可提供 top-20 字段差异。
- [x] Node 65/65、Python 35/35。

以上只证明一个 4 参数跨重启事务，不等于完整 M3。

## G0 — 证据与发布机制前置门禁

**链路语义决策：宽松递进模式。** 待认证阶段的 live-evidence 必须绑定取证时的
`plugin_build` 与 `checksums.txt` 摘要，插件漂移后必须重取该阶段；已认证的紧邻前序
证书只重新哈希其证据文件以防签发后替换，不重验当前插件绑定。因此阶段链允许跨
插件版本。选择该模式是因为 M1 → M2 → M3 必须修改已纳入校验和的 `Config.stage`；
严格同构建模式会使下一阶段永远无法接受上一阶段证书。该例外仅适用于已认证前序，
不得用旧证据认证当前阶段。

- [x] 隔离旧伪 M4 报告到 `artifacts/_invalid/`。
- [x] 建立 `scripts/release-plugin.mjs`。
- [x] 建立 `docs/FAILURE_LEDGER.md`。
- [x] 建立 `docs/REUSE_AUDIT.md`。
- [x] 建立 `docs/ASSUMPTIONS.md`。
- [x] 建立 `scripts/live-evidence.mjs`（只读实机探针；写路径只收集已有证据）。
- [x] `verify-stages.mjs` 输出 `simulated_only / evidence_sources` 及逐项 SHA-256，并校验 `_invalid` 永不参与阶段认证。
- [x] 重新生成可认证的 M1/M2 实机证据链；M3 报告已复核紧邻 M2 前序证书。

## G1 — 探测驱动参数门禁

- [x] 实机生成 `capabilities-lr15.0.1-jpg-core33.json`，Core33 33/33 `write_probed`。
- [x] 写事务只接受探测表中 `write_probed` 的参数。
- [x] 未探测参数返回 `UNPROBED_PARAMETER`，整单无写入。
- [x] Mock 范围仅在显式 simulated 模式使用，并映射 `ASSUMPTIONS` 条目。

## M3-A — 基础事务矩阵

- [x] 1 参数：应用 → readback → rollback → 原摘要。
- [x] 5 参数：应用 → readback → rollback，无 baseline 漂移。
- [x] 25 参数：仅使用探测表允许集，完成同一闭环。
- [x] 混入 unsupported 参数：整单拒绝、unsupported 明确、零部分应用。

证据：`artifacts/core33/transaction-matrix-m3-acceptance-lr15.0.1-jpg-core33.json`。

每次记录：LR 版本、目标 photo_id、pre/applied/rollback digest、snapshot ID、
参数 desired/applied/readback、日志与队列终态。

## M3-B — 虚拟副本预览闭环（核心）

- [x] 创建测试母片的虚拟副本并记录母片初始 digest。
- [x] 固定配方应用到虚拟副本；用户确认 `get_proxy` 与 Lightroom 显示一致。
- [x] 副本保持应用态期间母片 digest 全程不变。
- [x] 同一 recipe hash/strength 应用到母片。
- [x] 母片与虚拟副本 desired/readback 一致；两份代理解码后 RGB 像素差异为 0。
- [x] 连续 10 轮真实工作流到达终态：8 轮回滚，2 轮按用户决定有意保留 `DONE`；无意外活动会话。

证据：`artifacts/core33/m3-virtual-copy-acceptance/evidence.json`、
`artifacts/live-observations/M3-workflow-cycle-audit-2026-08-25.json`。

## M3-C — 崩溃与安全负向测试

- [x] 写入中途强制退出 Lightroom；重启后孤儿 processing 请求进入 failed/RECOVERY_UNKNOWN。
- [x] 确认照片没有被二次应用。
- [x] 应用后人工修改目标，再 rollback：返回 `BASELINE_CHANGED`，不得覆盖人工编辑。
- [ ] 快照不可解析/不可应用：写前拒绝或 `ROLLBACK_FAILED`，不得假成功。
- [ ] 非法 JSON 与隔离失败：单槽释放，心跳与后续请求继续。

## M3-D — 稳定性收尾

- [x] 空闲运行超过 60 分钟无问题（用户回顾性观察；按用户要求未重复启动 30 分钟采样）。
- [x] 10 次 Stop → Start 循环，由 `bridge.log` 机器计数验证。
- [x] 队列终态：inbox/processing/outbox 均为 0。
- [x] 生成 `artifacts/live-evidence/M3.json`。
- [x] `verify-stages --stage M3` 生成 `simulated_only:false` 报告。

稳定性证据：`artifacts/live-observations/M3-stability-and-queue-2026-08-25.json`。

## P1-1 — Temperature 单一语义（M4 前保留的发布限制）

- [ ] JPG：确认 baseline、范围、写入、readback、rollback 使用同一单位。
- [ ] RAW/DNG：确认 Temperature 对数/绝对语义与目标值回读。
- [x] 发布决策：不选择或混用 Controller / develop-settings；本版本继续禁写。
- [x] 整单预检：Temperature/Tint 不属于 `jpg-core33-v1`，请求时原子拒绝。
- [x] 保持 live write disabled，发布说明明确“无白平衡写控制”。

用户于 2026-08-25 明确选择“接受带此功能限制的 M3 发布”，RAW/JPG Temperature
表征推迟到未来新 scope，不阻塞受限 M3。机器可读决策：
`artifacts/live-observations/M4-temperature-release-decision-2026-08-25.json`。

## M3 放行条件

M3 已于 2026-08-25 认证。Temperature 继续保持禁写；用户已明确接受该限制，
`temperature_release_decision` 不再阻塞 M4。未来若恢复白平衡写控制，仍必须创建新 scope
并分别完成 JPG 与 RAW/DNG 实机表征，不得继承本次豁免。

后续状态：M4 已于 2026-08-25 通过正式实机证据认证；报告位于
`artifacts/verify-M4-2026-08-25T12-50-32-130Z/report.json`。

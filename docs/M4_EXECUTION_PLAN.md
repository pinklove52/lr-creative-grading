# M4 稳定化与部署收尾计划

## 当前状态

- 前序证书：M3 已认证，`simulated_only=false`。
- 运行时门控继续为 `M3`；M4 不新增 Lightroom 写方法或参数。
- 发布范围继续为 `jpg-core33-v1`（JPG、Core33）。
- Temperature/Tint 实时写入保持禁用，越界配方整单原子拒绝。
- M4 状态：已于 2026-08-25 正式认证，`simulated_only=false`。

## M4 认证检查

- [x] `m3_report_valid`：M3 正式报告存在且通过。
- [x] `temperature_release_decision`：用户接受带白平衡写限制的 M3 发布。
- [x] 修复 F-20260825-15 的非功能性换行漂移并恢复插件完整性；Node 81/81、
  Python 43/43、environment-doctor 全部通过。
- [x] `uninstall_clean`：用户在 Lightroom 中手动 Stop、移除插件并重启；确认插件消失且
  Lightroom 正常，队列无待处理请求，MCP 停用后无残留 Node 进程。
- [x] 从同一版本化目录重新加载插件并由用户手动 Start。
- [x] 生成 `artifacts/live-evidence/M4.json`。
- [x] 运行 `node scripts/verify-stages.mjs --stage M4`，结果
  `ok=true / simulated_only=false`。

## M4 认证结果

- 正式报告：`artifacts/verify-M4-2026-08-25T12-50-32-130Z/report.json`。
- Live evidence：`artifacts/live-evidence/M4.json`，三项要求全部通过。
- Node 回归：81/81；模拟 M1 ping：100/100。
- 当前插件：`0.3.0-core33-probe.7`，构建绑定 `0.3.0+7`，完整性通过。
- 当前运行能力门控继续报告 `stage=M3`。这是设计要求：M4 是稳定化、卸载与部署认证，
  不增加新的 Lightroom 方法；M4 取证器明确要求重新加载后的运行桥仍为已认证 M3。
- 发布限制不变：仅 `jpg-core33-v1`；Temperature/Tint 实时写入禁用。

## 操作边界

所有 Lightroom 界面、增效工具管理器、Stop/Start 和重启操作由用户完成。Codex 只负责
工作区修复、只读队列/进程检查、证据打包与认证，不自动操作 Lightroom。

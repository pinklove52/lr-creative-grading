# Lightroom Creative Grading Bridge

面向 Lightroom Classic 的本地创意调色工作流：从照片分析、Native / Amplify / Break
三路预览和用户选择，到快照、原子应用、回读、人物保护与回滚。生产通道使用本地文件
队列，不监听端口，不依赖 Adobe 网络，也不直接修改 `.lrcat`、XMP sidecar 或原图。

## 当前发布状态

- 认证里程碑：**M4（稳定化与部署）**，2026-08-25 实机认证通过。
- 目标环境：Windows 11、Lightroom Classic `15.0.1` 产品版本族。
- 插件版本：`0.3.0-core33-probe.7`。
- 发布范围：`jpg-core33-v1`，仅 JPG/JPEG、33 个已实机探测的全局控制。
- 回归结果：Node `81/81`，Python `43/43`。
- 运行时仍报告 `stage=M3`：M4 是部署认证，不新增 Lightroom 方法。

### Core33 能力

- 明暗：Exposure、Contrast、Highlights、Shadows、Whites、Blacks。
- 质感：Texture、Clarity、Dehaze。
- HSL：红、橙、黄、绿、青、蓝、紫、洋红八色的 Hue / Saturation / Luminance。

Temperature 与 Tint **不属于当前发布范围**。离线分析可以使用色温语义，但实时配方只要
包含 Temperature 或 Tint，就会在写入前整单原子拒绝，不会部分套用。未来若开放白平衡
写入，必须创建新 scope，并分别完成 JPG 与 RAW/DNG 实机表征。

## 架构

```text
Codex / MCP
  ↕ stdio JSON-RPC
Node LightroomFileQueueTransport
  ↕ 本地原子文件队列
FileQueueBridge.lrplugin
  ↕ Lightroom SDK + 快照 / 回读 / 回滚
当前明确授权的照片
```

运行队列位于：

```text
%APPDATA%\Adobe\Lightroom\LrCreativeGradingBridge-v2\
```

旧的双 `LrSocket` 实现保留在 `lightroom-bridge` 中作为业务核心与实验参考；正式传输使用
`lightroom-file-polling-bridge/plugin/FileQueueBridge.lrplugin`。

## 快速开始

### 1. 加载插件

在 Lightroom Classic 中打开“文件 → 增效工具管理器”，添加：

```text
lightroom-file-polling-bridge\plugin\FileQueueBridge.lrplugin
```

然后在“图库 → 库 → 增效工具额外命令”中点击：

```text
Start File Queue Bridge
```

Lightroom 的 Stop / Start、增效工具管理器、重启以及 UI 局部编辑均由用户手动完成。

### 2. 环境检查

在仓库根目录运行：

```powershell
node .\lightroom-bridge\src\environment-doctor.mjs
python .\.agents\skills\lr-creative-grading\scripts\creative_grade.py doctor --live
```

任一硬检查失败时不要继续写入。桥只接受 Lightroom `15.0.1` 产品版本族、完整性匹配的
插件和当前 scope 已探测的参数。

### 3. 创建并推进 GradeSession

```powershell
python .\.agents\skills\lr-creative-grading\scripts\creative_grade.py acquire-live `
  --workspace C:\path\to\new-session
```

后续通过同一入口的 `analyze`、`render`、`select`、`apply`、`protect` /
`protect-not-required`、`verify`、`done` 或 `rollback` 子命令推进。不要手工编辑
GradeSession JSON，也不要把文件模式会话事后绑定到 Lightroom 当前照片。

完整流程要求：

1. 固定当前照片身份、代理摘要与编辑基线。
2. 只分析一次，生成 Native、Amplify、Break 三个等尺寸预览。
3. 用户明确选择一个方向和精确强度。
4. 写入前再次验证目标、基线、能力范围和预览摘要。
5. 创建快照并原子应用完整配方；部分失败立即回滚。
6. 完成人物保护、正式回读与最终视觉检查。

## 测试

```powershell
cd .\lightroom-bridge
node --test

cd ..
python -m unittest discover `
  -s .agents\skills\lr-creative-grading\scripts\tests `
  -p "test_*.py"
```

修改发布插件后还必须经过发布闸：

```powershell
node .\scripts\release-plugin.mjs
cd .\lightroom-bridge
node --test
```

随后重新采集当前阶段的实机证据并运行 `scripts/verify-stages.mjs`。Mock 或模拟结果不能
替代 Lightroom 实机认证。

## 安全边界

- 不访问 Adobe 或其他外部服务；桥本身只使用本机文件系统。
- 不直接修改 Lightroom 目录数据库、XMP sidecar 或原始照片。
- 不自动导出、批量同步、覆盖文件或修改元数据。
- 写入前必须验证照片、编辑基线、参数支持性、范围和快照能力。
- 未知参数、越界值、目标变化、部分应用和回读不一致均 fail-closed。
- 人物/主体复杂蒙版、画笔、修复和裁切保留为用户 UI 操作。

## 仓库结构

| 路径 | 内容 |
|---|---|
| `.agents/skills/lr-creative-grading/` | GradeSession 编排、分析、预览与事务 CLI |
| `lightroom-file-polling-bridge/` | 正式文件队列 Lightroom 插件 |
| `lightroom-bridge/` | Node/MCP、事务核心、协议与测试 |
| `scripts/` | 发布、scope 同步、实机取证和阶段认证脚本 |
| `docs/` | M3/M4 计划、假设、失败账本与复用审计 |

本地 `artifacts/`、`grading_sessions/` 和 `recovery_backup/` 可能包含照片、会话令牌、
机器状态或大型崩溃转储，已从 Git 发布中排除。

## 文档入口

- [文件队列桥执行方案](LIGHTROOM_BRIDGE_EXECUTION_PLAN.md)
- [可靠性与安全边界](LIGHTROOM_BRIDGE_RELIABILITY_PLAN.md)
- [实机验收清单](LIVE_VALIDATION_CHECKLIST.md)
- [M4 完成状态](docs/M4_EXECUTION_PLAN.md)
- [参数与 SDK 假设](docs/ASSUMPTIONS.md)
- [失败账本](docs/FAILURE_LEDGER.md)
- [复用审计](docs/REUSE_AUDIT.md)

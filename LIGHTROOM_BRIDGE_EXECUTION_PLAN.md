# Lightroom 本地文件队列桥：可执行方案 v2

> 日期：2026-08-18
> 前置文档：`LIGHTROOM_BRIDGE_RELIABILITY_PLAN.md`（v1 评审版，离线约束与环境契约全部沿用）
> 本文件是**可执行方案**：把 v1 的战略结论落成里程碑、协议规范与交付物，并纳入测试与错误日志的优化。

## 1. 目标工作流

```
Codex 识别照片（视觉理解）
  → 生成 2~3 个候选调色风格 + A/B/C 预览
  → 用户确认风格
  → 文件队列桥把已确认的调色应用进 Lightroom（快照先行，可回滚）
```

全程：Adobe 网络永久离线、`hbc.adobe.io` 保持阻断、不碰 `.lrcat`、不修改原图。

## 2. 架构（v1 结论 + v2 简化）

```
Codex / MCP
  ↕ stdio JSON-RPC
Node MCP 适配器（LightroomFileQueueTransport）
  ↕ 本地文件队列（原子改名，无端口、无长连接）
Lightroom Lua 插件（FileQueueBridge.lrplugin）
  ↕ Lightroom SDK 事务执行器（复用现成 BridgeCore）
当前照片
```

运行根目录：`%APPDATA%\Adobe\Lightroom\LrCreativeGradingBridge-v2\`

### 2.1 相对 v1 的两处简化（均已在 v1 评估中论证）

1. **复用 BridgeCore 三件套**（`BridgeCore.lua` / `Json.lua` / `ParameterCatalog.lua`）。
   已核实：BridgeCore 不含任何 `LrSocket` / 传输引用，通过 `Bridge.handle(method, params)` 对外。
   文件队列桥 = 复用业务核心 + 新写一个约 400 行队列传输层。阶段 3~6 的"业务逻辑开发"已完成，
   剩下的是传输与实机验收。
2. **请求槽改为单槽（inbox/next.json）**。LrFileUtils 没有目录枚举 API，
   多文件 inbox 需要 shell 枚举或清单文件，引入新的时序状态。单槽设计：
   - Node 发布唯一请求 → 插件认领 → 处理 → 发布响应 → 槽位释放；
   - 天然满足"单事务执行、读写不交错"的 v1 约束；
   - 请求在槽位中 TTL 过期 → 移入 `failed/`，槽位自愈。

### 2.2 目录布局

```text
%APPDATA%\Adobe\Lightroom\LrCreativeGradingBridge-v2\
  session.json       插件启动时发布：token、协议版本、阶段门控、限制、LR 版本
  heartbeat.json     插件每 1s 更新
  inbox\next.json    唯一请求槽（Node 经 .tmp + 原子改名发布）
  processing\        插件认领后的处理中文件（至多一个）
  outbox\<id>.json   插件发布的响应
  failed\<id>.json   被拒绝 / 恢复失败的请求（保留原因，供诊断）
  logs\bridge.log    插件结构化日志（1 MiB 轮转，保留 2 份）
```

## 3. 协议 v2 规范（本方案唯一的协议版本）

### 3.1 请求（Node → `inbox/next.json`）

```json
{
  "protocol_version": 2,
  "request_id": "<uuid>",
  "token": "<session token>",
  "method": "ping",
  "params": {},
  "created_at_epoch": 1755500000,
  "ttl_seconds": 30
}
```

限制（两侧实现同一套规则，互不信任）：

| 项 | 值 |
|---|---|
| 文件大小 | ≤ 256 KiB |
| JSON 深度 | ≤ 32（非递归预扫描，防深度炸弹） |
| token | 必须等于 `session.json` 中的值 |
| TTL | `created_at_epoch + ttl_seconds` ≥ 插件当前时间；ttl ∈ [1, 300] |
| request_id | 非空字符串；最近 128 个已接受 ID 防重放 |
| method | 字符串，且必须命中当前阶段门控 |

### 3.2 响应（插件 → `outbox/<request_id>.json`）

```json
{
  "protocol_version": 2,
  "request_id": "<uuid>",
  "ok": true,
  "result": {},
  "plugin_version": "0.2.0",
  "duration_ms": 12,
  "completed_at_epoch": 1755500030
}
```

失败：`{ "ok": false, "error": { "code", "message", "details" } }`。

### 3.3 心跳（`heartbeat.json`）

```json
{
  "protocol_version": 2,
  "state": "idle|processing|error",
  "lr_version": "15.0.1.1",
  "plugin_version": "0.2.0",
  "stage": "M1",
  "uptime_seconds": 123,
  "completed_requests": 10,
  "failed_requests": 0,
  "last_error": null,
  "last_updated_epoch": 1755500010
}
```

Node 侧：心跳超过 5 s 未更新 → 判定桥不可用（`BRIDGE_UNAVAILABLE`），不写入新请求。

### 3.4 生命周期与恢复

| 事件 | 行为 |
|---|---|
| Node 发布 | `next.json.tmp` → flush/close → 原子改名 `next.json` |
| 插件认领 | 存在 `next.json` → 预检 → 原子改名 `processing/<id>.json` → 异步处理 |
| 插件响应 | `outbox/<id>.json.tmp` → 原子改名 → 删除 `processing` 文件 → 槽位释放 |
| 预检失败（无法解析 / 未授权） | 移入 `failed/`，不响应（Node 自己的校验本应先拦截） |
| 方法禁用 / 未知（预检通过） | 正常响应 `METHOD_DISABLED` / `METHOD_NOT_FOUND` |
| TTL 过期仍在槽位 | 移入 `failed/`（`STALE_REQUEST`），槽位自愈 |
| 插件重启 | 启动时把 `processing/*` 移入 `failed/`（`RECOVERY_UNKNOWN`，**绝不重放**） |
| Node 重启 | 清理 `outbox/*` 残留响应；重新读 `session.json` 与心跳 |
| 心跳过期 | Node 立即失败在途请求，不继续写 |

## 4. 能力门控（阶段驱动，防止未验收能力提前暴露）

`Config.lua` 中 `stage` 字段决定 `enabled_methods`，并随 `session.json` / `capabilities` 发布：

| 阶段 | 开放方法 |
|---|---|
| M1（默认） | `ping`、`capabilities`、`status` |
| M2 | + `get_target_photo`、`get_settings`、`get_proxy` |
| M3 | + `apply_transaction`、`readback`、`rollback` |

门控在插件侧强制；MCP 侧可据此提前拒绝，但信任边界在插件。

## 5. 里程碑与验收标准

### M1：队列传输自检（本方案第一交付物）

任务：
- `FileQueueBridge.lrplugin`：Info / Config / QueueTransport（轮询、单槽认领、心跳、预检、恢复、日志）。
- 复用 `BridgeCore.lua`、`Json.lua`、`ParameterCatalog.lua`（原样复制，不改业务代码）。
- Node：`file-queue-protocol.mjs`（规则唯一实现）、`file-queue-transport.mjs`、`diagnostics.mjs`。
- MCP/CLI 接入：`LR_BRIDGE_TRANSPORT=file|socket` 切换（socket 保留为实验分支）。
- 测试：协议单测 + JS 假插件（fake-lr-plugin）端到端 + 故障注入（见 §7）。

验收：
- 100 次 `ping` 全部成功，无丢失、重复、乱序。
- 故障注入全部按 §3.4 行为落盘（failed 目录可查原因）。
- 心跳过期 / 插件重启 / Node 重启场景全部按规范恢复，无重复执行。
- 现有 25 个测试保持通过；MCP stdout 保持纯 JSON-RPC。

### M2：只读 SDK 实机验收（需 Lightroom 实机）

- `Config.lua` 切 `stage = "M2"`。
- 实机清单（见 §9）：get_target_photo / get_settings / get_proxy 在测试目录与测试照片副本上逐项验收。
- 代理渲染期间换片 → `TARGET_MISMATCH` / `PROXY_STALE`。

### M3：写事务 + 虚拟副本预览（需 Lightroom 实机）

- 切 `stage = "M3"`。
- 虚拟副本预览闭环（v1 优化第 2 条）：候选风格 → 虚拟副本 → `requestJpegThumbnail` 真实渲染预览 → 确认 → 应用到母片。
- 快照先行、回读校验、回滚（BridgeCore 已实现，实机验收即可）。

### M4：稳定化与部署

- 60 分钟 soak（可缩为 30 分钟）+ 10 次 LR 重启恢复 + 模块切换。
- `environment-doctor.mjs`（环境契约检查，输出机器可读 JSON）。
- `verify-stages.mjs`：一键产出 `artifacts/` 报告（JSON + summary.md）。
- 版本化能力表与 SHA-256 清单；写操作单次授权。

## 6. 错误日志优化（相对 v1 的增强）

1. **两侧统一结构化日志**：每条日志一行 JSON（`ts / level / event / request_id / method / duration_ms / outcome`），
   机器可解析，不再依赖人类读文本日志。
2. **Lua 侧轮转**：`logs/bridge.log` 达 1 MiB 轮转为 `.1`，保留 2 份；写入失败只记入心跳 `last_error`，不崩溃。
3. **心跳携带诊断状态**：`state / last_error / completed / failed / uptime`，Node 侧可用 `status()` 直接呈现。
4. **失败目录即审计**：每个被拒/恢复失败的请求保留原文件 + 原因码（`STALE_REQUEST` / `RECOVERY_UNKNOWN` /
   `DUPLICATE_REQUEST` / `INVALID_JSON` / `AUTHENTICATION_FAILED` / `REQUEST_TOO_LARGE` / `TOO_DEEP`），
   事后可直接复现输入。
5. **Node 侧诊断文件**：`logs/node-bridge.log` + stderr；MCP stdout 永不写日志。
6. **每次调用完整留痕**：Node 对每个请求记录 method、request_id、duration、outcome、错误码。

## 7. 测试策略优化（相对 v1 的增强）

分层测试，Mock 通过 ≠ 实机通过，每一层都在 v1 基础上强化：

1. **协议层（纯函数单测）**：深度扫描、信封 shape、TTL、token、重放规则——JS 侧规则唯一实现，Lua 侧同规则。
2. **端到端（JS 假插件模拟 LR 侧）**：`fake-lr-plugin.mjs` 按同一协议实现插件侧行为（含心跳、恢复），
   与真实传输对接，覆盖：正常往返、顺序 100 次、方法禁用、插件重启、槽位占用、响应超时。
3. **故障注入**：半写入 `.tmp`、超限请求、深度 33、错误 token、过期 TTL、重复 request_id、
   processing 残留（模拟 LR 崩溃）、心跳停跳、Node 在响应发布前后退出。
4. **MCP 集成**：现有 25 个测试保持通过；新增 file 传输下 MCP 工具链路。
5. **实机验收**（Lua 侧行为只能在 Lightroom 内验证，§9 清单逐项打勾，产证到 `artifacts/`）。

## 8. 实施状态（2026-08-21 更新）

### 已完成（M1/M2 代码与验收）

- `lightroom-file-polling-bridge/plugin/FileQueueBridge.lrplugin/`：
  Info / Config（阶段门控）/ QueueTransport（轮询、单槽认领、预检、心跳、恢复、
  结构化日志轮转）/ Start / Stop 菜单 + 原样复用的 BridgeCore / Json / ParameterCatalog
  + `checksums.txt`（SHA-256 清单）。
- `lightroom-bridge/src/`：`file-queue-protocol.mjs`（规则唯一实现）、
  `file-queue-transport.mjs`（含启动恢复、心跳门控、诊断日志落盘
  `<队列根>/logs/node-bridge.log`）、`environment-doctor.mjs`；
  MCP 服务与 CLI 默认走文件队列（`LR_BRIDGE_TRANSPORT=socket` 切回实验分支）。
- 测试：协议单测 + Lua 契约测试（两侧规则一致性锁定）+ JS 假插件端到端 +
  故障注入（半写入、深度炸弹、错误 token、TTL 过期、重放、心跳停跳、
  插件崩溃、Node 中途退出、阶段门控）。
- `scripts/verify-stages.mjs`：一键产出 `artifacts/<run-id>/`（report.json +
  summary.md + 会话/心跳样本）；最近 3 连跑 47/47 全绿。
- M2 Lightroom 15.0.1.1 实机只读验收：`get_target_photo`、`get_settings`、`get_proxy`、目标切换保护、
  baseline 变化检测、连续 50 次调用和模块切换均通过；证据记录于 `LIVE_VALIDATION_CHECKLIST.md`。

### 待办（M3/M4，需要 Lightroom 实机）

- M3 写事务 + 虚拟副本预览闭环：快照先行、回读校验、回滚及写路径崩溃恢复。
- M4 稳定化与部署：soak、重启恢复、环境预检、版本能力表与卸载验证。

### 安全边界（沿用 v1，一条不减）

不联网、不碰 `.lrcat`、不修改原图、快照先行、回滚校验、版本白名单、
不确定状态一律拒绝。

## 9. 实机验收清单

完整可勾选清单见 `LIVE_VALIDATION_CHECKLIST.md`（含环境预检、M1/M2/M3 逐项步骤、
取证要求和卸载验证）。

## 10. 回滚方案（沿用 v1 §8，简述）

- 插件级：版本化目录，不覆盖旧目录；停用 → 移动目录 → 重启验证。
- 事务级：唯一事务 ID + 完整基线 + 快照；目标变化拒绝回滚；回滚后完整基线比对。
- 桥级：MCP 独立注册名；停用后队列插件只保心跳，不执行旧请求；过期请求进 `failed/` 不重放。

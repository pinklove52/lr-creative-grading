# File Queue Bridge（文件队列桥 v2）

> 当前已验收里程碑：`v0.2.0-m2`（M1 文件队列基础能力 + M2 只读 SDK 实机验收）。
> `Config.stage` 保持为 `"M2"`；M3 写事务能力尚未开放。

Lightroom Classic ↔ Node/MCP 的本地文件队列桥。取代旧 `lightroom-bridge` 的双端口
`LrSocket` 长连接方案（保留为 `socket-experimental` 实验分支），只通过用户级目录中的
原子改名文件通信：无端口、无长连接、无 Adobe 网络依赖。

- 架构与协议：`../LIGHTROOM_BRIDGE_EXECUTION_PLAN.md`
- 实机验收清单：`../LIVE_VALIDATION_CHECKLIST.md`

## 组成

```text
plugin/FileQueueBridge.lrplugin/
  Info.lua              清单；Start/Stop 菜单（不随插件加载自动启动）
  Config.lua            阶段门控（M1/M2/M3）+ 协议常量
  QueueTransport.lua    轮询 / 单槽认领 / 预检 / 心跳 / 恢复 / 结构化日志
  Start.lua / Stop.lua  菜单入口
  BridgeCore.lua        事务业务核心（原样复用自 lightroom-bridge）
  Json.lua              JSON 编解码（复用）
  ParameterCatalog.lua  参数目录（复用）
  checksums.txt         SHA-256 校验清单
```

Node 侧（位于 `../lightroom-bridge/`）：

- `src/file-queue-protocol.mjs`：协议 v2 规则唯一实现（与 Lua 侧同规则）
- `src/file-queue-transport.mjs`：文件队列传输（接口与旧 socket 传输一致）
- `src/environment-doctor.mjs`：环境预检器
- `test/fake-lr-plugin.mjs`：JS 假插件（无 Lightroom 的端到端测试）
- `test/file-queue-*.test.mjs`：协议 / 传输 / Lua 契约测试

## 队列目录

```text
%APPDATA%\Adobe\Lightroom\LrCreativeGradingBridge-v2\
  session.json / heartbeat.json / inbox\next.json
  processing\ / outbox\ / failed\ / logs\
```

## 使用（M2）

1. Lightroom → 文件 → 增效工具管理器 → 添加本目录下的 `FileQueueBridge.lrplugin`。
2. 图库 → 库 → 增效工具额外命令 → **Start File Queue Bridge**。
   确认对话框显示 `started`，`session.json` 与每秒更新的 `heartbeat.json` 出现。
3. Node 侧调用（默认文件队列传输）：

   ```bash
   cd ../lightroom-bridge
   echo '{}' | node src/bridge-cli.mjs ping
   ```

4. M2 只读调用：`get_target_photo`、`get_settings`、`get_proxy` 均只对测试目录/测试照片副本开放。
5. 停止：**Stop File Queue Bridge**（会话与心跳文件被删除，Node 立即感知）。

## 阶段推进

实机验收按 `../LIVE_VALIDATION_CHECKLIST.md` 逐项通过后，修改 `Config.lua`：

```lua
Config.stage = "M3"
```

然后在增效工具管理器中 Reload，Stop → Start 重启桥。新门控随 `session.json` 发布，
Node 侧每次调用前自动跟随。

## 测试

```bash
cd ../lightroom-bridge && npm test          # 全部测试（协议/传输/契约/MCP/会话）
cd .. && node scripts/verify-stages.mjs     # 产出 artifacts/ 验收证据报告
```

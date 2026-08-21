# 实机验收清单（Lightroom 15.0.1 产品版本族 / Windows 11）

> 配套文档：`LIGHTROOM_BRIDGE_EXECUTION_PLAN.md`（架构与协议）、`lightroom-file-polling-bridge/README.md`（使用说明）。
> 原则：**任何一项失败 → 停止推进、保留现场（队列目录 + 日志）、不重试写操作。**
> 全程使用独立测试目录和测试照片副本；`hbc.adobe.io` 阻断保持不变；Lightroom 保持离线。

## 0. 环境预检（每轮验收前跑一次）

```bash
cd lightroom-bridge
node src/environment-doctor.mjs
```

- [ ] 输出 JSON 中 `ok: true`（硬检查：LR 可执行文件、Node 版本、队列目录可写）
- [ ] `lr_version_whitelist` 显示 `match_mode: "prefix"`、`accepted_prefix: "15.0.1"` 且 `ok: true`（`actual` 必须以 `15.0.1` 开头；若为 null 只允许只读）
- [ ] `clash_hbc_adobe_io_block` 找到规则文件
- [ ] 最近 24 小时无 Lightroom 崩溃事件

## 1. M1：队列传输自检（默认 stage=M1，无需改配置）

### 1.1 加载与启动

- [ ] 增效工具管理器添加 `lightroom-file-polling-bridge\plugin\FileQueueBridge.lrplugin`，状态"已安装并正在运行"，无报错
- [ ] 图库 → 增效工具额外命令 → **Start File Queue Bridge** → 对话框显示 `Bridge start: started`
- [ ] `%APPDATA%\Adobe\Lightroom\LrCreativeGradingBridge-v2\` 下出现 `session.json`、`heartbeat.json`、四个子目录
- [ ] `heartbeat.json` 的 `last_updated_epoch` 每秒变化（连续观察 5 秒）
- [ ] `logs\bridge.log` 出现 `bridge_started` 条目（JSON 格式）

### 1.2 Node 侧往返

```bash
cd lightroom-bridge
echo '{}' | node src/bridge-cli.mjs ping
echo '{}' | node src/bridge-cli.mjs capabilities
echo '{}' | node src/bridge-cli.mjs status
```

- [ ] `ping` 返回 `ok: true`，`lr_version` 以 `15.0.1` 开头，`stage: "M1"`
- [ ] `capabilities` 的 `enabled_methods` 恰为 `["ping","capabilities","status"]`
- [ ] `status` 的 `completed_requests` 随每次成功调用递增
- [ ] 快速连跑 20 次 ping 全部成功（`for i in $(seq 1 20); do echo '{}' | node src/bridge-cli.mjs ping; done`）

### 1.3 门控与停止

- [ ] `echo '{}' | node src/bridge-cli.mjs get_target_photo` 返回 `METHOD_DISABLED`（M1 未开放）
- [ ] **Stop File Queue Bridge** → `session.json` 与 `heartbeat.json` 消失
- [ ] 停止后 `ping` 返回 `PLUGIN_NOT_RUNNING`
- [ ] Start → Stop 循环 5 次，均正常，`bridge.log` 无 error 条目

### 1.4 故障与恢复（M1 实机版）

- [ ] 桥运行中直接退出 Lightroom → 重启 LR → Start：队列正常，无残留 `next.json`
- [x] 桥运行中重启电脑 → Start：正常（2026-08-21：重启后桥启动成功，实机 ping 20/20，通过后安全停止；会话、心跳及在途队列均无残留）
- [ ] 手动向 `inbox\next.json` 写入非法 JSON（如 `{`）→ 数秒内该文件出现在 `failed\` 并带 `.reason.json`（`INVALID_JSON`），心跳仍每秒更新
- [ ] 全程 Lightroom 界面可操作、不卡顿（轮询不应阻塞 UI）

### M1 通过标准

> 全部勾选后，M1 完成。此时才允许把 `Config.lua` 的 `stage` 改为 `"M2"` 并 Reload + Stop → Start。

## 2. M2：只读 SDK 验收（stage=M2，测试目录 + 测试照片副本）

- [x] 切换 stage 后 `capabilities` 的 `enabled_methods` 增加了 `get_target_photo / get_settings / get_proxy`（2026-08-21：实机返回 M2 六个只读方法）
- [x] 选中测试照片 → `get_target_photo` 返回的文件名/digest 与实际一致（`DSC_7147.JPG` / photo_id `610709`）
- [x] `get_settings` 读回的参数值与 Lightroom 修改照片面板一致（实机探测 81 个支持参数；曝光 `0.00 → +0.10 → 0.00` 精确读回）
- [x] `get_proxy` 在 `%TEMP%\LrCreativeGradingBridge\proxies\` 生成 JPEG 代理，内容与当前编辑一致（53,491 bytes，JPEG 已实际解码检查）
- [x] 目标切换保护返回 `TARGET_MISMATCH`（代理正向回读完成过快，改用携带 `DSC_7147.JPG` 旧目标摘要读取已切换的 `DSC_4458.JPG`；文件名、photo_id、source_digest 三重拒绝，覆盖同一目标身份不变量）
- [x] 修改照片（手动改曝光）→ `get_settings` 的 baseline digest 变化（`1b23d0e5… → 347316e1…`；恢复后精确回到原摘要）
- [x] 连续 50 次只读调用无卡顿、无任务静默终止（50/50；单一照片、单一 baseline digest；本轮 `failed_requests: 0`）
- [x] 图库/修改照片模块来回切换，读操作结果不受影响（同一 photo_id 与 baseline digest）

> M2 实机证据：`artifacts/verify-M2-2026-08-21T08-06-16-212Z/`；最终停桥后 session、heartbeat、inbox、processing、outbox 均为空。日志中的一次 `TARGET_MISMATCH` 为上述预期负向测试。

## 3. M3：写事务与虚拟副本预览（stage=M3）

> 全程先在**测试照片副本**上验收，确认无误后才允许对正式照片开放（单次授权 + 默认快照）。

### 3.1 单参数可逆事务

- [ ] 通过完整 GradeSession 应用 1 个参数（如 exposure）→ 修改照片面板出现变化 + 历史条目
- [ ] `readback` 返回 applied 且值在容差内
- [ ] 快照出现在快照面板（事务前基线）
- [ ] `rollback` → 面板恢复，`readback` 与原始基线一致

### 3.2 批量事务

- [ ] 5 参数事务：应用 → 回读 → 回滚，基线无漂移
- [ ] 25 参数事务（经能力探测的参数集）：同上
- [ ] 包含不支持参数的事务被整单拒绝（`unsupported` 明确列出，无部分应用）

### 3.3 虚拟副本预览闭环（最终工作流验收）

- [ ] 候选调色应用到虚拟副本 → `get_proxy` 渲染的预览与该副本实际外观一致
- [ ] 母片的开发设置全程未被改动（digest 不变）
- [ ] 确认后应用同一配方到母片 → 效果与虚拟副本预览一致
- [ ] 连续 10 轮"预览 → 确认 → 应用 → 回滚"无状态残留

### 3.4 崩溃恢复（写路径）

- [ ] 应用中途强制退出 Lightroom → 重启后 `processing\` 中的孤儿文件（超宽限期后）出现在 `failed\`（`RECOVERY_UNKNOWN`），照片未被二次修改
- [ ] 回滚失败场景（手动改照片后 rollback）→ 返回明确错误而不是覆盖

## 4. 稳定性收尾（M3 通过后）

- [ ] 30~60 分钟空闲运行：心跳无中断、内存无持续增长、Lightroom 无崩溃
- [ ] 10 次桥 Stop → Start 循环
- [ ] `node scripts/verify-stages.mjs --stage M3` 产出证据到 `artifacts/`

## 5. 卸载验证

- [ ] Stop → 增效工具管理器移除插件 → 重启 Lightroom 正常
- [ ] 队列目录只剩日志与 failed 记录，无待处理请求
- [ ] MCP 停用后无 Node 进程残留

---

## 失败时取证

1. 不要重试写操作；保持 Lightroom 运行。
2. 复制整个 `%APPDATA%\Adobe\Lightroom\LrCreativeGradingBridge-v2\`（含 `logs/`、`failed/`）。
3. 记录 `node src/bridge-cli.mjs status` 输出与 Windows 事件查看器中 Lightroom 相关条目。
4. 一并附上 `artifacts/` 最近一次报告。

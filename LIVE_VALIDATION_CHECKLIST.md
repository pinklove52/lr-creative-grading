# 实机验收清单（Lightroom 15.0.1 产品版本族 / Windows 11）

> 配套文档：`LIGHTROOM_BRIDGE_EXECUTION_PLAN.md`（架构与协议）、`lightroom-file-polling-bridge/README.md`（使用说明）。
> 原则：**任何一项失败 → 停止推进、保留现场（队列目录 + 日志）、不重试写操作。**
> 全程使用独立测试目录和测试照片副本；`hbc.adobe.io` 阻断保持不变；Lightroom 保持离线。

## 0. 环境预检（每轮验收前跑一次）

```bash
cd lightroom-bridge
node src/environment-doctor.mjs
```

- [x] 输出 JSON 中 `ok: true`（2026-08-22 新证据链重跑通过）
- [x] `lr_version_whitelist` 为 prefix / 15.0.1 且实际版本可读（2026-08-22）
- [x] `clash_hbc_adobe_io_block` 找到规则文件（2026-08-22）
- [x] 最近 24 小时无 Lightroom 崩溃事件（2026-08-22 doctor）

## 1. M1：队列传输自检（默认 stage=M1，无需改配置）

### 1.1 加载与启动

- [x] 增效工具管理器状态"已安装并正在运行"，Reload 无报错（2026-08-22）
- [x] 图库 → 增效工具额外命令 → **Start File Queue Bridge** → `Bridge start: started / Stage: M1`（2026-08-22）
- [ ] `%APPDATA%\Adobe\Lightroom\LrCreativeGradingBridge-v2\` 下出现 `session.json`、`heartbeat.json`、四个子目录
- [x] `heartbeat.json` 连续 6 个样本每秒更新（2026-08-22）
- [x] `logs\bridge.log` 存在 JSON 启动及请求条目（2026-08-22）

### 1.2 Node 侧往返

```bash
cd lightroom-bridge
echo '{}' | node src/bridge-cli.mjs ping
echo '{}' | node src/bridge-cli.mjs capabilities
echo '{}' | node src/bridge-cli.mjs status
```

- [x] `ping` 返回 `ok: true / lr_version: 15.0.1 / stage: M1`（2026-08-22）
- [x] `capabilities.enabled_methods` 恰为 ping/capabilities/status（2026-08-22）
- [x] `status.completed_requests` 随成功调用递增（2026-08-22）
- [x] 快速顺序 20 次 ping：20/20（2026-08-22）

### 1.3 门控与停止

- [x] `get_target_photo` 返回 `METHOD_DISABLED`（2026-08-22）
- [x] **Stop File Queue Bridge** → `session.json` 与 `heartbeat.json` 消失（2026-08-22）
- [x] 停止后 `ping` 返回 `PLUGIN_NOT_RUNNING`，inbox/processing/outbox 无残留（2026-08-22）
- [ ] Start → Stop 循环 5 次，均正常，`bridge.log` 无 error 条目

### 1.4 故障与恢复（M1 实机版）

- [ ] 桥运行中直接退出 Lightroom → 重启 LR → Start：队列正常，无残留 `next.json`
- [x] 桥运行中重启电脑 → Start：正常（2026-08-21：重启后桥启动成功，实机 ping 20/20，通过后安全停止；会话、心跳及在途队列均无残留）
- [x] 非法 JSON 被移至 `failed/`，reason=`INVALID_JSON`，槽位释放且心跳继续（2026-08-22）
- [x] 全程 Lightroom 界面可操作、不卡顿（2026-08-22 只读与隔离测试）

### M1 通过标准

> 全部勾选后，M1 完成。此时才允许把 `Config.lua` 的 `stage` 改为 `"M2"` 并 Reload + Stop → Start。
>
> 打包与认证顺序：先完成包括 Start/Stop 循环和 `restart_recovery` 在内的全部检查；
> 重启操作结束后再次 **Start File Queue Bridge**；确认桥为运行态后执行
> `live-evidence --observations`（该命令会实测 ping），最后运行 `verify-stages`。

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
>
> 2026-08-22 部分实机证据：`DSC_4458.JPG` 的 4 参数 Native 事务完成
> “应用 → 完全退出 Lightroom → 重启并 Start → GradeSession 恢复 → 快照回滚”，
> 应用后摘要跨重启一致，回滚摘要严格等于写前摘要。证据：
> `grading_sessions/DSC_4458_restart_rollback_m3_final/grade_session.json`。
> 该结果只覆盖单事务跨重启恢复，**不替代**下列 1/5/25 参数、整单拒绝、
> 虚拟副本、中途崩溃和稳定性清单项，因此不得据此声明完整 M3。

### 3.1 单参数可逆事务

- [ ] 通过完整 GradeSession 应用 1 个参数（如 exposure）→ 修改照片面板出现变化 + 历史条目
- [ ] `readback` 返回 applied 且值在容差内
- [ ] 快照出现在快照面板（事务前基线）
- [ ] `rollback` → 面板恢复，`readback` 与原始基线一致

### 3.2 JPG Core33 自动探测与批量事务

- [ ] 导入并选中 `artifacts/core33/core33-test-chart.jpg`
- [ ] `node scripts/probe-core33-jpg.mjs` 返回 33/33 `write_probed`，最终摘要等于基线摘要
- [ ] 6 项基本色调、3 项质感、Hue/Saturation/Luminance 各 8 项分组事务通过
- [ ] 全 33 项安全小幅事务：应用 → 回读 → 回滚，基线无漂移
- [ ] 混入 Tint 或其他范围外参数时返回 `OUT_OF_SCOPE_PARAMETER`，整单零写入
- [ ] 未加载当前构建能力表时返回 `UNPROBED_PARAMETER`，整单零写入

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

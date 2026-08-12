# Lightroom Creative Grading Bridge

这是 `lr-creative-grading` 的本地执行桥。它把一次已选择的 `GradeSession 1.0.0` 编译成固定基线上的 Lightroom 参数事务：先校验照片与编辑摘要，再完整预检、创建唯一快照、写入整组参数、回读；部分失败会立即尝试回滚。

桥接不修改 `.lrcat` 文件，不写照片 XMP sidecar，不覆盖原图，也不处理导出。数值参数优先走 `LrDevelopController.setValue`；曲线使用受限的 `photo:applyDevelopSettings`；人物/主体蒙版、复杂笔刷、裁切与修复明确返回 `ui_required`。

## 架构与信任边界

```text
Codex MCP client
  ↕ newline-delimited JSON-RPC over stdio
Node MCP server (zero runtime dependencies)
  ↕ two authenticated LrSocket channels on localhost
Lightroom Lua plug-in
  ↕ LrDevelopController / LrPhoto SDK calls
active Lightroom photo
```

- SDK socket只在 Lightroom 定义的 localhost 上开放；session descriptor 固定声明 `127.0.0.1`。
- 插件每次启动生成64位十六进制风格随机令牌与临时端口，写入用户级 `%APPDATA%\LrCreativeGradingBridge\session.json`。
- 单个 `client_id` 锁定会话，请求/响应各限制1 MiB，并保留最近256个 `request_id` 防止重放。
- session descriptor先写临时文件再发布；MCP服务对短暂缺失或不完整读取进行有限重试。
- MCP stdout只输出JSON-RPC；诊断只进stderr。

## 接口

MCP工具固定为：

- `capabilities({})`
- `get_target_photo({})`
- `get_proxy({ long_edge?, timeout_seconds? })`
- `get_settings({ target?, parameters? })`
- `apply_transaction(GradeSession)`
- `readback({ transaction_id|execution.transaction_id, target?, expected_current_edit_digest? })`
- `rollback({ transaction_id|execution.transaction_id, target?, expected_current_edit_digest? })`

`apply_transaction`优先接受完整会话，并只接受以下状态：

```text
session_version = 1.0.0
execution.state = SELECTED
execution.state_history = ACQUIRE→ANALYZED→PREVIEWED→SELECTED
selected candidate has no unexpected risk
execution.desired matches candidate_id / strength / parameter_specs
```

返回值包含 `transaction_id / desired / applied / readback / skipped / unsupported / failures`，并提供 `execution_patch`。应用成功时追加 `SNAPSHOTTED, APPLIED`；桥接回读只设置 `readback_verified=true`，不会越过人物保护步骤冒充 `VERIFIED`。编排器必须先写入 `PERSON_PROTECTED`（无人像时为 `not_required`），再推进会话状态。

### 摘要字段不能混用

- `target.source_digest`：照片身份摘要，用于应用时防止换片；不随调色改变。
- `target.baseline_edit_digest`：当前完整编辑状态摘要，用于防止分析后被改动。
- `proxy_digest`（兼容别名 `digest`）：Lightroom渲染JPEG的字节摘要，只用于PhotoDNA、缓存和离线预览。

`get_proxy.target.proxy_digest`可以进入分析，但绝不能覆盖 `target.source_digest`。异步渲染期间如果照片或基线编辑改变，接口返回 `TARGET_MISMATCH` 或 `PROXY_STALE`，不会交付不确定代理。

### 0–200%强度

配方字段使用显式规格：

```json
{
  "contrast": { "operation": "delta", "value": 18, "interpolation": "linear" },
  "color_grade_shadow_hue": {
    "operation": "target",
    "value": 205,
    "interpolation": "circular_degrees"
  },
  "tone_curve_red": {
    "operation": "target",
    "curve_points": [0, 0, 128, 112, 255, 255],
    "interpolation": "curve_points"
  }
}
```

- 0%：固定在事务开始时读到的基线。
- 100%：到达设计值。
- 200%：沿同一路径外推；角度按最短圆周差并回绕。
- 裸数字默认拒绝；只有显式 `legacy_numeric_mode: "delta"` 才映射为旧式delta。
- 任一编译结果越界即整单拒绝，不截断、不夹值。

权威参数表是 `plugin/LrCreativeGradingBridge.lrplugin/ParameterCatalog.lua`。可运行跨组件覆盖检查：

```powershell
node .\src\catalog-contract.mjs --session C:\path\to\grade-session.json
```

## 安装

安装器默认只预演，不产生写入：

```powershell
.\install.ps1
```

确认目标后才显式安装 Lightroom Modules、副本化本地服务并注册 MCP：

```powershell
.\install.ps1 -Install
```

若只安装文件而暂不注册 MCP：

```powershell
.\install.ps1 -Install -SkipMcpRegistration
```

脚本拒绝覆盖已有插件或服务目录，也不会删除既有MCP注册。当前实现没有自动执行过安装。

## 验证

运行零依赖测试：

```powershell
npm.cmd test
```

测试覆盖完整GradeSession门禁、25字段批量事务、target/baseline mismatch、未知与越界参数、0/100/200强度、圆周色相、曲线shape、UI-only回传、部分ack自动回滚、阈值复位、后续手工编辑保护、localhost双socket和MCP stdout纯净性。

## 实机验证边界

代码以 Lightroom Classic 15.0.1 为目标，最低加载版本为SDK 14.0，并在运行时探测每个参数范围与可用性。当前尚未在正在运行的 Lightroom 15.0.1 中完成实机调用，因此以下项必须在安装后做集成验收：

- Windows版 `LrSocket` 双端口的连接/重连时序。
- 15.0.1中20–30个 `setValue` 是否稳定合并为一个 `Multiple Settings` 历史条目。
- 虚拟副本创建/应用开发快照；代码保留完整settings回滚后备，但默认快照失败仍拒绝应用。
- 现代通道曲线经 `applyDevelopSettings` 的精确格式与独立历史行为。
- UUID preset amount与受保护preset键检查。

直接数值参数使用 `setMultipleAdjustmentThreshold` 做单历史条目最佳努力；preset与结构化曲线可能产生额外历史条目，`capabilities`会明确报告，代码不宣称严格单条历史保证。

常见拒绝码包括 `TARGET_MISMATCH`、`BASELINE_MISMATCH`、`BASELINE_CHANGED`、`PROXY_STALE`、`UNKNOWN_PARAMETER`、`UNSUPPORTED_PARAMETER`、`OUT_OF_RANGE`、`MODULE_SWITCH_FAILED`、`SNAPSHOT_FAILED`、`UNSAFE_PRESET`、`PARTIAL_APPLY_ROLLED_BACK`、`ROLLBACK_FAILED`、`DUPLICATE_REQUEST` 与 `BRIDGE_*` 连接错误。

# JPG Core33：从已认证 M2 推进到 M3 的独立执行方案

> 方案日期：2026-08-23  
> 当前正式认证阶段：M2  
> 当前阶段依据：`artifacts/verify-M2-2026-08-22T15-52-33-634Z/report.json`  
> 目标：只在 Lightroom Classic 15.0.1 / Windows 11 / JPG 上，可靠完成指定 33 个参数的读取、写入、回读、回滚和创意调色闭环。  
> 本文件是独立新方案，不修改旧方案，也不从旧方案续写。

## 1. 当前事实

1. M2 已正式认证通过，不再回退到 M1，也不重新签发 M1/M2 证书。
2. M2 已证明：目标照片身份读取、参数读取、代理图获取、换片保护、基线变化检测、连续只读调用和模块切换可用。
3. M3 尚未正式认证。历史 4 参数写入/回滚只能作为参考证据，不能替代本方案的 M3 验收。
4. 当前运行时代码暴露的参数远多于本版本需要的 33 项；当前候选配方仍包含 Vibrance、Temperature 离线操作、Color Grading、Grain、Calibration 等越界内容。
5. 当前仍有 Reload 后旧 Lua 任务可能残留、造成双桥争用的问题。这个问题不解决，不允许开始写参数实测。

## 2. 本版本边界

### 2.1 唯一支持环境

- 操作系统：Windows 11。
- Lightroom：Lightroom Classic 15.0.1 产品版本族；证据必须记录完整 build。
- 原始目标格式：JPG。
- 传输：现有文件队列协议 v2。
- 写入对象：用户明确选中的测试 JPG 或正式 JPG；测试阶段只允许专用测试图。

以下情况整单拒绝，照片不得发生任何变化：

- RAW、DNG、TIFF、PSD 或其他格式；
- Lightroom 版本不匹配；
- 目标照片、文件名、source digest 或 baseline edit digest 不匹配；
- 参数不在 Core33 范围；
- 参数没有当前 M3 构建对应的实机可写证据；
- 任一值越界、类型错误或回读不可靠。

### 2.2 唯一支持参数：33 项

#### 基本色调：6 项

| 逻辑名 | Lightroom SDK 名 |
| --- | --- |
| `exposure` | `Exposure` |
| `contrast` | `Contrast` |
| `highlights` | `Highlights` |
| `shadows` | `Shadows` |
| `whites` | `Whites` |
| `blacks` | `Blacks` |

#### 质感：3 项

| 逻辑名 | Lightroom SDK 名 |
| --- | --- |
| `texture` | `Texture` |
| `clarity` | `Clarity` |
| `dehaze` | `Dehaze` |

#### HSL：24 项

颜色固定为：Red、Orange、Yellow、Green、Aqua、Blue、Purple、Magenta。

每个颜色固定支持：

- `hue_<color>` → `HueAdjustment<Color>`；
- `saturation_<color>` → `SaturationAdjustment<Color>`；
- `luminance_<color>` → `LuminanceAdjustment<Color>`。

完整逻辑名：

```text
hue_red, hue_orange, hue_yellow, hue_green,
hue_aqua, hue_blue, hue_purple, hue_magenta

saturation_red, saturation_orange, saturation_yellow, saturation_green,
saturation_aqua, saturation_blue, saturation_purple, saturation_magenta

luminance_red, luminance_orange, luminance_yellow, luminance_green,
luminance_aqua, luminance_blue, luminance_purple, luminance_magenta
```

### 2.3 明确排除

本版本不支持 Temperature、Tint、Vibrance、全局 Saturation、Color Grading、Calibration、曲线、Profile、颗粒、暗角、锐化、降噪、裁切、旋转、几何、镜头校正、蒙版、局部笔刷、修复、红眼、元数据、评分、旗标、导出和同步。

排除项不得留在“可写但暂时不用”的运行时目录中。写请求出现排除项时返回 `OUT_OF_SCOPE_PARAMETER`，整单零写入。

## 3. 最终产物

本方案完成后必须交付：

1. 只暴露 Core33 的 Lightroom 插件构建。
2. 唯一参数范围文件 `lightroom-bridge/config/jpg-core33-v1.json`。
3. 由范围文件生成或强制校验的 Lua、Node、Python 参数集合。
4. JPG Core33 自动实机探测器。
5. 标准 Core33 JPG 测试图。
6. 每项参数的机器可读能力记录。
7. 单参数、分组、全 33 项、非法参数、回滚和恢复测试证据。
8. 只使用 Core33 的 Native、Amplify、Break 配方和预览。
9. 当前插件构建绑定的 `artifacts/live-evidence/M3.json`。
10. `simulated_only:false`、`ok:true` 的 M3 正式报告。

## 4. 防止方案和代码再次偏离

### 4.1 一个事实来源

新建 `lightroom-bridge/config/jpg-core33-v1.json`，它是本版本参数范围的唯一事实来源，至少包含：

- `scope_id`；
- 支持的 Lightroom 版本；
- 支持的源格式；
- 精确的 33 个逻辑名与 SDK 名；
- 参数类型和写入引擎；
- 实机状态：`unprobed`、`write_probed`、`unsupported`；
- 每项回读容差；
- 证据路径；
- 插件 build、checksums digest 和 scope digest。

禁止在 Lua、Node、Python、Mock、README 中各自维护另一份手写清单。

### 4.2 生成与校验

增加范围生成/校验脚本，负责：

1. 生成或校验 `ParameterCatalog.lua` 恰好只有 33 项；
2. 生成或校验 Node 事务 allowlist；
3. 生成或校验 Python 候选配方 allowlist；
4. 生成测试夹具和文档参数表；
5. 计算 `scope_digest`。

`release-plugin.mjs` 必须先运行范围校验。出现以下任一情况立即失败：

- 运行时多一个或少一个参数；
- 逻辑名与 SDK 名不一致；
- Python 能生成范围外参数；
- Node 或 Lua 接受范围外参数；
- 文档与运行时不一致；
- 实机能力表未覆盖全部 33 项；
- 当前插件 checksum 与证据不一致。

### 4.3 证据绑定

M3 实机证据必须同时绑定：

- Git commit；
- 插件版本和 build；
- `checksums.txt` digest；
- `scope_id` 和 `scope_digest`；
- Lightroom 完整版本；
- 原始照片格式 JPG；
- Core33 能力表 digest；
- 测试图 digest。

任何受控文件变化后，旧 M3 证据自动失效，必须重取。已认证 M2 作为前序证书保留，不因 M3 开发而回退。

## 5. 实施步骤与硬门禁

### P0：登记新范围和现存问题

动作：

1. 在失败账本登记“读取能力被错误表述为可写能力”和“旧配方超出 Core33”两个问题。
2. 将本方案登记为 JPG Core33 M3 的唯一活动方案；旧计划只作历史参考，不修改旧文件内容。
3. 当前 Config 继续保持 M2，M3 写方法不得提前对生产目标开放。

通过门禁：

- 新问题已有编号、现象、根因、影响和后续证据要求；
- 没有代码把 M2 配置值冒充 M3 认证。

### P1：修复 Reload 双桥争用

实现：

1. 每次 Start 生成唯一 `instance_id`；
2. 在队列根保存原子发布的 owner/lease；
3. 每次轮询、认领请求和发布心跳前检查 owner 是否仍等于自己的 `instance_id`；
4. Reload 后新实例取得 owner，旧闭包发现失去所有权后停止；
5. Stop 只停止当前 owner，不得误删新实例状态；
6. session 和 heartbeat 同时记录 `instance_id`。

验证：

- 完全退出 Lightroom 后重新开始一次干净测试；
- 连续 10 次 Reload → Start → 请求 → Stop；
- 任意时刻只有一个心跳和一个 owner；
- session 与 heartbeat 的 stage、token 对应实例、instance_id 一致；
- 不再出现旧 M1 heartbeat 与新 M2 session 并存。

硬门禁：P1 不通过，禁止进入任何参数写测试。

### P2：把运行时砍到 JPG Core33

实现：

1. 建立 `jpg-core33-v1.json`；
2. `ParameterCatalog.lua` 只保留 33 项；
3. Node 和 Python 只接受这 33 项；
4. `get_target_photo.format` 必须为 JPG；分析代理文件的 `.jpg` 后缀不能作为源格式证据；
5. GradeSession 写入 `scope_id` 和 `scope_digest`；
6. 旧 GradeSession 没有匹配 scope 时禁止应用。

稳定错误码：

- 非 JPG：`UNSUPPORTED_SOURCE_FORMAT`；
- 范围外参数：`OUT_OF_SCOPE_PARAMETER`；
- 33 项中尚未实测可写：`UNPROBED_PARAMETER`；
- 范围外数值：`OUT_OF_RANGE`。

硬门禁：对每个错误码做零写入测试，完整 baseline digest 必须保持不变。

### P3：建立自动实机探测器

新增只在验收模式开放的 `probe_core33_jpg`。它只能操作允许目录中的专用测试 JPG，不对普通照片开放。

生成一张标准 JPG 测试图，包含：

- 黑白渐变和高光/阴影阶梯；
- 低频和高频纹理；
- 红、橙、黄、绿、青、蓝、紫、洋红八类色块；
- 每类颜色的多档饱和度和亮度。

用户只需要把测试图导入 Lightroom、选中它并启动桥。后续由探测器自动运行。

每项参数固定执行：

```text
锁定测试 JPG 身份与基线
→ 创建快照
→ 读取当前值和真实范围
→ 写入安全的正向测试值
→ 回读并记录量化误差
→ 检查完整 develop settings 差异
→ 写入安全的反向测试值
→ 再次回读
→ 回滚
→ 全量回读
→ baseline digest 必须恢复
→ 保存该项证据和检查点
```

逻辑上逐项隔离，执行上由一个自动任务连续完成，不要求人工操作 33 次。每完成一项立即落盘，异常中断后从未完成项继续。

只有同时满足以下条件才标记 `write_probed`：

1. 能读取真实范围和基线；
2. 写入没有报错、静默截断或错误换算；
3. 回读在该参数专属容差内；
4. 没有未声明的关联字段变化；
5. 回滚后完整 baseline digest 恢复；
6. 重新读取仍得到恢复后的值。

失败参数标记为 `unsupported`，记录准确原因；不能用跳过、夹值或重试把失败伪装成通过。

### P4：完成事务矩阵

测试顺序：

1. 33 项单参数隔离测试；
2. 基本色调 6 项事务；
3. 质感 3 项事务；
4. Hue 8 项事务；
5. Saturation 8 项事务；
6. Luminance 8 项事务；
7. 全 33 项安全小幅度事务；
8. Core33 中混入一个范围外参数，证明整单零写入；
9. 写入后人工改照片，再 rollback，必须拒绝覆盖人工编辑；
10. Lightroom 重启后从持久事务恢复并 rollback；
11. 写入中途退出 Lightroom，证明请求不被二次执行。

每次记录：

- before、applied、readback、rollback 值；
- pre/applied/rollback digest；
- snapshot ID；
- transaction ID；
- 参数状态；
- 意外字段 diff；
- 队列终态和日志证据。

硬门禁：33 项中任何一项没有 `write_probed`，不得宣称“Core33 完成”。如果决定临时删掉失败项，必须创建新的 scope ID 和新方案，不得悄悄把 Core33 变成 Core32。

### P5：重写候选配方和预览

旧候选配方不能复用。Native、Amplify、Break 全部重写，只允许 Core33。

- Native：小幅整理曝光、明暗层次、质感和与主体有关的少量 HSL。
- Amplify：强化现有明暗轴、材质和主色/辅色关系。
- Break：使用更强的 HSL 重映射、黑白层次和质感重构；不得使用 Temperature、Color Grading、Calibration、Grain 或曲线冒充效果。

配方规则：

1. 每张照片不需要写满 33 项，只写实际需要的稀疏参数；
2. 参数选择依据 PhotoDNA 的亮度分布、动态范围、纹理、360 度色相直方图、OKLCH 色板、视觉锚点和人物保护；
3. HSL 只调整照片中有可靠色相证据的通道；近中性色不强行归入 HSL；
4. 红、橙及相邻通道涉及人物时必须减弱或进入人物保护；
5. 离线预览不得使用 Lightroom 配方无法表达的操作；
6. 生成配方后立即用 scope allowlist 校验，出现范围外参数则停止在 ANALYZED/PREVIEWED 之前；
7. 旧预览和旧选择全部失效，必须用新 scope 重新渲染和选择。

### P6：完整工作流实机验收

在一张无人物测试 JPG 和一张真实 JPG 上分别执行：

```text
doctor
→ acquire-live
→ analyze
→ render Native/Amplify/Break
→ 用户选择候选和精确强度
→ apply
→ 无人物记录 protect-not-required；有人物按现有 UI 保护流程处理
→ verify/readback
→ done 或 rollback
```

要求：

- 选择前不修改 Lightroom；
- 只写当前候选实际包含的 Core33 参数；
- desired、applied、readback 一一对应；
- 未选择参数保持原值；
- 换片、基线变化、范围外参数和回读不一致全部硬失败；
- 连续 10 轮“预览 → 选择 → 应用 → 回读 → 回滚”无状态残留；
- 30–60 分钟运行无心跳中断、内存持续增长或 Lightroom 崩溃。

### P7：M3 取证与认证

1. 修改受控插件文件后运行范围生成/校验；
2. 运行 `release-plugin.mjs`，同步受控副本并重发 checksum；
3. Node、Python 和契约测试全绿；
4. 对当前构建执行 M2 功能回归，但不重签、不降级现有 M2 证书；
5. 完成 P3–P6 全部实机项目；
6. 生成绑定当前构建和 scope 的 `artifacts/live-evidence/M3.json`；
7. `verify-stages --stage M3` 必须校验现有正式 M2 前序证书；
8. 只接受 `simulated_only:false`、`ok:true` 的 M3 报告；
9. 用户明确确认后，才把正式认证阶段从 M2 宣布为 M3。

## 6. 人工和自动操作边界

### 人工必须做

- 把标准测试 JPG 导入 Lightroom；
- 选中测试 JPG；
- 手动 Start/Stop 桥和执行要求的 Lightroom 完全重启；
- 在三套预览中选择一个方向和强度；
- 人物图时检查人物保护；
- 最终确认是否接受 M3。

### AI、脚本和插件负责

- 生成测试图和 Core33 清单；
- 自动探测 33 项；
- 创建快照、写入、回读、回滚；
- 记录完整证据；
- 生成三套候选；
- 拒绝非 JPG、范围外、未探测和越界请求；
- 验证代码、文档、插件和证据是否一致；
- 生成 M3 报告。

## 7. 完成标准

只有下面全部满足，才能说“JPG Core33 已完成，M3 可认证”：

- M2 正式证书仍有效；
- Reload 双桥问题关闭；
- 运行时参数集合恰好为 33 项；
- 33/33 均有当前构建的 `write_probed` 实机证据；
- 非 JPG 和范围外参数整单零写入；
- 单参数、分组、全 33 项写入/回读/回滚全部通过；
- 旧会话和旧预览不能绕过 scope；
- 三套新候选只使用 Core33；
- 连续 10 轮完整流程通过；
- 稳定性、重启恢复和负向测试通过；
- 代码、文档、scope、checksum、实机证据完全一致；
- M3 报告 `simulated_only:false`、`ok:true`；
- 用户明确确认 M3。

## 8. 最直白的翻译

现在已经正式完成 M2：插件能可靠地看见你选的是哪张照片、读取参数、拿到预览图，并能发现你换了照片或改了基线。

下一步不再碰 82 个参数，也不碰 RAW。这个版本只做 JPG 上的 33 个滑杆：6 个基本色调、3 个质感、24 个 HSL。

实际执行顺序只有七件事：

1. 先修复“Reload 后旧桥不退出”的问题。这个不修，后面的测试都不可信。
2. 用一个唯一清单把插件砍到正好 33 项，其他参数请求一律拒绝。
3. 生成一张专用 JPG 测试图，你只需要导入 LR 并选中一次。
4. 让插件自动测试 33 个滑杆。机器会逐个写、读、恢复，不需要你手动点 33 次。
5. 单个滑杆都通过后，再测试 6 项、3 项、三个 HSL 八项组和完整 33 项事务。
6. 把三套调色方案全部改写，只允许使用这 33 项。旧预览不能继续用。
7. 完整跑 10 轮应用和回滚，生成真实 M3 报告，你确认后才算从 M2 升到 M3。

这次防止方案和代码不一致的方法也很简单：33 项只写在一个权威文件里，Lua、Node、Python、测试和文档都必须由它生成或与它核对。多一个、少一个、证据对不上，发布脚本直接失败。不是靠“记得遵守”，而是代码不一致就根本发不出去。

如果 33 项里有一项实机失败，就不能偷偷跳过后继续叫 Core33。要么修好它，要么重新确定一个新范围、新 scope ID，并重新获得用户确认。

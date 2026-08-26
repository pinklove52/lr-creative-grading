# Lightroom Classic 本地桥方案：可行性重评与可靠实施计划

> 日期：2026-08-17
> 目标环境：Windows 11、Lightroom Classic 15.0.1 产品版本族、Adobe 网络保持离线
> 文档状态：方案评审版；本文件不授权安装或启用任何插件

## 1. 结论

### 1.1 总体判断

桥接目标**有条件可行**，但必须更换主传输架构。

- 可行：读取当前照片、读取开发参数、渲染代理图、应用受 SDK 支持的全局开发参数、回读、快照和回滚。
- 有条件可行：批量事务、曲线、预设强度、自动切换修改照片模块。每个能力都必须在 Lightroom 15.0.1 产品版本族上实机探测后才进入能力表。
- 不应承诺：人物/主体复杂蒙版、画笔、修复、裁切等 SDK 不稳定或不开放的本地编辑；这些继续返回 `ui_required`。
- 不推荐：把当前双端口、长连接 `LrSocket` 实时桥作为生产主通道。
- 推荐：采用**本地文件队列桥**，由 Lightroom Lua 插件轮询用户级目录，Node/MCP 只负责原子写入请求并读取响应。

### 1.2 Go / No-Go

当前决策为 **Go，但只能进入隔离验证阶段**。在第 1～7 阶段全部通过前，不得安装到 Lightroom 自动加载目录，不得接触用户正式目录和正式照片。

## 2. 运行环境契约

桥不能只在抽象的“Lightroom Classic”环境中设计，必须以本机真实环境作为受支持平台。环境不满足时，桥应拒绝写操作，而不是尝试联网、下载组件或猜测兼容性。

### 2.1 当前唯一正式目标环境

| 项目 | 固定条件 |
|---|---|
| 操作系统 | Windows 11 25H2，当前构建 26200；系统更新后需要重新跑兼容性验收 |
| Lightroom | Lightroom Classic 产品版本以 15.0.1 开头；这是首个且当前唯一允许写操作的目标版本族 |
| Lightroom 可执行文件 | `C:\Program Files\Adobe\Lightroom Classic 2026\Lightroom.exe` |
| Lightroom SDK 声明 | 插件使用 `LrSdkVersion = 14.0`；实际能力以 15.0.1 产品版本族宿主实机探测结果为准 |
| Lightroom 网络状态 | Adobe 网络永久离线；不得要求登录、更新、激活、同步或恢复 Adobe 域名访问 |
| 网络代理环境 | Clash Verge TUN、全局模式、Fake-IP DNS；当前由 Clash 接管系统流量 |
| 稳定性规则 | `hbc.adobe.io` 必须保持双层阻断：Windows hosts 为独立主保护，Clash hosts 为 TUN 运行时保护 |
| 插件运行权限 | 标准用户权限；设计、安装、运行和卸载不得依赖管理员权限 |
| Node 环境 | 当前实测 Node.js `v24.18.0`；正式交付要固定最低/最高受支持版本并随包离线校验 |
| 目录策略 | 首轮测试只使用独立测试目录和测试照片副本，不使用正式目录 |

### 2.2 “离线模式”的精确定义

本项目中的离线不是整台电脑断网，而是：

- Lightroom 及桥不得连接任何 Adobe 域名、Adobe API、Creative Cloud 服务或更新服务。
- 地图、云同步、Adobe 登录、在线帮助和其他依赖 Adobe 服务器的功能可以不可用，这是预期状态。
- 桥只允许访问本机文件系统；正式方案不使用 `LrHttp`、外部 HTTP、WebSocket、云端队列或远程鉴权。
- 主机的普通互联网和 Clash 可以继续供其他程序使用，但桥不能依赖它们。
- 本地回环通信即使理论上不经过 Adobe，也不再作为主传输；推荐方案只使用本地文件队列。
- 安装、升级、运行和测试所需文件必须预先存在于本地，运行期间不得通过 npm、Adobe、GitHub 或其他网络来源下载依赖。

### 2.3 Adobe 离线硬约束

以下行为视为设计失败：

- 为了让插件加载或运行而临时恢复 Adobe 联网。
- 修改、删除或绕过 `hbc.adobe.io` 的 Windows hosts 或 Clash 双层阻断。
- 插件启动时探测 Adobe 服务器、登录状态或 Creative Cloud 状态。
- 因网络失败而无限重试、阻塞 Lightroom 主界面或累计后台任务。
- 把地图模块的离线提示误判为桥加载失败。
- 通过 Adobe Exchange、Creative Cloud 或在线安装器完成生产安装。

### 2.4 版本兼容策略

正式桥必须在每次启动时读取并记录：

- Lightroom 完整版本号和 SDK 宿主版本。
- Windows 版本和构建号。
- 插件版本、协议版本、Node 版本和能力表版本。
- 当前目录身份以及是否为批准的测试/生产目录。
- Windows hosts 与 Clash 的双层稳定性规则是否仍存在；只检查本地配置，不主动请求 Adobe 域名。

写能力使用**受限前缀版本白名单**：

```text
Lightroom 产品版本以 15.0.1 开头 + 已验收能力表
  → 允许受支持的写事务

任何其他 Lightroom 版本
  → 自动进入只读安全模式
  → 重新完成环境基线、SDK 能力探测和完整实机验收
  → 验收通过后才能生成新的版本能力表
```

前缀仅放行已验收的 `15.0.1` 产品版本族，不代表整个 15.x 或更高版本兼容。Lightroom、Windows、Clash、Node 或插件协议任一关键版本变化，都必须至少重跑阶段 0、1、3、4 和 7。

### 2.5 环境预检器

在安装、启动和每个写事务前运行只读 `environment-doctor`。它至少检查：

1. Lightroom 路径、文件版本和当前运行进程唯一性。
2. 插件目录是否为本次验收过的版本，SHA-256 是否匹配。
3. Node 版本是否在锁定范围内，运行依赖是否全部位于本地。
4. 队列目录是否位于当前用户 AppData、可读写且 ACL 未异常放宽。
5. `hbc.adobe.io` 的 Windows hosts 与 Clash 双层阻断是否仍存在，不向该域名发起连接测试。
6. 当前 Lightroom 版本是否存在匹配的已签名能力表。
7. 当前目录是否为本阶段允许的测试或生产目录。
8. Windows 最近是否出现 Lightroom 崩溃或应用挂起事件。

输出必须是机器可读 JSON。任何硬检查失败时，MCP 只能报告环境不满足；不得自动修改网络、更新 Lightroom、安装运行库或继续写照片。

### 2.6 离线环境专项测试

除常规测试外，必须覆盖：

- Adobe 域名全部不可达时，插件加载、心跳、读取、应用和回滚均正常。
- `hbc.adobe.io` 的 Windows hosts 与 Clash 双层阻断保持至少 60 分钟，桥不尝试绕过。
- 地图模块离线提示出现或地图不可用时，桥仍能区分自身健康状态。
- Clash 重启、TUN 短暂中断、DNS 改变时，文件队列桥不受影响。
- 断开普通互联网后，桥的全部受支持能力仍能工作。
- AdobeIPCBroker 等 Adobe 后台进程出现或退出时，不将其作为桥依赖。
- 所有依赖缓存清空后，桥不会尝试联网补下载。

通过门槛：桥的功能结果、事务一致性和回滚结果不得因 Adobe 网络永久离线而变化。

## 3. 本次重评依据

### 3.1 已确认事实

1. 当前 Lightroom 的定时崩溃已经独立定位并修复。直接原因是 `hbc.adobe.io` 网络请求收到异常深层 JSON，触发 Lightroom 自身解析器栈溢出；不是桥插件代码栈。
2. 当前实时桥包含约 1,073 行核心 Lua 和 355 行传输 Lua，功能面和状态面都较大。
3. `npm.cmd test` 当前结果为 **25/25 通过**，但这些测试属于 Node Mock、协议契约和源码静态断言，不等于 Lightroom 实机集成通过。
4. 项目 README 已明确记录：当前桥尚未在 Lightroom Classic 15.0.1 中完成实机调用验收。
5. 当前未提交的传输补丁包含固定端口、连接后等待、响应通道回收、断线重新发布描述符等措施。这些补丁说明 Windows 下双单向 `LrSocket` 的连接时序仍不稳定。
6. `lightroom-file-polling-bridge` 目前只完成“菜单点击后写日志”，尚未实现轮询、JSON、SDK 读写或事务。
7. Adobe 官方确认 Lightroom Classic 插件使用内置 Lua SDK，标准插件目录为 `%APPDATA%\Adobe\Lightroom\Modules`，也可以在增效工具管理器中手动添加 `.lrplugin` 目录。

### 3.2 为什么旧方案不能直接继续

旧架构为：

```text
Codex/MCP
  ↕ stdio JSON-RPC
Node 服务
  ↕ 两条 localhost TCP 单向连接
Lightroom Lua 插件
  ↕ Lightroom SDK
当前照片
```

主要风险：

- `LrSocket` 每个实例单向工作，因此需要请求、响应两条连接；连接建立、关闭、重连和 Lightroom 协作式任务调度形成多重时序状态。
- 临时端口、描述符发布、短生命周期 CLI、`CLOSE_WAIT` 和 Lightroom 回调执行时机互相耦合。
- 当前测试模拟的是理想 Socket 对端，不能覆盖 Lightroom Windows 宿主的真实回调顺序。
- 插件在 `LrInitPlugin` 时立即启动复杂后台传输。一旦启动路径异常，插件管理器加载和 Lightroom 稳定性会被绑在一起。
- 传输问题与业务事务代码混在同一插件生命周期中，无法快速区分“插件没加载”“传输没连上”“SDK 操作失败”。

因此，旧实时桥应保留为**实验分支和参考实现**，不再作为可靠版本的部署基础。

## 4. 推荐架构

```text
Codex
  ↕ stdio JSON-RPC
Node MCP 适配器
  ↕ 原子文件请求/响应
用户级队列目录
  ↕ Lightroom Lua 定时轮询
Lightroom SDK 事务执行器
  ↕ 快照 / 预检 / 应用 / 回读 / 回滚
专用测试照片或当前授权照片
```

建议运行目录：

```text
%APPDATA%\Adobe\Lightroom\LrCreativeGradingBridge-v2\
  session.json
  heartbeat.json
  inbox\
  processing\
  outbox\
  failed\
  logs\
```

### 4.1 文件协议

1. Node 将请求写入 `request-id.json.tmp`。
2. Node 完成 `flush/close` 后，将文件原子移动为 `inbox/request-id.json`。
3. 插件先检查文件大小、协议版本、深度、TTL、令牌和 `request_id`，再把它原子认领到 `processing`。
4. 插件只允许单事务执行；处理完成后原子发布 `outbox/request-id.json`。
5. Node 读取并校验响应，然后写入确认标记；插件按保留策略清理已确认文件。
6. Lightroom 或 Node 重启后，依据 `processing` 中的租约和事务日志恢复为“可重试”或“明确失败”，不能静默重复应用。

### 4.2 安全和健壮性限制

- 请求上限：256 KiB；代理图片不进入 JSON，使用独立文件和 SHA-256 摘要。
- JSON 最大嵌套：32 层；解码前先做非递归深度扫描，防止再次出现 JSON 深度炸弹。
- 单会话随机令牌、请求 TTL、唯一 `request_id`、最近请求防重放。
- 每次只处理一个写事务；读请求可排队但不能与写事务交错。
- 所有插件异步入口必须由顶层 `xpcall/pcall` 捕获并写日志，禁止任务静默死亡。
- `heartbeat.json` 每秒更新；Node 在心跳过期时直接报告桥不可用，不继续写请求。
- 不监听端口、不使用系统代理、不访问 Adobe 或其他外部网络。
- 不直接读写 `.lrcat`，不修改原图，不依赖 XMP sidecar。

## 5. 能力分级

| 能力 | 可行性 | 进入正式能力表的条件 |
|---|---:|---|
| 插件加载、状态和日志 | 高 | 连续 5 次启动/退出均正常 |
| 获取当前照片身份 | 高 | 专用测试目录读回一致 |
| 读取开发参数 | 高 | 与 Lightroom UI/SDK 回读一致 |
| 获取 JPEG 代理 | 中高 | 照片不变时摘要稳定；换片时拒绝旧代理 |
| 单个全局参数设置 | 高 | 快照、回读和回滚全部成功 |
| 5～25 个参数事务 | 中高 | 全量预检；任一失败时无部分残留 |
| 曲线 | 中 | 实机格式和回读精度通过后开放 |
| 预设及强度 | 中 | UUID、受保护键和历史行为验证后开放 |
| 单一历史条目 | 中低 | 只能作为最佳努力，不能作为保证 |
| 人物/主体蒙版、画笔、修复、裁切 | 低 | 默认 `ui_required`，不伪装为自动完成 |
| 双 `LrSocket` 长连接 | 技术上可行、可靠性不足 | 仅保留实验用途 |
| 文件队列桥 | 高 | 完成下面全部阶段门槛 |

## 6. 分阶段实施计划

每一阶段都必须由自动化测试完成验收。任何阶段失败，先保留证据并回滚，不要求用户反复手动试错。

### 阶段 0：冻结旧实现与建立基线

工作：

- 将当前 `lightroom-bridge` 标记为 `socket-experimental`，不删除，保留测试和事务业务代码作为参考。
- 运行 `environment-doctor`，记录 Lightroom 15.0.1 产品版本族、Windows 构建、Node、当前 Adobe 离线约束、Windows hosts 与 Clash 中 `hbc.adobe.io` 双层阻断状态和 Windows 事件日志基线。
- 建立独立测试目录、测试目录文件和一张复制的测试照片；不使用正式目录。
- 记录所有当前未提交修改，避免覆盖用户已有工作。

通过门槛：

- 未安装任何桥插件时，Lightroom 连续运行至少 30 分钟。
- 自动切换图库/修改照片模块并确认 `Responding=True`。
- Windows 应用日志没有新的 Lightroom 崩溃或卡死事件。
- Adobe 网络保持离线且 `hbc.adobe.io` 双层阻断未改变。

### 阶段 1：最小加载探针

只实现：

- `Info.lua`。
- 增效工具管理器状态页。
- 一个“写入自检日志”的菜单项。
- 明确的插件版本、启动时间和关闭标记。

此阶段**不包含** `LrInitPlugin` 后台循环、Socket、JSON 和开发参数操作。

通过门槛：

- 插件在增效工具管理器中显示“已安装并正在运行”。
- 菜单可见，日志路径正确。
- 连续执行 5 次“加载 → 自检 → 重新载入 → 退出 Lightroom”，均无崩溃、无残留后台状态。
- 卸载后重新启动，插件完全消失且 Lightroom 正常。

### 阶段 2：只读文件传输

加入：

- 文件队列目录创建。
- `session.json`、心跳、原子请求认领和响应发布。
- 仅支持 `ping`、`capabilities`、`status`。
- JSON 大小、最大深度、协议版本、令牌、TTL 和防重放校验。

故障注入：

- 半写入 `.tmp` 文件。
- 超大请求。
- 33 层以上 JSON。
- 重复 `request_id`。
- Lightroom 在 `processing` 中途退出。
- Node 在响应发布前后退出。

通过门槛：

- 100 次 `ping` 全部成功，无丢失、重复或乱序。
- 所有异常输入都被拒绝且 Lightroom 保持响应。
- Lightroom/Node 各重启 10 次，队列能够恢复且不重复执行。

### 阶段 3：只读 Lightroom SDK

逐个加入：

1. `get_target_photo`。
2. `get_settings`，先读取 5 个基础参数。
3. `get_proxy`。
4. 完整参数能力探测。

通过门槛：

- 换片、换目录、修改照片后，目标和编辑摘要能正确变化。
- 代理渲染期间换片时返回 `TARGET_MISMATCH` 或 `PROXY_STALE`。
- 连续 100 次只读调用，Lightroom 无卡顿、无任务静默终止。
- 不产生任何目录写事务或照片修改。

### 阶段 4：单参数可逆事务

只在测试照片的虚拟副本上测试一个低风险参数，例如曝光。

固定顺序：

```text
验证目标
→ 读取完整基线
→ 创建开发快照
→ 再次验证目标和基线
→ 设置一个参数
→ 回读
→ 回滚
→ 再次回读并比较完整基线
```

通过门槛：

- 应用值在容差内一致。
- 回滚后完整开发设置与基线一致。
- 在每一个步骤注入失败，均不存在未报告的部分修改。
- 快照失败时必须拒绝写入，不能自动降级后继续。

### 阶段 5：受控批量事务

扩展顺序：

1. 3 个基础参数。
2. 5 个基础参数。
3. 经过能力探测的 20～25 个参数。
4. 最后单独验证曲线和预设，不与基础参数首轮混合。

通过门槛：

- 所有参数在写入前完成范围与支持性预检。
- 不支持的参数整单拒绝或明确列入 `unsupported`，不能静默忽略。
- 中途失败自动回滚；回滚失败必须成为最高级别错误并停止后续任务。
- 连续 30 次“应用 → 回读 → 回滚”后，基线无漂移。

### 阶段 6：MCP 适配

- 保留 stdio MCP 层和现有七个工具语义。
- 将 `LightroomSocketTransport` 替换为 `LightroomFileQueueTransport`。
- MCP stdout 继续只输出 JSON-RPC；日志只写 stderr 和诊断文件。
- `apply_transaction` 继续只接受完整、已选择且摘要一致的 GradeSession。

通过门槛：

- 现有 25 个测试保持通过。
- 为文件传输、重启恢复、超时和故障注入增加独立测试。
- Mock 测试之外，七个工具全部通过测试目录实机调用。

### 阶段 7：稳定性和压力验收

必须自动执行：

- 60 分钟空闲运行。
- 100 次只读请求。
- 30 次单参数应用/回滚。
- 10 次多参数应用/回滚。
- 10 次 Lightroom 重启后的自动恢复。
- 测试过程中切换图库/修改照片模块。
- 同时采集进程存活、`Responding`、内存、CPU、插件心跳和 Windows 事件日志。

通过门槛：

- 0 次 Lightroom 崩溃。
- 0 次 Lightroom 应用挂起事件。
- 0 个未确认请求。
- 0 个重复写事务。
- 0 个回滚后基线不一致。
- 内存不能持续单向增长；心跳不能无故中断。

### 阶段 8：受控部署

只有阶段 0～7 全部通过后：

- 生成版本化只读安装包和 SHA-256 清单。
- 先从版本化暂存目录通过增效工具管理器加载，不直接复制到自动加载目录。
- 生产目录第一次只开放只读工具。
- 写事务需要单次明确授权，并默认先创建快照。
- 再完成一轮 30 分钟生产环境只读验收，才开放受支持的写能力。

## 7. 自动化与证据要求

每次验收必须产生机器可读报告：

```text
artifacts/bridge-v2/<run-id>/
  environment.json
  offline-contract.json
  plugin-load.json
  transport-results.json
  sdk-capabilities.json
  transaction-results.json
  soak-results.json
  windows-events.json
  checksums.txt
  summary.md
```

报告至少包含：Lightroom/Windows/Node/Clash 环境版本、Adobe 离线契约检查、测试照片摘要、插件哈希、请求数、成功数、拒绝数、超时数、回滚结果、进程运行时长和崩溃/挂起事件数。

测试程序应自行启动、观察和关闭测试实例；阶段内不把每个局部修改交给用户手动验证。

## 8. 回滚方案

### 插件级回滚

- 所有安装都使用版本化目录，不覆盖旧目录。
- 安装前备份当前增效工具清单和目标目录。
- 回滚时先从增效工具管理器停用，再将确切版本目录移动到恢复目录。
- 删除或移动插件后，确认队列心跳停止、菜单消失、Lightroom 重启正常。

### 事务级回滚

- 每个写事务必须有唯一事务 ID、完整基线和开发快照。
- 目标照片或编辑摘要变化时拒绝回滚，防止覆盖用户后续手工修改。
- 自动回滚后必须再次读取并比较完整基线；不能只根据 API 无异常就判定成功。

### 桥进程级回滚

- MCP 注册使用独立名称和版本；不覆盖其他 MCP。
- 停用 MCP 后，文件队列插件仍应只保持心跳，不能自行执行旧请求。
- 过期请求在重启后进入 `failed`，不得重新应用。

## 9. 明确禁止事项

- 不恢复或依赖 Adobe 联网。
- 不移除当前 `hbc.adobe.io` 的 Windows hosts 或 Clash 稳定性阻断。
- 不直接编辑 `.lrcat` 数据库。
- 不在正式照片上进行首轮写测试。
- 不把 Mock/静态测试通过等同于 Lightroom 实机通过。
- 不在插件加载阶段启动未经验证的复杂传输。
- 不为绕过失败而增加无限重试、无限等待或静默忽略。
- 不声称 SDK 未支持的局部编辑已经自动完成。
- 不在每修一个局部问题后要求用户重复操作；阶段验收由自动化完成。

## 10. 交付物

可靠版本至少应交付：

1. `FileQueueBridge.lrplugin`：最小 Lua 插件。
2. `LightroomFileQueueTransport`：Node 传输实现。
3. 固定协议及 JSON Schema。
4. 参数能力探测器和版本化能力表。
5. 专用测试目录与测试照片副本说明。
6. 单元、故障注入、实机集成和稳定性测试。
7. 干运行默认的安装器、卸载器和回滚器。
8. 每次验收的 Markdown 与 JSON 报告。
9. `environment-doctor`、版本能力白名单和 Adobe 离线契约检查器。

## 11. 最终成功标准

只有同时满足以下条件，桥方案才算成功：

- Lightroom 能识别并稳定加载插件。
- 在 Lightroom 15.0.1 产品版本族和当前 Windows/Clash 环境中，不需要 Adobe 网络或任何外部服务。
- Adobe 网络永久离线、`hbc.adobe.io` 双层阻断持续生效时，全部受支持能力和回滚结果不变。
- Lightroom 或其他关键环境版本变化时，桥会自动降级为只读而不是继续写入。
- 七个 MCP 工具对受支持能力完成实机验收。
- 所有写操作先预检、可回读、可回滚。
- 60 分钟稳定性测试和故障注入全部通过。
- 卸载后 Lightroom 恢复为无插件状态，不留下后台进程、端口或待处理请求。
- 正式使用时，任何不确定状态都选择拒绝操作，而不是冒险修改照片。

## 参考

- [Adobe Lightroom Classic Developer](https://developer.adobe.com/lightroom-classic/)
- [Adobe：Lightroom Classic 插件结构与安装说明](https://blog.developer.adobe.com/en/publish/2022/07/lightroom-classic-plugin-support-for-the-adobe-exchange-for-creative-cloud)
- 本地现有方案：`lightroom-bridge/README.md`
- 本地文件原型：`lightroom-file-polling-bridge/README.md`

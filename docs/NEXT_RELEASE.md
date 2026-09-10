# Next SDK release: connect a conversation to the right business systems

[简体中文](#简体中文)

**Unreleased source.** Planned pairing: Core 0.7.0, SDK 0.5.0 and DSH 0.5.0, subject to release checks. Published Core 0.6.1 and SDK/DSH 0.4.0 do not contain these additions. Package metadata remains at the published baseline until release preparation is complete.

## A shop and inventory example

In an Agent Client built with this SDK, a user selects a shop and an inventory authorization, then asks:

> “Check tumbler stock. If available, change the corresponding shop product's price to 59 and list it.”

The previous release supports multiple accounts within one system. The new SDK gives a host the transport and identity checks needed for different systems on one Hub: inventory lookup uses the original inventory connection; shop writes use the original shop connection. The host still owns scope selection, planning and its UI. This does not turn the standalone MCP server into a multi-system conversation UI.

The example requires exposed business APIs and a confirmed product mapping. Stock lookup does not reserve stock or synchronize the systems. Existing write permissions and approvals apply; pending listing approval must not be called a successful listing.

## What changed

- **New cross-system archive negotiation and binding guards.** The host can associate distinct original Agent Sessions from different Client Apps/workspaces on one Hub. Lookup, execution and retry cannot substitute a default, renamed alias or replacement Session for the intended target.
- **New system descriptions before capability search.** Hosts can explain that the shop handles selling while inventory handles stock. These descriptions neither send user text nor open business runs; they do not prove a tool is authorized or already loaded.
- **New business-supplied authorization names.** For example, show “Shop system · Brand flagship store” after approval. Login/status/list views carry optional display data, separate from the internal connection key. Renames, duplicates and cache failures do not change authorization or archive identity.
- **Improved cancellation at the HTTP boundary.** A cancellation before dispatch sends no business request. An invocation already dispatched with an unknown outcome retains its original invocation identity; it is not automatically replayed.
- **Preserved conversation history.** Original event IDs, acknowledgements and execution links remain the retry source. Archive retries never repeat business writes.

## Integration and upgrade preparation

Stable users can retain SDK 0.4.0 with Core 0.6.1. Source integration must use matching Core, SDK and host revisions and record their commits; a version number shared with a released package is not proof of the new implementation.

1. Prepare the matching Core, including migrations 058/059 for the combined feature set. The SDK does not deploy or migrate the Hub.
2. Keep explicit per-conversation selection and the original connection, Hub, app, workspace and Agent Session binding. Restore original records, not today's defaults. A custom host must enforce scope and preserve its real visible history.
3. Read selected systems' descriptions and display names through SDK results. Keep missing, unsupported and cached data explicit; never select credentials by a business name.
4. Negotiate cross-system archive support before registering it. Retain original event/turn IDs and acknowledgement progress. Missing support disables that new mode, not the existing same-system APIs.
5. Check one inventory read and one allowed shop action, actual target ownership, unchanged permissions, cancellation and archive-only retry. Separate local history errors from display-cache errors.

Business backends need no new action declarations just to use multiple systems. To provide names or integrate proactive revocation, adopt the matching Core/business SDK interfaces. That server-side work is separate from this package.

Only after Core is released should this SDK receive its final version and public package. DSH can then pin that exact SDK version and regenerate its registry lockfile. Until then, source compatibility is not a published installation claim.

## Limits and details

One Hub/audit domain, distinct original Sessions, no implicit product mapping, no distributed transaction or durable business task engine. Hosts own the selected scope and persistence. Combined visible text belongs to the administrator audit domain, not an individual authorization's memory or a new transcript-read API for the Agent.

See [SDK contract](AGENT_CLIENT_SDK.md), [compatibility](COMPATIBILITY.md), [release procedure](RELEASING.md) and the [Core scenario guide](https://github.com/bailinghub/bailinghub/blob/main/docs/RELEASE_NOTES_NEXT.en.md).

## 简体中文

**这是未发布源码说明。** 计划配套 Core 0.7.0、SDK 0.5.0、DSH 0.5.0，须经正式发布检查；公开 Core 0.6.1 与 SDK/DSH 0.4.0 不包含这些增量。当前包元数据暂保留原发布基线。

### 场景与原问题

用户在使用本 SDK 的客户端选定商城和库存系统授权，然后说：“先查保温杯库存，有货再把商城对应商品改为 59 元并上架。”以前配套只支持同一系统多个账户；本次 SDK 为不同系统提供对应连接的传输和身份检查，查库存用原库存授权，改价上架用原商城授权。选择界面、会话范围与规划仍由宿主负责，独立 MCP Server 不会因此自动多出跨系统会话界面。

业务系统须已开放相关 API，并已确认商品对应关系。库存查询不等于锁库存或自动同步；商城原有写入权限和审批继续生效，待审批不能算已上架。

### 本次新增与改进

- 支持同 Hub 不同 Client App/workspace 的独立 Session 关联归档；请求前检查固定绑定，默认连接、别名或替换后的 Session 不能冒充原目标。
- 在首次能力搜索前读取所选系统用途，分清商城负责售卖、库存系统负责库存；介绍不发送用户正文、不创建业务 run，也不授予权限。
- 在 login/status/list 结果中提供业务授权主体名称，例如“商城系统 · 品牌旗舰店”；名称、内部连接键和缓存状态独立，同名、改名或缓存失败不改变授权与归档身份。
- 将取消传递到实际 HTTP 请求边界。发送前取消不请求业务；发送后结果未知保留原调用身份，不自动重放。
- 沿用原事件、确认游标和执行关联补传会话；归档重试不重复业务写入。

### 如何准备升级

稳定用户可继续使用 SDK 0.4.0 + Core 0.6.1。源码联调需匹配三个组件并记录提交，不能仅凭相同包版本判断支持。

先准备包含 058/059 的配套 Core，SDK 不负责部署或迁移。宿主继续显式选定会话范围，保存原连接、Hub、应用、工作区、Agent Session 与真实可见事件；恢复时不使用当前默认授权重建。通过返回值展示系统说明与主体名称，明确缺失、不支持与缓存状态，名称不能用于选择凭据。

跨系统归档先协商，再注册，保留原事件身份与确认进度。不支持新模式时明确提示，原同系统 API 保留。用一次库存查询、一次允许的商城动作核对目标、原审批、取消和仅重试归档的结果；正文保存错误不能被名称缓存状态盖过。

已有业务动作无需为多系统会话重写声明；名称提交与主动撤销由业务后端对接 Core/业务 SDK，独立于本包。正式发布先 Core、再本 SDK，SDK 可公开安装后 DSH 才锁定新依赖并生成注册表锁文件。

范围限同 Hub、同审计域的独立原 Session，不提供自动商品映射、跨系统事务或持久业务任务引擎。完整正文保留在管理审计域，不回灌各授权记忆。见[SDK 契约](AGENT_CLIENT_SDK.zh-CN.md)、[兼容说明](COMPATIBILITY.md)、[发布流程](RELEASING.md)和[Core 场景说明](https://github.com/bailinghub/bailinghub/blob/main/docs/RELEASE_NOTES_NEXT.md)。

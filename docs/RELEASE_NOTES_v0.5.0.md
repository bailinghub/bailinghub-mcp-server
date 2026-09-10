# SDK 0.5.0: connect a conversation to the right business systems

[简体中文](#简体中文)

**Release line: Core 0.7.0 + SDK 0.5.0; matching DSH adapter: 0.5.0.** Core 0.6.1 and SDK/DSH 0.4.0 do not contain the cross-system, system-description and authorization-name additions below. Upgrade in Core → SDK → host order and verify each exact package is available before upgrading its consumer.

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

## How to upgrade

Existing same-system integrations may retain SDK 0.4.0 with Core 0.6.1. For the new features, upgrade the Hub to Core 0.7.0 first, then install the exact SDK dependency:

```bash
npm install --save-exact bailinghub-mcp-server@0.5.0
```

Commit the updated package manifest and lockfile, rebuild the host, and preserve its connection registry, credentials, original session scopes and archive outbox. A DSH user upgrades the matching host package instead of copying SDK files.

1. Follow the Core 0.7.0 upgrade procedure, including migrations 058/059 for the combined feature set. Back up Core and host persistence before upgrading; the SDK does not deploy or migrate the Hub.
2. Keep explicit per-conversation selection and the original connection, Hub, app, workspace and Agent Session binding. Restore original records, not today's defaults. A custom host must enforce scope and preserve its real visible history.
3. Read selected systems' descriptions and display names through SDK results. Keep missing, unsupported and cached data explicit; never select credentials by a business name.
4. Negotiate cross-system archive support before registering it. Retain original event/turn IDs and acknowledgement progress. Missing support disables that new mode, not the existing same-system APIs.
5. Check one inventory read and one allowed shop action, actual target ownership, unchanged permissions, cancellation and archive-only retry. Separate local history errors from display-cache errors.

Business backends need no new action declarations just to use multiple systems. To provide names or integrate proactive revocation, adopt the matching Core/business SDK interfaces. That server-side work is separate from this package.

Release maintainers publish Core first, then SDK 0.5.0. DSH 0.5.0 must use an exact normal dependency on SDK 0.5.0 and a public-registry lockfile. A GitHub source checkout alone is not proof that a package is available from npm.

## Limits and details

One Hub/audit domain, distinct original Sessions, no implicit product mapping, no distributed transaction or durable business task engine. Hosts own the selected scope and persistence. Combined visible text belongs to the administrator audit domain, not an individual authorization's memory or a new transcript-read API for the Agent.

See [SDK contract](AGENT_CLIENT_SDK.md), [compatibility](COMPATIBILITY.md), [release procedure](RELEASING.md) and the [Core scenario guide](https://github.com/bailinghub/bailinghub/blob/v0.7.0/docs/RELEASE_NOTES_v0.7.0.en.md).

## 简体中文

**配套发布线：Core 0.7.0 + SDK 0.5.0；对应 DSH 适配器为 0.5.0。** Core 0.6.1 与 SDK/DSH 0.4.0 不包含下述跨系统、系统说明和授权名称增量。按 Core → SDK → 宿主顺序升级，每一步先确认精确版本已经可安装。

### 场景与原问题

用户在使用本 SDK 的客户端选定商城和库存系统授权，然后说：“先查保温杯库存，有货再把商城对应商品改为 59 元并上架。”以前配套只支持同一系统多个账户；本次 SDK 为不同系统提供对应连接的传输和身份检查，查库存用原库存授权，改价上架用原商城授权。选择界面、会话范围与规划仍由宿主负责，独立 MCP Server 不会因此自动多出跨系统会话界面。

业务系统须已开放相关 API，并已确认商品对应关系。库存查询不等于锁库存或自动同步；商城原有写入权限和审批继续生效，待审批不能算已上架。

### 本次新增与改进

- 支持同 Hub 不同 Client App/workspace 的独立 Session 关联归档；请求前检查固定绑定，默认连接、别名或替换后的 Session 不能冒充原目标。
- 在首次能力搜索前读取所选系统用途，分清商城负责售卖、库存系统负责库存；介绍不发送用户正文、不创建业务 run，也不授予权限。
- 在 login/status/list 结果中提供业务授权主体名称，例如“商城系统 · 品牌旗舰店”；名称、内部连接键和缓存状态独立，同名、改名或缓存失败不改变授权与归档身份。
- 将取消传递到实际 HTTP 请求边界。发送前取消不请求业务；发送后结果未知保留原调用身份，不自动重放。
- 沿用原事件、确认游标和执行关联补传会话；归档重试不重复业务写入。

### 如何升级

已有同系统集成可继续使用 SDK 0.4.0 + Core 0.6.1。使用新能力时，先把中枢升级到 Core 0.7.0，再安装精确依赖：

```bash
npm install --save-exact bailinghub-mcp-server@0.5.0
```

提交更新后的依赖清单与锁文件，重新构建宿主，并保留原连接注册表、凭据、固定会话范围和归档待传队列。DSH 用户升级对应宿主包，不手动复制 SDK 文件。

按 Core 0.7.0 升级说明执行，包括本批能力涉及的 058/059 迁移；升级前备份 Core 与宿主持久资料，SDK 不负责部署或迁移。宿主继续显式选定会话范围，保存原连接、Hub、应用、工作区、Agent Session 与真实可见事件；恢复时不使用当前默认授权重建。通过返回值展示系统说明与主体名称，明确缺失、不支持与缓存状态，名称不能用于选择凭据。

跨系统归档先协商，再注册，保留原事件身份与确认进度。不支持新模式时明确提示，原同系统 API 保留。用一次库存查询、一次允许的商城动作核对目标、原审批、取消和仅重试归档的结果；正文保存错误不能被名称缓存状态盖过。

已有业务动作无需为多系统会话重写声明；名称提交与主动撤销由业务后端对接 Core/业务 SDK，独立于本包。发布顺序为 Core、SDK 0.5.0、DSH 0.5.0；DSH 使用 SDK 0.5.0 精确普通依赖及公开注册表锁文件。GitHub 已有源码不等于 npm 已有可安装包。

范围限同 Hub、同审计域的独立原 Session，不提供自动商品映射、跨系统事务或持久业务任务引擎。完整正文保留在管理审计域，不回灌各授权记忆。见[SDK 契约](AGENT_CLIENT_SDK.zh-CN.md)、[兼容说明](COMPATIBILITY.md)、[发布流程](RELEASING.md)和[Core 场景说明](https://github.com/bailinghub/bailinghub/blob/v0.7.0/docs/RELEASE_NOTES_v0.7.0.md)。

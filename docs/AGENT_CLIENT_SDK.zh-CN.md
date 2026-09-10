# BailingHub Agent Client SDK

[English](AGENT_CLIENT_SDK.md) | 简体中文

0.5.0 让配套宿主使用同一中枢下不同系统的明确选定授权。例如，先查库存，再修改商城对应商品的价格
并上架，每一步使用对应系统的原授权与审批规则。受控系统说明和业务主体名称帮助宿主在搜索工具前
说明操作目标；0.4.0 引入的对话归档继续把可见消息关联到各项原始业务动作。

使用这批新能力时，安装下方精确 SDK 版本，并配合 BailingHub Core 0.7.0。客户端负责显式选择范围、
保存可见消息和断线补传；SDK 不会自动增加账号选择界面，也不会自行记录聊天。
原 Client Token、浏览器授权、业务调用和恢复 API 继续兼容。

`bailinghub-mcp-server/sdk` 是本地智能体框架的宿主无关接入层。它统一负责浏览器授权、PKCE、
连接元数据、Agent Session 安全存储、Token 刷新和 BailingHub Runtime DTO 映射。宿主适配器只负责
自己的生命周期、模型调用、可见会话 ID 和动态工具注册。

SDK 不内嵌 BailingHub，不替开发者注册业务系统，不自动生成业务授权页，也不保存模型提供方凭据。
宿主不填写业务系统 URL；Core 会按 `clientAppId` 解析已经登记的唯一授权入口。

## 安装与兼容

安装与 Agent Client 发布线匹配的 SDK 包：

```bash
npm install --save-exact bailinghub-mcp-server@0.5.0
```

公开宿主适配器应使用精确普通 dependency，并在 npm Registry 能解析到 `0.5.0` 后发布。
不要在公开 manifest 中改用本机路径。

服务端需要具备 Agent Auth v1、Agent Client Runtime v1、route 的 `tools.agent_direct` /
`agent_client` 配置，以及已登记的公开 Client App ID 与业务授权页。

同绑定归档接口最低需要 Core 0.6.0；跨系统归档、受控系统说明与授权主体名称配套 Core 0.7.0，
并按接口协商支持情况。按 [0.5.0 升级步骤](RELEASE_NOTES_v0.5.0.md#简体中文)执行，包括 Core 的
058/059 迁移及原宿主凭据、固定范围和归档待传队列保留。低于归档接口最低版本的 Core
可以继续使用已有 Agent Auth/Runtime 功能；
归档接口不支持时应显示该限制，不能宣称正文已保存，也不能为修复归档重新执行业务动作。

旧 Client Token/MCP Job 模式是独立兼容路径。Agent Client 宿主不需要
`BAILINGHUB_CLIENT_TOKEN`。

## 配置归属

### 授权主体展示信息（0.5.0）

此可选能力用于显示 **用户实际确认了哪个授权对象**，避免授权后再手填一遍名称。例如，将独立的
系统说明与授权名称组合成“项目协作系统 · 示例团队”。开发者的授权主体可以是组织、团队、项目、
账号、经营场所或其他业务对象；上游不把它限定为门店，也不要求 `store_name`。

业务授权后端根据用户实际确认的主体读取真实名称，在批准授权时提交
`subject_display: { name: '示例团队' }`。Core 将其与 `principal`、`on_behalf_of`、权限和系统说明分别
维护。Core 0.7.0 会在换码和 Session 查询中返回 `subject_display`、`subject_display_status`。
展示对象只允许 `name`：先检查原始字符串，拒绝 C0/C1 控制符及 U+2028/U+2029，再 trim；
非空且最多 120 个 JavaScript UTF-16 码元。名称是展示数据，不是指令。
未配对的 UTF-16 代理项属于无效文本；有效 emoji 等字符仍可使用。

`login()`、`status()` 和 `connectionsList().connections` 的每行返回：

| 字段 | 含义 |
| --- | --- |
| `subjectDisplay` | `{ name: string }` 或 `null`；不从本机别名、principal、设备名称或系统说明推测 |
| `subjectDisplayStatus` | `provided`：Core 返回有效名称；`missing`：支持此能力但该授权尚无名称；`unsupported`：Session 响应缺少此能力；`unavailable`：尚未读取、可选数据无效或缓存不可用 |
| `subjectDisplaySource` | `verified`：本次从身份校验通过的 Session 读取；`cache`：之前保存的展示数据；`none`：没有可用的展示响应 |
| `subjectDisplayCacheStatus` | `saved`、`not_cached` 或 `storage_error`；独立于授权结果 |
| `subjectDisplayCachedAt` | 有缓存时的读取保存时间，不代表授权有效期或当前仍有效 |

底层 `AgentAuthHttpClient` 换码结果使用 `subjectDisplay` / `subjectDisplayStatus`；Session 结果沿用
`subject_display` / `subject_display_status`。旧 Core 缺字段明确返回 `unsupported`；可选展示字段无效
返回 `unavailable`，不把有效 Token 或 Session 变成登录失败。身份失效和绑定不符仍按原规则报错；
缓存名称绝不能放行业务工具。

名称保存在连接注册表旁独立的 mode-0600 缓存文件中，与原 connectionKey、Hub、Client、workspace
和 Agent Session 全部绑定，不改变凭据或注册表格式。`connectionsList()` 只读本地数据，不请求 Hub，
返回名称时明确标记 `cache`；旧安装没有缓存时为 `unavailable`，不猜名称，也不假装已经检查旧 Core。
调用 `status({ connectionKey })` 重新核验原 Session 并刷新名称，原 expectedBinding 和取消规则保持。

凭据存储仍是登录的主结果，可选名称缓存发生在其后。缓存失败时，登录仍返回
`state: 'authorized'` 和 `subjectDisplayCacheStatus: 'storage_error'`，不能引导用户重复授权；
之后重试 status 即可。status 的网络或授权错误不能被缓存名称覆盖为“已授权”。

宿主可取消界面的“连接备注”输入，按纯文本显示返回名称。内部 `connectionKey` 和原 `connectionName`
仍独立保存，不用名称查找、去重、改写或替换连接。同名、改名都不能改变身份、固定会话范围、
调用记录或归档关联。向模型说明业务对象时，应把名称作为不可信数据引用，不能作为系统指令或权限依据。

已有授权返回 `missing` 时可显示通用文案 **授权名称待同步**；业务宿主可替换为自己的业务术语。
原业务后端可通过 Client Token 保护的
`PUT /agent-auth/v1/sessions/{session_id}/subject-display` 提交
`{ subject_display: { name: '新的团队名称' } }`，在不换授权的情况下补充或更新名称。
Agent SDK 只通过 status 读取更新，不持有 Client 凭据，也不开放写名接口。原会话范围、业务能力声明
和审批规则不需要调整。

此可选能力包含在 SDK 0.5.0 + Core 0.7.0 中。旧 Core 响应仍可读取，并明确显示不支持；
名称数据不决定授权是否有效。

### 宿主连接配置

```js
import { createAgentClientTransport } from 'bailinghub-mcp-server/sdk';

const transport = createAgentClientTransport({
  hubUrl: 'https://hub.example.com',
  clientAppId: 'merchant-agent',
  workspace: 'order-assistant',
  connectionName: 'default',
});
```

| 字段 | 含义 | 是否秘密 |
|---|---|---|
| `hubUrl` | 部署者自己的 BailingHub 公开 HTTPS 根地址 | 否 |
| `clientAppId` | 中枢管理员登记的公开 `app_id` | 否 |
| `workspace` | 初始 BailingHub route key | 否 |
| `connectionName` | 本机可读选择器；不是业务身份声明 | 否 |

宿主配置不得新增 BailingHub Client Token、管理 Token、业务密码/Cookie、Tool Provider Secret、
业务 API 地址、业务授权页地址、模型 API Key 或 Agent access/refresh token。模型和模型 Key 仍由宿主
自己的凭据系统管理。

### 宿主拥有的本机存储命名空间

同一个操作系统用户下，如果某个产品专属宿主可能和其他 Agent Client 宿主同时运行，应在 SDK
dependency options 中设置一个固定的本机存储命名空间：

```js
const transport = createAgentClientTransport({
  hubUrl: 'https://hub.example.com',
  clientAppId: 'merchant-agent',
  workspace: 'order-assistant',
  connectionName: 'default',
}, {
  storageNamespace: 'my-product-desktop',
});
```

等价的宿主进程环境变量是
`BAILINGHUB_AGENT_CLIENT_STORAGE_NAMESPACE=my-product-desktop`。两处同时设置时必须完全一致，
否则启动失败关闭。这个值是非秘密的宿主常量，不是第五个用户连接字段、业务身份、模型输入，也不会
发给 Core。宿主适配器不得允许模型或会话修改它。

命名空间必须是 1 至 64 位小写标识，只能使用 `a-z`、`0-9`、`.`、`_`、`-`，并以字母或数字开头。
SDK 会先哈希再使用，并同时隔离连接注册表、POSIX 凭据文件、macOS Keychain account、Windows
DPAPI 路径与附加熵，以及本机锁作用域。未设置时，历史 POSIX 路径与 Keychain account 保持完全
不变，以保证向后兼容。

命名空间不会在宿主之间复制或迁移凭据。因此宿主首次采用新命名空间时，会从空的本机注册表开始，
并需要正常完成一次浏览器授权。不要通过复制凭据文件、DPAPI 密文或 Keychain 记录绕过边界；停用旧宿主连接时，
应由匹配的旧宿主正常撤销并删除。注入自定义注册表或凭据路径的高级宿主，需要自行确保这些覆盖路径
仍位于同一个命名空间边界内。

## 多连接生命周期

本节 API 从 `0.3.0` 引入，在 `0.5.0` 中保持兼容。宿主适配器应精确依赖 SDK 版本，并把连接管理保留在用户掌控的
命令或设置界面中。宿主可以发布可用授权引用，供模型按次选择，再由宿主按下文固定映射到连接。
登录、连接管理、身份和凭据不能成为模型控制的输入。

SDK 注册表可以同时保存多个具名连接实例，`connectionName` 只是本机选择器。浏览器授权完成后，
SDK 会在相同 `Hub + clientAppId + workspace` 公开绑定内，使用 Core 返回的可信
`on_behalf_of` 对账：同一身份的新 Session 会替换旧本机连接，不同身份则分别保留 Agent Session、
隔离凭据与撤销生命周期。注册表和这些方法都不会返回 access/refresh token：

```js
await transport.connectionsAdd({
  connectionName: 'shop-a',
  hubUrl: 'https://hub-a.example.com',
  clientAppId: 'merchant-agent',
  workspace: 'order-assistant',
});

await transport.connectionsList();
await transport.connectionsUse('shop-a');
await transport.login({ connectionName: 'shop-a' });
await transport.connectionsRemove('shop-a');
```

`connectionsAdd()` 在名称尚不存在时创建一个新的本机实例，只登记公开元数据并选为当前项，
不会伪造、复制登录。相同名称与相同绑定重复添加是幂等选择；相同名称改绑其他公开元数据会失败。
每个尚未授权的新选择器都要完成浏览器授权。`connectionsUse()` 只切换本机当前选择。宿主必须把这些入口
放在用户命令或设置界面中，不能投影为模型工具。每个 run 和 invocation 必须继续使用创建时固定的实例；
切换 current 只影响以后捕获连接时的默认项，不改变会话中已经公开的授权引用。

`connectionsRemove()` 在有登录时先撤销远端 Agent Session，成功后才删除本地凭据与公开元数据。
远端撤销失败时，连接与凭据原样保留以便重试。它不同于 `use(workspace)`：前者选择或删除一整套
连接实例，后者让同一个实例在当前业务授权已经允许的范围内改绑另一个 workspace；它不会把一套
已授权身份变成另一套身份。
如果删除的是 current 连接，同一次原子注册表变更会选择剩余条目中不透明 connection key
按字典序最小的一项。只有删除最后一项时才返回 `currentConnectionKey: null`。fallback 只影响
新会话；已经开始的会话与 run 仍固定使用创建时捕获的连接。

已有确定性 v1 注册表连接继续可读，并保持原凭据 key。只有至少存在一个具名实例时，注册表
才写为 schema v2；其中的实例 ID 只是本机不透明元数据，不是凭据，也不会作为身份声明发送给 Core。
早于 `0.3.0` 的 SDK 遇到 schema v2 会失败关闭。降级到这些版本前，必须使用已安装的 `0.3.0` 或
`0.4.0` 或更新版本逐一撤销并删除具名实例；最后一个
实例删除后注册表会重新写为 schema v1。不要手工删除凭据文件、DPAPI 密文或 Keychain 记录。

### 同一系统内按次选择授权引用

宿主可以复用现有 API，在相同 `Hub + clientAppId + workspace` 下同时使用两份独立身份授权，
无需切换 current。宿主决定本会话可用哪些授权，并分配 `store_a`、`store_b` 这样的安全引用和
用户认可的展示名称。引用不是凭据、`on_behalf_of` 或新的 Core 字段。不要把原始 `status()` 结果
交给模型。`connectionsList()` 的 `authorized` 只表示本地存在凭据；是否可执行仍取决于 Session
检查和 Core 授权校验。

宿主将每个引用一次性解析为不透明 `connectionKey` 与固定 `workspace`。将这两个字段作为
`startTurn`、`searchCapabilities`、`invoke`、`completeRun` 的第二参数，或 `resume` 的第三参数。
即使两份授权返回相同工具声明和 revision，也分别保存 run、capability revision、active tools 和恢复状态。
续执行不能重新解析可能变更的别名或 current；原连接被删除、撤销或改绑后必须失败关闭，不能回退到另一身份。

工具名称、输入 schema 和公开治理属性一致时，宿主可以只展示一份 typed 工具，模型输入使用外层封装：

```json
{"authorization_ref":"store_a","arguments":{"id":42,"name":"Updated product"}}
```

外层两个字段必填，并拒绝额外字段；`authorization_ref` 枚举只包含该工具可用的授权引用，
`arguments` 保留原始业务 schema。宿主校验并消费引用后，只把内层 `arguments` 连同对应授权的
run、revision 交给 SDK。声明不一致时不要合并为这份共享展示。连接管理继续放在模型工具之外。
每个 `invocation_id` 都要与创建时捕获的授权一起保存，审批恢复、结果未知和重试始终沿用原身份与
原 invocation。本节是使用现有 SDK 方法的宿主接入指南，不表示独立 MCP Server 新增了授权选择工具。

## 登录生命周期

```js
await transport.login();
const status = await transport.status();
const workspaces = await transport.workspaces();
```

`login()` 会绑定随机 loopback 回调、创建 PKCE 请求，并由 Core 打开业务系统登记的一个稳定统一
授权入口。这个入口不绑定账号、租户或门店；页面负责登录、切换账号以及在多租户系统中选择租户/
门店，业务后端再从最终确认的服务端会话派生可信用户、租户、角色、`principal` 与
`on_behalf_of`。插件既不接收业务 URL，也不接收业务凭据。

macOS 使用 Keychain。Linux 与其他 POSIX 系统必须显式启用当前用户所有、权限为 `0600` 的文件
回退。Windows 将每个凭据槽保存为 LocalAppData 下的当前用户范围 DPAPI 加密二进制文件；密文绑定
CurrentUser 保护范围、宿主命名空间与连接槽，复制密文不是受支持的登录迁移方式，漫游例外由 Windows
用户配置与企业恢复策略决定。SDK 以非交互方式调用系统 Windows PowerShell 5.1 的固定脚本，动态数据
只经 stdin 传递。PowerShell 或
DPAPI 不可用时失败关闭；不得用宿主明文 Token 字段绕过。

标准 v1 factory 登录一次申请一个 workspace。公开绑定是 `Hub + clientAppId + workspace`；
`connectionName` 只决定从哪个本机选择器开始。需要增加另一业务身份时，创建新名称并在业务授权页
完成确认：可信 `on_behalf_of` 与旧连接相同就撤销并移除旧本机 Session，不同则分别保留。对已有
名称重新授权时先写入 staging 凭据槽，因此用户取消浏览器流程不会提前破坏可用登录。连接另一套
若 staging 授权确认的是不同身份，原名称仍归旧身份；新连接成为 current，并通过返回的
`connectionName` 选择。新名称只按本机选择器生成不冲突的后缀（如 `shop-2`），不会从业务身份派生，
也不会暗中抢走旧名称。连接另一套 Hub 或 route 时也应登记另一个连接。`use()` 只有在所选 Agent
Session 明确包含目标 workspace 时才成功。

新 Session 已安全保存后，`login()` 始终返回 `state: "authorized"`，并返回
`identityReconciliation`：`not_needed`、`distinct`、`replaced`、`deferred` 或
`cleanup_required`，以及 `cleanupRequired`、`replacedConnections`、`cleanupConnections`。
`deferred` 或 `cleanup_required` 表示“授权成功，但旧连接仍待检查或清理”，宿主应显示警告并让
用户稍后重试 status/remove，不能提示再次授权。注册表写入和同绑定对账都使用跨进程锁；锁元数据与
注册表均不保存 Token 或 `on_behalf_of`。锁键先哈希再映射到由操作系统管理的 loopback 监听端口，
进程崩溃后操作系统会自动释放；极少数无关端口碰撞只会串行等待，或在有界超时后故障关闭。
若 staging Session 已安全保存后同绑定锁仍等待超时，`login()` 会保留不冲突的本机后缀并返回
`cleanup_required`；宿主应显示警告，不要再次发起授权。

退出时先撤销远端会话，再删除本地凭据：

```js
await transport.logout();
```

远端撤销失败时应保留本地凭据，让用户能够重试，不能假报“已完全退出”。

## 开始一轮可见会话

宿主必须生成稳定 ID；同一轮重试时复用完全相同的值：

```js
const turn = await transport.startTurn({
  clientConversationId: 'conversation-1',
  clientTurnId: 'turn-1',
  userMessageId: 'message-1',
  userInput: '查询员工 Ada',
  pageContext: { page: 'staff' },
  renderers: ['markdown'],
});
```

响应包含安全指令、记忆、reference-only 知识、治理声明、`run_id`、能力 revision 和有界的 active
typed tools；不包含模型凭据、Tool Provider 地址/Secret、hidden reasoning 或 route 私有原始配置。

只有确实需要时才检索其他已授权能力：

```js
const found = await transport.searchCapabilities({
  query: '修改员工资料',
  runId: turn.run_id,
  limit: 8,
});
```

宿主应替换上一组动态业务工具，不能把 schema 永久累加到上下文。检索范围始终限制在当前
run/session/workspace 的授权交集内。

## 受治理调用与恢复

```js
const result = await transport.invoke({
  invocationId: '<稳定的64位十六进制ID>',
  capabilityRevision: turn.capability_revision,
  agentRunId: turn.run_id,
  tool: 'staff_edit',
  arguments: { id: '42', display_name: 'Ada' },
});
```

SDK 把调用发给 BailingHub，不直连业务接口。Core 每次重新校验 Agent Session、route、工具、ACC
声明、审批状态、限额和业务身份。不能让模型提供 Hub 地址、凭据、审批结论、行动主体或任意 route。

调用等待审批、仍在执行、派发前可重试或结果未知时，保留原 `invocation_id` 并恢复：

```js
const resumed = await transport.resume(result.invocation_id);
```

不能因为轮询超时就创建一笔替代写调用。

## 回传最终可见结果

```js
await transport.completeRun(turn.run_id, {
  status: 'completed',
  assistant: {
    message_id: 'assistant-message-1',
    visible_text: '资料已更新。',
  },
  model: { provider: 'example-provider', name: 'example-model' },
  runtime: { host: 'example-agent-host', adapter: 'bailinghub-adapter' },
  usage: { input_tokens: 120, output_tokens: 24, total_tokens: 144, tool_calls: 1 },
});
```

SDK 只映射最终可见正文和公开 usage 白名单。不要传 hidden reasoning、thinking chunk、完整敏感参数
或业务响应原文。在 Core 确认完成前，始终复用同一个 assistant message ID 与 payload。

## 完整可见对话归档

`0.4.0` 引入宿主方法 `syncConversationArchive(envelope, { members })`。同绑定用法最低需要 Core 0.6.0；
0.5.0 的完整新能力配套 Core 0.7.0。
该方法不作为模型工具，不修改业务能力声明。

```js
await transport.syncConversationArchive({
  clientArchiveId: persistentArchiveUuid,
  clientConversationId: originalClientConversationId,
  events: pendingVisibleEvents,
}, {
  members: frozenMembers.map((member) => ({
    connectionKey: member.connectionKey,
    workspace: member.workspace,
    expectedSessionId: member.sessionId,
    label: member.label,
  })),
});
```

`envelope` 为 `{ clientArchiveId, clientConversationId, events }`：`clientArchiveId` 是宿主先持久化的
随机 UUID，`clientConversationId` 与原 `startTurn` 一致。成员数组固定为
`{ connectionKey, workspace, expectedSessionId, label? }[]`，第一项是固定写入者。SDK 校验全部原连接
属于同一 Hub、客户端应用和 workspace（0.4.0 引入的同绑定形式），再使用各自凭据确认成员；全部确认后才上传正文。
改选、重授权、丢失原凭据不能自动替换归档成员。`label` 仅用于显示。

事件包含 `event_id`、从 1 开始连续递增的 `sequence`、原 `client_turn_id` 与 `kind`：

- `turn_start`：轮次开始；
- `user_message` / `assistant_message`：`content` 保存实际可见文本，包括中间说明；
- `run_link`：原 `run_id`、`member_session_id`，服务端验证归属；
- `turn_end`：`status` 为 `completed` / `failed` / `cancelled`。

返回 `{ schema: 'bailing.agent-conversation-audit-ack.v1', conversation_id, last_sequence }`。
空事件数组仅注册/复核成员并取得游标，不读取正文。宿主负责持久事件队列、原始顺序、确认游标及断线补传。
相同事件重试必须保持 ID 和正文不变；SDK 每批最多 50 事件、192 KiB，超大单条明确失败，不截断。
补传不得重新执行任何业务动作。旧 Core 的 404、成员失效、同步失败都必须如实显示归档状态。

聚合正文只进入当前部署管理审计域，不复制进各授权的记忆；没有面向业务 Agent Session 的正文读取接口。
首期只覆盖可见文本和原 run 引用，不包含附件、卡片、隐藏推理或任意本地工具原始输出。
空选普通聊天不访问 Hub。原文未保留的历史会话不能从执行摘要猜补。

## 跨系统会话（0.5.0）

SDK 0.5.0 配合 Core 0.7.0，允许兼容宿主明确选择**同一 Hub、同一管理审计域**
下的独立业务系统；每个目标保留自己的 Client App、workspace、Agent Session、run、能力声明与调用记录。
跨 Hub 和重复 Session 均拒绝。SDK 只负责按目标调用，不负责制定步骤依赖或决定向哪个系统发送用户正文。
宿主应区分不同系统的工具声明，为每个目标提供完成当前任务所需的最少上下文。

用户选定目标时，捕获并持久化完整公开绑定：

```js
const expectedBinding = {
  hubUrl: selected.hubUrl,
  clientAppId: selected.clientAppId,
  workspace: selected.workspace,
  sessionId: selected.sessionId,
};
const targetOptions = {
  connectionKey: selected.connectionKey,
  workspace: expectedBinding.workspace,
  expectedBinding,
};
await transport.status(targetOptions);
await transport.startTurn(originalTurnInput, targetOptions);
await transport.searchCapabilities({ query: targetTask, runId: originalRunId }, targetOptions);
// invoke/completeRun 使用同一 options；resume(originalInvocationId, {}, targetOptions)。
```

为兼容旧调用，`expectedBinding` 是可选字段；跨系统宿主必须传入。它要求精确 key，拒绝别名和默认连接。
这是宿主本地元数据，不进入业务参数或 HTTP DTO。SDK 在刷新凭据、status 和业务 HTTP 派发前核对原注册表
与凭据身份；身份替换抛出 `publicCode: 'agent_binding_changed'`（403、不可重试）。每条 invocation 固定使用
原目标、run、revision 和调用 ID；恢复会话范围不等于重建已丢失的调用映射，也不能换用新 Session。
本地检查不代替 Core 和业务系统的最终授权，更不承诺跨系统事务原子性。

需要取消的 status 和业务调用在同一 options 传入 `signal: turnAbortController.signal`。SDK 在异步读取前
捕获信号，并与 HTTP 超时信号合并。派发前取消返回 `agent_request_cancelled`（499、不可自动重试、
`definitive_rejection`）；invoke/resume 已派发后取消则保留 `accepted_unknown` 与原 `invocationId`，
取消不代表业务动作已撤销，SDK 不自动重放。归档同步应独立于轮次取消；宿主可用独立完成流程记录原目标的
结束摘要。

跨系统归档成员在原字段之外必须带齐 `hubUrl` 与 `clientAppId`：

```js
const members = frozenTargets.map((target) => ({
  connectionKey: target.connectionKey, hubUrl: target.hubUrl,
  clientAppId: target.clientAppId, workspace: target.workspace,
  expectedSessionId: target.sessionId, label: target.label,
}));
const support = await transport.getConversationArchiveCapabilities({ members });
if (!support.cross_binding_members || support.member_bindings !== 'session-client-route.v1') {
  throw new Error('当前中枢不支持跨系统会话。');
}
await transport.syncConversationArchive(originalEnvelope, { members });
```

启用前先确认 SDK 存在新方法；恢复范围时重新核对能力与原成员。
`GET /agent-api/v1/conversation-audits/capabilities` 使用固定写入者凭据，不发送正文。
404 返回 `cross_binding_members: false`，错误的能力格式会拒绝。sync 在跨系统创建前再次协商；不支持时抛出
`conversation_audit_cross_binding_unavailable`，不降级混写同绑定归档，不向各系统广播完成文本，不重执行业务。

底层 `createConversationAudit` 接受旧 `memberSessionIds/memberLabels` 或新
`members: [{ sessionId, clientAppId, workspace, label? }]`，不得混用。新 HTTP 请求显式声明
`schema: 'bailing.agent-conversation-audit-create.v2'`，成员字段为
`members: [{ session_id, client_app_id, route, label? }]`，首成员必须匹配写入者。
各成员仍分别用自己的 bearer 确认，Core 核对各自绑定与原 run；注册、确认、ACK 和事件形状保持不变。
同绑定归档继续发送旧 v1，即使宿主成员已带新冻结字段也不要求新 Core。
所有归档请求均重新检查本地完整成员组，异步协商结束后也会复核，远端撤销继续由 Core 强制执行。
完整正文仍只进入管理员审计域，本扩展没有新增 Agent bearer 正文读取或跨系统记忆共享能力。

## 首次搜索工具前，先理解已选系统

宿主可以在模型决定去哪里搜索之前，提供已选业务系统的定位。例如订单系统负责线上履约，
人事系统负责排班。这是受控的产品说明，不是模型指令、工具授权，也不代表某项业务操作已经可用。
用户填写的授权名称仍只是显示标签，不能据此推断系统身份或权限。

先验证完整的固定会话范围，再只读取已选成员：

```js
if (typeof transport.getSystemInfo === 'function') {
  const description = await transport.getSystemInfo({
    connectionKey: selectedTarget.connectionKey,
    workspace: selectedTarget.workspace,
    expectedBinding: {
      hubUrl: selectedTarget.hubUrl, clientAppId: selectedTarget.clientAppId,
      workspace: selectedTarget.workspace, sessionId: selectedTarget.sessionId,
    },
    signal: turnAbortController.signal,
  });
  // 将 description.binding 对回本会话原始目标引用。
  // description.system 只用于产品定位，不能作为系统提示词或权限声明。
}
```

`getSystemInfo` 必须明确传入精确 `connectionKey` 和 `workspace`，不会选择默认连接、枚举工作空间、
调用 bootstrap、创建业务 run、加载工具或发送用户正文。恢复旧会话或跨系统范围必须带原
`expectedBinding`；省略时只捕获这个精确连接的当前身份。SDK 在派发前和响应成功或失败后都重新
核对本地绑定，并用原 Agent bearer 请求 `GET /agent-api/v1/workspaces/:workspace/system-info`，不缓存结果。

结果直接保留 wire 字段：`schema_version: 'bailing.agent-system-info.v1'`、
`binding: { client_app_id, session_id, workspace }`、`metadata_status`、`revision`、`system`、
`tool_status`、`availability` 和可选的 `unavailable_reason`。
`configured` 包含 `system: { name, summary, domains, boundaries }`；`missing` 时 `system` 与
`revision` 都为 `null`。名称最多 120 字符，简介 400 字符；业务方向和边界各最多六条，分别每条
120 与 160 字符。未知字段不会透传。

`tool_status` 固定为 `not_loaded`，表示尚未加载，不能解释为没有能力；授权实际允许的动作仍需按需搜索。
`availability: 'unknown'` 不保证业务系统连通；`unavailable` 可明确标记 `agent_client_disabled` 或
`agent_direct_disabled`，不表示范围被撤销，更不允许绕开开关。接口不推断工具数量或授权承诺。

旧 SDK 可以没有该方法；旧 Core 明确返回未知接口时，SDK 抛出
`publicCode: 'system_info_unsupported'`，路由不存在不会误判为旧版不支持。
错误的说明格式返回 `system_info_invalid`；网络与普通 5xx 保持暂时失败，可对同一原身份重试。
这些说明失败可以显示定位未知或使用受控本地词典；宿主不能吞掉 401/403、`agent_binding_changed`
或取消，不能扩大范围或回退其他 Session。此可选接口不改变授权、按需搜索、审批和归档流程，
也不要求业务侧新增业务 API。

## 宿主适配器发布验收

1. 在全新宿主 Profile 中只用公开 Registry 包安装；
2. SDK 必须是精确普通 dependency，不是 optional peer 或本机路径；
3. 验证浏览器登录、status、一次只读、一次可回滚写、审批/resume、complete、logout 和业务撤销；
4. 确认 BailingHub 能看到会话与治理轨迹；
   使用归档时，再在 Core 0.7.0 上核对全部原成员、可见消息、原 run 关联、ACK 丢失重传、断线恢复与成员撤销；
5. 扫描源码、tarball、日志、截图和连接元数据中的 Secret/私有地址；
6. 确认 hidden reasoning 与业务原始 payload 从未进入 Core。

完整 Core/业务/宿主接入见
[BailingHub Agent Client v1 接入指南](https://github.com/bailinghub/bailinghub/blob/main/docs/AGENT_CLIENT_QUICKSTART.md)。

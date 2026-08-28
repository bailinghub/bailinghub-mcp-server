# BailingHub Agent Client SDK

[English](AGENT_CLIENT_SDK.md) | 简体中文

`bailinghub-mcp-server/sdk` 是本地智能体框架的宿主无关接入层。它统一负责浏览器授权、PKCE、
连接元数据、Agent Session 安全存储、Token 刷新和 BailingHub Runtime DTO 映射。宿主适配器只负责
自己的生命周期、模型调用、可见会话 ID 和动态工具注册。

SDK 不内嵌 BailingHub，不替开发者注册业务系统，不自动生成业务授权页，也不保存模型提供方凭据。
宿主不填写业务系统 URL；Core 会按 `clientAppId` 解析已经登记的唯一授权入口。

## 安装与兼容

安装与 Agent Client 发布线匹配的 SDK 包：

```bash
npm install bailinghub-mcp-server@0.2.0
```

`0.2.0` 是稳定的 Agent Client SDK 版本。在公开 npm Registry 能解析到该精确版本之前，
宿主适配器必须保持私有，且不得在公开 manifest 中改用本机路径。

服务端需要具备 Agent Auth v1、Agent Client Runtime v1、route 的 `tools.agent_direct` /
`agent_client` 配置，以及已登记的公开 Client App ID 与业务授权页。

旧 Client Token/MCP Job 模式是独立兼容路径。Agent Client 宿主不需要
`BAILINGHUB_CLIENT_TOKEN`。

## 配置归属

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
SDK 会先哈希再使用，并同时隔离连接注册表、POSIX 凭据文件、macOS Keychain account 和本机锁作用域。
未设置时，历史路径与 Keychain account 保持完全不变，以保证向后兼容。

命名空间不会在宿主之间复制或迁移凭据。因此宿主首次采用新命名空间时，会从空的本机注册表开始，
并需要正常完成一次浏览器授权。不要通过复制凭据文件或 Keychain 记录绕过边界；停用旧宿主连接时，
应由匹配的旧宿主正常撤销并删除。注入自定义注册表或凭据路径的高级宿主，需要自行确保这些覆盖路径
仍位于同一个命名空间边界内。

## 多连接生命周期

> **未发布候选能力：**本节 API 已在当前开发分支实现，需要配套的 SDK 与宿主候选版本，
> 不属于公开 `0.2.0` 包。正式发布前必须按 Core -> SDK -> 宿主适配器顺序对齐精确版本。

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
放在用户命令或设置界面中，不能投影为模型工具，也不能接受模型生成的连接选择。已经开始的会话
或 run 必须继续使用创建时固定的实例，切换只影响新会话。

`connectionsRemove()` 在有登录时先撤销远端 Agent Session，成功后才删除本地凭据与公开元数据。
远端撤销失败时，连接与凭据原样保留以便重试。它不同于 `use(workspace)`：前者选择或删除一整套
连接实例，后者让同一个实例在当前业务授权已经允许的范围内改绑另一个 workspace；它不会把一套
已授权身份变成另一套身份。

已有确定性 v1 注册表连接继续可读，并保持原凭据 key。只有至少存在一个具名实例时，注册表
才写为 schema v2；其中的实例 ID 只是本机不透明元数据，不是凭据，也不会作为身份声明发送给 Core。
旧版 SDK 遇到 schema v2 会失败关闭。降级前必须使用匹配候选版逐一撤销并删除候选实例；最后一个
实例删除后注册表会重新写为 schema v1。不要手工删除凭据文件或 Keychain 记录。

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
回退。Windows 在具备原生安全存储前失败关闭；不得用宿主明文 Token 字段绕过。

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

## 宿主适配器发布验收

1. 在全新宿主 Profile 中只用公开 Registry 包安装；
2. SDK 必须是精确普通 dependency，不是 optional peer 或本机路径；
3. 验证浏览器登录、status、一次只读、一次可回滚写、审批/resume、complete、logout 和业务撤销；
4. 确认 BailingHub 能看到会话与治理轨迹；
5. 扫描源码、tarball、日志、截图和连接元数据中的 Secret/私有地址；
6. 确认 hidden reasoning 与业务原始 payload 从未进入 Core。

完整 Core/业务/宿主接入见
[BailingHub Agent Client v1 接入指南](https://github.com/bailinghub/bailinghub/blob/main/docs/AGENT_CLIENT_QUICKSTART.md)。

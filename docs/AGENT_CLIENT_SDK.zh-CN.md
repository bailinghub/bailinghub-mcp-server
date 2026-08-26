# BailingHub Agent Client SDK

[English](AGENT_CLIENT_SDK.md) | 简体中文

`bailinghub-mcp-server/sdk` 是本地智能体框架的宿主无关接入层。它统一负责浏览器授权、PKCE、
连接元数据、Agent Session 安全存储、Token 刷新和 BailingHub Runtime DTO 映射。宿主适配器只负责
自己的生命周期、模型调用、可见会话 ID 和动态工具注册。

SDK 不内嵌 BailingHub，不替开发者注册业务系统，不自动生成业务授权页，也不保存模型提供方凭据。

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
| `connectionName` | 本机可读别名 | 否 |

宿主配置不得新增 BailingHub Client Token、管理 Token、业务密码/Cookie、Tool Provider Secret、
业务 API 地址、模型 API Key 或 Agent access/refresh token。模型和模型 Key 仍由宿主自己的凭据系统管理。

## 登录生命周期

```js
await transport.login();
const status = await transport.status();
const workspaces = await transport.workspaces();
```

`login()` 会绑定随机 loopback 回调、创建 PKCE 请求并打开业务系统配置好的授权页。业务系统从当前
服务端登录态推导用户、租户、角色与允许 route；SDK 把返回的 Agent Session 放入安全凭据存储。

macOS 使用 Keychain。Linux 与其他 POSIX 系统必须显式启用当前用户所有、权限为 `0600` 的文件
回退。Windows 在具备原生安全存储前失败关闭；不得用宿主明文 Token 字段绕过。

标准 v1 factory 登录一次申请一个 workspace。一条连接按 `Hub + clientAppId + workspace` 绑定；
连接另一套 Hub 或 route 时应使用另一个别名并重新完成浏览器授权。`use()` 只有在现有 Agent
Session 明确包含目标 workspace 时才成功，不能宣传成无限制跨路由切换。

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

# BailingHub MCP Server

[English](README.md) | 简体中文

> **0.3.0：**新增由宿主控制的多连接生命周期 API，以及 Windows Agent Session 的
> CurrentUser DPAPI 安全存储。现有 Agent Client 与 `0.1.x` Client Token 语义继续兼容，
> 不会被替换。

让 MCP Host 通过自托管的 [BailingHub](https://www.bailinghub.com/) 控制面，提交并查询
受治理的业务系统操作。

它是一个独立、轻量的生态适配器，不内嵌 BailingHub，不授予业务权限，也不替代
业务系统的最终授权。它同时保留原有 Client Token 模式，并新增 Agent
Session 模式：用户通过系统浏览器授权当前本地智能体。

## 暴露的工具

| 工具 | 用途 |
| --- | --- |
| `submit_governed_job` | 把不可信任务文本提交到管理员固定的 BailingHub route |
| `get_governed_job` | 查询当前 Client 所拥有任务的公开状态 |
| `wait_for_governed_job` | 最多等待 60 秒，不会重新提交业务操作 |

Agent Client 0.3 路径初始只暴露 5 个小型元工具，用于启动本轮、搜索能力、
受治理调用/恢复以及同步可见结果。BailingHub 每轮最多返回 12 个 active tools，
新集合会替换旧集合，不会在上下文中无限累加。

宿主开发者应使用[宿主无关的 Agent Client SDK 指南](docs/AGENT_CLIENT_SDK.zh-CN.md)。

BailingHub 地址、凭据和 route 都是本地进程配置，不是 MCP 工具参数，因此模型
不能选择或替换它们。

## 认证模式

- **Agent Session：**先执行一次 `bailinghub-mcp-server login`。CLI 使用随机回环端口和
  PKCE，打开系统浏览器，并把已批准会话保存到各平台对应的安全凭据存储。MCP 工具改用
  `/agent-api/v1/*`，并在本地安全轮换 refresh token。
- **Client Token（保持兼容）：**存在 `BAILINGHUB_CLIENT_TOKEN` 时，仍按原样调用
  `POST /run` 和 `GET /jobs/{job_id}`。

两种模式都不允许模型提供凭据、route、行动主体或审批结论。Agent Session 只承载由
Hub/业务授权边界确认的身份，业务系统仍负责最终权限判断。

MCP Registry 的 `server.json` 只描述兼容的独立 stdio/Client Token 安装入口，因此该入口仍会
把 `BAILINGHUB_CLIENT_TOKEN` 标为必填。原生 DSH 插件不读取这份 Registry 配置；它把本包的
`/sdk` 子路径作为普通库依赖，并通过浏览器建立 Agent Session。不要根据 Registry 表单给 DSH
插件增加 Client Token 字段。

## 安全边界

```text
MCP Host / 模型
    |
    | request_id + 不可信任务文本
    v
BailingHub MCP Server
    |
    | 固定 route + Client Token 或已授权 Agent Session
    v
BailingHub
    |
    | 受治理调度
    v
业务系统
    |
    +-- 解析可信主体并执行最终授权
```

首版有意不接受：

- 行动主体或身份声明；
- Client Token、管理员 Token、业务系统密钥；
- 审批结论或审批证据；
- 执行器身份；
- 任意 metadata 或 callback URL；
- 任意 route。

在兼容的 Client Token 模式中，每个 MCP Server 进程只绑定一个 route，并使用仅允许该
route 的专用 Client Token。不同 MCP 客户端需要不同边界时，应分别启动实例。

## 安装

前置条件：

- Node.js 20.15 或更高版本；
- 一套 MCP Host 可以访问的 BailingHub；
- 一个仅允许目标 route 的 BailingHub Client Token，或一个能被批准使用该 route 的
  已注册公共 Agent 客户端。

旧版静态任务模式在 MCP Host 中这样配置：

```json
{
  "mcpServers": {
    "bailinghub": {
      "command": "npx",
      "args": ["-y", "bailinghub-mcp-server"],
      "env": {
        "BAILINGHUB_BASE_URL": "https://hub.example.com",
        "BAILINGHUB_CLIENT_TOKEN": "替换为仅允许指定-route-的-client-token",
        "BAILINGHUB_ROUTE": "order_assistant"
      }
    }
  }
}
```

### Agent Session 登录

启动不携带 Client Token 的 MCP Host 前，先为已注册的公共 Agent 客户端和一条固定
route 完成授权：

```bash
bailinghub-mcp-server login \
  --base-url https://hub.example.com \
  --client-app-id merchant-agent \
  --route order-assistant

bailinghub-mcp-server status
bailinghub-mcp-server logout
```

登录回调只监听 `127.0.0.1` 的随机端口，并同时校验 `state` 与 PKCE S256。access token
和 refresh token 不会出现在 CLI 输出中。macOS 使用 Keychain；Linux 与其他 POSIX 平台
目前只在显式设置 `BAILINGHUB_ALLOW_FILE_CREDENTIAL_STORE=true` 后才允许使用文件回退，
且文件必须属于当前用户并为 `0600` 权限。Windows 使用当前用户范围的 DPAPI 加密文件，
密文保存于该用户的 LocalAppData 目录；Windows PowerShell 或 DPAPI 不可用时失败关闭，
不会自动降级为明文。所有受支持平台仍可使用兼容的 Client Token 模式。

本机回环地址允许 HTTP。非回环 HTTP 默认拒绝；只有在 TLS 已由可信私有网络的其他边界
终止时，才可显式设置 `BAILINGHUB_ALLOW_INSECURE_HTTP=true`。

## 正确调用顺序

1. 为一项业务请求生成稳定的 `request_id`；
2. 使用该 ID 和任务文本调用 `submit_governed_job`；
3. 保存返回的 `job_id`；
4. 短时调用 `wait_for_governed_job`，或稍后调用 `get_governed_job`；
5. 重试同一业务请求时，复用完全相同的 `request_id` 和任务含义。

`queued`、`running` 和 `dispatched` 是非终态；`done`、`error` 和 `rejected`
是终态。

等待超时不等于任务失败，也不能因此重新提交一份替代任务。

## 首次成功与反馈

以[官网 MCP 接入路径](https://www.bailinghub.com/integrations#mcp)作为统一起点。
首次接入成功应同时满足：

1. MCP Host 只能通过管理员固定的 route 提交任务；
2. 同一个 `job_id` 到达终态；
3. BailingHub 保留审批与审计状态；
4. MCP Host 从未获得管理员凭据或业务系统凭据。

请通过 [BailingHub 独立验证表单](https://github.com/bailinghub/bailinghub/issues/new?template=independent_validation.yml)
提交 PASS、部分通过或失败结果，并选择 MCP 路径。不得提交 Token、模型密钥、个人信息或
生产业务数据。

## 项目边界

依赖方向是单向的：

```text
bailinghub-mcp-server -> BailingHub 公共 Client API / Agent API
BailingHub 可以消费 ACC 声明
ACC 不依赖任何一个实现项目
```

进一步阅读：

- [项目边界](docs/PROJECT_BOUNDARIES.md)
- [威胁模型](docs/THREAT_MODEL.md)
- [兼容性契约](docs/COMPATIBILITY.md)
- [Agent Client SDK](docs/AGENT_CLIENT_SDK.zh-CN.md)
- [隐私说明](PRIVACY.md)
- [安全策略](SECURITY.md)

## 开发

```bash
npm install
npm run verify
npm pack --dry-run
```

Client Token 模式仅消费 `bailing.client-api.v1` 的 `POST /run` 与 `GET /jobs/{job_id}`。
Agent Session 模式另外消费增量的 Agent Auth v1 与 Agent API v1：

- `POST /agent-auth/v1/authorizations`
- `POST /agent-auth/v1/token`
- `GET /agent-auth/v1/session`
- `POST /agent-auth/v1/revoke`
- `GET /agent-api/v1/workspaces`
- `GET /agent-api/v1/workspaces/{route}/bootstrap`
- `POST /agent-api/v1/workspaces/{route}/turns`
- `POST /agent-api/v1/workspaces/{route}/capabilities/search`
- `POST /agent-api/v1/tool-invocations`
- `POST /agent-api/v1/tool-invocations/{invocation_id}/resume`
- `POST /agent-api/v1/runs/{run_id}/complete`

`bailinghub-mcp-server/sdk` 子路径暴露宿主无关的 Agent Client factory。它统一负责浏览器授权、
本机具名选择器、隔离凭据、Token 刷新和 Core DTO 映射。在相同 Hub/client/workspace 公开绑定下，
只有 Core 返回的可信 `on_behalf_of` 相同时才替换旧本机连接，不同业务身份仍可独立选择。业务授权
入口由 Core 解析，因此 DSH 等宿主既不填写业务 URL，也不保存凭据或拼装 BailingHub HTTP 路径。

本适配器仍不调用管理员、执行器、审批决策、Tool Proxy、配置或业务系统直接接口。

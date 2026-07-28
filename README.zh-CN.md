# BailingHub MCP Server

[English](README.md) | 简体中文

让 MCP Host 通过自托管的 [BailingHub](https://www.bailinghub.com/) 控制面，提交并查询
受治理的业务系统操作。

它是一个独立、轻量的生态适配器，不内嵌 BailingHub，不授予业务权限，不认证最终用户，
也不替代业务系统的最终授权。

## 暴露的工具

| 工具 | 用途 |
| --- | --- |
| `submit_governed_job` | 把不可信任务文本提交到管理员固定的 BailingHub route |
| `get_governed_job` | 查询当前 Client 所拥有任务的公开状态 |
| `wait_for_governed_job` | 最多等待 60 秒，不会重新提交业务操作 |

BailingHub 地址、Client Token 和 route 都由进程环境配置，不是 MCP 工具参数，因此模型
不能选择或替换它们。

## 安全边界

```text
MCP Host / 模型
    |
    | request_id + 不可信任务文本
    v
BailingHub MCP Server
    |
    | 固定 route + route-scoped Client Token
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

每个 MCP Server 进程只绑定一个 route，并使用仅允许该 route 的专用 Client Token。
不同 MCP 客户端需要不同边界时，应分别启动实例。

## 安装

前置条件：

- Node.js 20.15 或更高版本；
- 一套 MCP Host 可以访问的 BailingHub；
- 一个仅允许目标 route 的 BailingHub Client Token。

在 MCP Host 中配置：

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
bailinghub-mcp-server -> BailingHub 公共 Client API
BailingHub 可以消费 ACC 声明
ACC 不依赖任何一个实现项目
```

进一步阅读：

- [项目边界](docs/PROJECT_BOUNDARIES.md)
- [威胁模型](docs/THREAT_MODEL.md)
- [兼容性契约](docs/COMPATIBILITY.md)
- [隐私说明](PRIVACY.md)
- [安全策略](SECURITY.md)

## 开发

```bash
npm install
npm run verify
npm pack --dry-run
```

本项目只消费 `bailing.client-api.v1` 的 `POST /run` 与 `GET /jobs/{job_id}`，不会调用
管理员、执行器、审批决策、Tool Proxy、配置或业务系统接口。

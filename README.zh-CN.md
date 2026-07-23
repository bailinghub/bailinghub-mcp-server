# BailingHub MCP Server

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

等待超时不等于任务失败，也不能因此重新提交一份替代任务。

## 开发

```bash
npm install
npm run verify
npm pack --dry-run
```

本项目只消费 `bailing.client-api.v1` 的 `POST /run` 与 `GET /jobs/{job_id}`，不会调用
管理员、执行器、审批决策、Tool Proxy、配置或业务系统接口。


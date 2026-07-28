# BailingHub MCP Server

[简体中文](README.zh-CN.md) | English

Use MCP hosts to submit and inspect governed business-system actions through a
self-hosted [BailingHub](https://www.bailinghub.com/) control plane.

This package is a thin integration adapter. It does not embed BailingHub, grant business
permissions, authenticate an end user, or replace the downstream business system's final
authorization.

## What It Exposes

| Tool | Purpose |
| --- | --- |
| `submit_governed_job` | Submit untrusted task text to one operator-configured BailingHub route |
| `get_governed_job` | Read the current public state of a client-owned job |
| `wait_for_governed_job` | Poll one job for at most 60 seconds without resubmitting it |

The route, BailingHub URL, and Client Token are process configuration. They are never MCP
tool arguments and therefore cannot be selected or replaced by model output.

## Security Model

```text
MCP host / model
    |
    | request_id + untrusted input
    v
BailingHub MCP Server
    |
    | fixed route + route-scoped Client Token
    v
BailingHub
    |
    | governed dispatch
    v
Business system
    |
    +-- resolves trusted subject and performs final authorization
```

The adapter intentionally does not accept:

- an acting subject or identity claim;
- a Client Token, administrator token, or business-system credential as tool input;
- an approval decision or approval evidence;
- an executor identity;
- arbitrary metadata or callback URLs;
- an arbitrary route.

Use a dedicated BailingHub Client Token restricted to the one route configured for this
server process. Run separate server instances when different MCP clients need different
route boundaries.

## Install

Prerequisites:

- Node.js 20.15 or newer;
- a reachable BailingHub deployment;
- one BailingHub Client Token restricted to the required route.

Configure an MCP host to spawn:

```json
{
  "mcpServers": {
    "bailinghub": {
      "command": "npx",
      "args": ["-y", "bailinghub-mcp-server"],
      "env": {
        "BAILINGHUB_BASE_URL": "https://hub.example.com",
        "BAILINGHUB_CLIENT_TOKEN": "replace-with-a-route-scoped-client-token",
        "BAILINGHUB_ROUTE": "order_assistant"
      }
    }
  }
}
```

For a local BailingHub process, loopback HTTP is accepted:

```text
BAILINGHUB_BASE_URL=http://127.0.0.1:3000
```

Non-loopback HTTP is rejected by default. `BAILINGHUB_ALLOW_INSECURE_HTTP=true` exists only
for an operator-controlled private network where TLS terminates elsewhere. Do not use it
across an untrusted network.

## Correct Job Flow

1. Create a stable `request_id` for one business request.
2. Call `submit_governed_job` with that ID and the task text.
3. Preserve the returned `job_id`.
4. Call `wait_for_governed_job` for a short bounded wait, or call `get_governed_job` later.
5. If submission must be retried, reuse the exact same `request_id` and task meaning.

`queued`, `running`, and `dispatched` are non-terminal. `done`, `error`, and `rejected` are
terminal. A wait timeout is not a failed task and must not cause a replacement submission.

## First Success and Feedback

Use the [MCP integration path](https://www.bailinghub.com/en/integrations#mcp) as the
canonical start page. The first integration is successful when an MCP host submits through
the operator-fixed route, the same `job_id` reaches a terminal state, BailingHub retains
its approval and audit state, and the MCP host never receives administrator or
business-system credentials.

Report a PASS, partial result, or failure through the
[BailingHub independent validation form](https://github.com/bailinghub/bailinghub/issues/new?template=independent_validation.yml)
and select the MCP track. Never include tokens, model keys, personal information, or
production business data.

## Project Boundaries

The dependency direction is one-way:

```text
bailinghub-mcp-server -> BailingHub public Client API
BailingHub may consume ACC declarations
ACC has no dependency on either implementation
```

See:

- [Project boundaries](docs/PROJECT_BOUNDARIES.md)
- [Threat model](docs/THREAT_MODEL.md)
- [Compatibility contract](docs/COMPATIBILITY.md)
- [Privacy](PRIVACY.md)
- [Security policy](SECURITY.md)

## Development

```bash
npm install
npm run verify
npm pack --dry-run
```

The integration uses the stable `bailing.client-api.v1` surface only:

- `POST /run`
- `GET /jobs/{job_id}`

No administrator, executor, approval-decision, tool-proxy, configuration, or direct
business API is called.

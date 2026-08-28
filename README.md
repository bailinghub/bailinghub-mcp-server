# BailingHub MCP Server

[简体中文](README.zh-CN.md) | English

> **0.2.0:** adds the stable host-neutral Agent Client SDK and browser-authorized Agent Session
> flow. The existing `0.1.x` Client Token behavior remains compatible and is not replaced.

Use MCP hosts to submit and inspect governed business-system actions through a
self-hosted [BailingHub](https://www.bailinghub.com/) control plane.

This package is a thin integration adapter. It does not embed BailingHub, grant business
permissions, or replace the downstream business system's final authorization. It supports
both the existing operator-provisioned Client Token mode and an Agent Session mode in
which a human approves one local Agent through the system browser.

## What It Exposes

| Tool | Purpose |
| --- | --- |
| `submit_governed_job` | Submit untrusted task text to one operator-configured BailingHub route |
| `get_governed_job` | Read the current public state of a credential-owned job |
| `wait_for_governed_job` | Poll one job for at most 60 seconds without resubmitting it |

The Agent Client 0.2 path starts with five small meta-tools for turn bootstrap,
capability search, governed invocation/recovery, and visible run completion. BailingHub then
returns at most 12 active business tools for the current turn; each replacement removes the
previous active set instead of growing the model context indefinitely.

Host implementers should use the [host-neutral Agent Client SDK guide](docs/AGENT_CLIENT_SDK.md).

The route, BailingHub URL, and credential are local process configuration. They are never
MCP tool arguments and therefore cannot be selected or replaced by model output.

## Authentication Modes

- **Agent Session:** run `bailinghub-mcp-server login` once. The CLI uses a random loopback
  callback plus PKCE, opens the system browser, and stores the approved session in macOS
  Keychain. The MCP tools then use `/agent-api/v1/*` and refresh rotated tokens locally.
- **Client Token (compatible):** when `BAILINGHUB_CLIENT_TOKEN` is present, the adapter keeps
  using `POST /run` and `GET /jobs/{job_id}` exactly as before.

Neither mode lets the model supply a credential, route, acting subject, or approval result.
The Agent Session records the identity approved by the Hub/business authorization boundary;
the downstream business system still makes the final authorization decision.

The MCP Registry `server.json` describes only the compatible standalone stdio/Client Token
installation, so that entry still marks `BAILINGHUB_CLIENT_TOKEN` as required. The native DSH
plugin does not consume that Registry configuration: it imports this package's `/sdk` subpath as
an ordinary library dependency and establishes an Agent Session through the browser. Do not add a
Client Token field to a DSH plugin based on the Registry form.

## Security Model

```text
MCP host / model
    |
    | request_id + untrusted input
    v
BailingHub MCP Server
    |
    | fixed route + Client Token or approved Agent Session
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

In compatible Client Token mode, use a dedicated token restricted to the one route configured
for this server process. Run separate server instances when different MCP clients need
different route boundaries.

## Install

Prerequisites:

- Node.js 20.15 or newer;
- a reachable BailingHub deployment;
- either one route-scoped BailingHub Client Token or a registered public Agent client that
  can be approved for the required route.

For the legacy static-job mode, configure an MCP host to spawn:

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

### Agent Session login

Authorize one registered public Agent client and one fixed route before starting the MCP
host without a Client Token:

```bash
bailinghub-mcp-server login \
  --base-url https://hub.example.com \
  --client-app-id merchant-agent \
  --route order-assistant

bailinghub-mcp-server status
bailinghub-mcp-server logout
```

The login callback binds only to a random `127.0.0.1` port and uses `state` plus PKCE S256.
Access and refresh tokens never appear in CLI output. macOS uses Keychain. Linux and other
POSIX platforms require an explicit `BAILINGHUB_ALLOW_FILE_CREDENTIAL_STORE=true` opt-in;
that fallback rejects files that are not owned by the current user with mode `0600`.
Agent Session credential storage is not yet supported on Windows; compatible Client Token
mode remains available there.

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
bailinghub-mcp-server -> BailingHub public Client API / Agent API
BailingHub may consume ACC declarations
ACC has no dependency on either implementation
```

See:

- [Project boundaries](docs/PROJECT_BOUNDARIES.md)
- [Threat model](docs/THREAT_MODEL.md)
- [Compatibility contract](docs/COMPATIBILITY.md)
- [Agent Client SDK](docs/AGENT_CLIENT_SDK.md)
- [Privacy](PRIVACY.md)
- [Security policy](SECURITY.md)

## Development

```bash
npm install
npm run verify
npm pack --dry-run
```

Client Token mode uses the stable `bailing.client-api.v1` surface:

- `POST /run`
- `GET /jobs/{job_id}`

Agent Session mode uses the additive Agent Auth v1 and Agent API v1 surfaces:

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

The `bailinghub-mcp-server/sdk` subpath additionally exposes a host-neutral Agent
Client factory. It owns browser login, named connection instances (including independently
authorized instances on the same Hub/client/workspace binding), isolated credentials, token
refresh, and Core DTO mapping; host adapters such as DSH do not own credentials or BailingHub HTTP
endpoint details.

No administrator, executor, approval-decision, tool-proxy, configuration, or direct business
API is called by this adapter.

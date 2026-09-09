# BailingHub MCP Server

[简体中文](README.zh-CN.md) | English

Let an MCP-compatible AI agent use natural-language requests to query and operate your
store, SaaS, CRM, ERP, or other business system through
[BailingHub](https://www.bailinghub.com/).

Depending on the capabilities explicitly exposed by the business system and the routes
allowed for this connection, an agent can, for example:

- find products with fewer than 10 items in stock and prepare a restocking suggestion;
- update an employee or customer profile;
- submit a refund request and wait when the configured route requires human approval.

The agent does not receive administrator or business-system credentials. BailingHub keeps
the route boundary, approval state, execution record, and audit trail, while the downstream
business system still makes the final authorization decision.

## What changes in 0.4.0

**Unreleased source candidate:** this checkout also supports a host explicitly selecting several
business systems on one Hub, each with its own authorized connection. It requires the matching
Core capability and host integration; the published npm `0.4.0` and Core `0.6.1` do not include
cross-system conversation archives. See the [candidate integration contract](docs/AGENT_CLIENT_SDK.md#cross-system-source-candidate).

When an Agent Client host enables conversation archiving, a BailingHub administrator can follow
the user's request, the assistant's visible replies and the resulting business actions together.
For example, one conversation can compare two separately authorized stores while retaining the
original execution record for each store. Use **BailingHub Core 0.6.1** with a host that
captures and synchronizes the conversation. The archive API minimum is Core 0.6.0.

The SDK adds that synchronization API. It does not capture conversations by itself. A native host
such as [the DSH plugin](https://github.com/bailinghub/bailinghub-dsh-plugin) owns the account
selection and conversation interface. The standalone MCP server keeps its existing tool surface.

## Who should upgrade, and where to start

| Your setup | Next step |
| --- | --- |
| You use an MCP application with a fixed business route | Install this package at `0.4.0` using the [MCP setup below](#install). Your existing Client Token and Agent Session flows remain compatible. |
| You use a native Agent Client, such as DSH | Upgrade through that host's matching release and follow its account-selection guide. Installing this MCP command alone does not add a multi-account conversation UI. |
| You build an Agent Client host | Install `bailinghub-mcp-server@0.4.0`, use Core `0.6.1` for archives, and follow the [SDK guide](docs/AGENT_CLIENT_SDK.md). |

You do not need to change business API declarations for this SDK upgrade. Existing read/write,
approval and invocation recovery behavior stays in place. Conversation upload retries use the
same event IDs and never repeat business actions; only the deployment's authorized administrators
can read the combined archive. Hidden reasoning is excluded.

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

The Agent Session MCP path starts with five small meta-tools for turn bootstrap,
capability search, governed invocation/recovery, and visible run completion. BailingHub then
returns at most 12 active business tools for the current turn; each replacement removes the
previous active set instead of growing the model context indefinitely.

Host implementers should use the [host-neutral Agent Client SDK guide](docs/AGENT_CLIENT_SDK.md).

The route, BailingHub URL, and credential are local process configuration, never model-supplied
MCP tool arguments. An SDK host may publish a fixed set of available authorization references
for per-call selection within one system; the host resolves each reference to its captured
connection and retains control of connection management. See the
[authorization-reference guidance](docs/AGENT_CLIENT_SDK.md#per-call-authorization-references-within-one-system).

## Authentication Modes

- **Agent Session:** run `bailinghub-mcp-server login` once. The CLI uses a random loopback
  callback plus PKCE, opens the system browser, and stores the approved session in the
  platform-specific secure credential store. The MCP tools then use `/agent-api/v1/*` and
  refresh rotated tokens locally.
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
      "args": ["-y", "bailinghub-mcp-server@0.4.0"],
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
npm install --global bailinghub-mcp-server@0.4.0

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
Windows uses a CurrentUser DPAPI-protected file under the user's LocalAppData directory. If
Windows PowerShell or DPAPI is unavailable, Agent Session fails closed and never falls back to
plaintext. Compatible Client Token mode remains available on every supported platform.

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

The host SDK additionally uses conversation audit write APIs available from Core 0.6.0.
Core 0.6.1 is the recommended release. These APIs are not exposed as MCP/model tools:

- `POST /agent-api/v1/conversation-audits`
- `POST /agent-api/v1/conversation-audits/{conversation_id}/confirm`
- `POST /agent-api/v1/conversation-audits/{conversation_id}/events`

The `bailinghub-mcp-server/sdk` subpath additionally exposes a host-neutral Agent Client factory.
It owns browser login, named local selectors, isolated credentials, token refresh, and Core DTO
mapping. On the same Hub/client/workspace binding it replaces an older local connection only when
Core reports the same trusted `on_behalf_of`; different business identities remain independently
selectable. Core resolves the business authorization entry, so host adapters such as DSH never ask
for a business URL and do not own credentials or BailingHub HTTP endpoint details.

No administrator, executor, approval-decision, tool-proxy, configuration, or direct business
API is called by this adapter.

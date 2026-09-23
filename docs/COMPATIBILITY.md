# Current 0.7.0 pairing

Use Core 0.9.0, SDK 0.7.0 and DSH 0.7.0 for optional model plans and image tools. Existing business-governance APIs retain their documented minima. Host orchestration, scope, approval and audit rules remain in effect. See [upgrade](UPGRADE_v0.7.0.en.md).

# BailingHub Client API Compatibility

This adapter consumes `bailing.client-api.v1`.

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/run` | Submit one job through a fixed allowlisted route |
| `GET` | `/jobs/{job_id}` | Read a client-owned job |

The machine-readable declaration is
[`compatibility/client-api.json`](../compatibility/client-api.json). CI compares it with the
current BailingHub contract and rejects:

- endpoint, method, path, or authentication drift;
- a new required request field;
- a removed guaranteed response field;
- unknown or changed status semantics;
- an unclassified public HTTP error;
- adapter limits wider than the core contract.

MCP protocol versions, this npm package version, BailingHub application versions, and Client
API versions are deliberately independent.

Version 0.7.0 retains Agent Auth v1, Agent Client Runtime v1 and the existing Client Token flow.
The Client API contract and payload semantics remain unchanged; the consumer declaration records
the adapter's new version.

| Feature | Server requirement |
| --- | --- |
| Optional model gateway and plan summaries | Core 0.9.0 with migrations 063/064; discover `model_gateway` support before use |
| Standalone MCP Client Token jobs | Existing `bailing.client-api.v1` contract |
| Browser authorization, Agent turns, governed calls and completion | Existing Agent Auth v1 and Agent Client Runtime v1, including Core 0.5.1 |
| Host SDK visible conversation archive | Conversation audit v1 in same-binding mode: Core 0.6.0 API minimum; Core 0.7.0 for the complete 0.5.0 feature set |
| Same-Hub cross-system archives | Core 0.7.0; negotiate explicit `cross_binding_members: true` and `member_bindings: 'session-client-route.v1'` from the authenticated capabilities endpoint |
| System descriptions before capability search | Core 0.7.0 authorized system-info endpoint; missing support leaves existing discovery usable |
| Optional authorization subject names | Core 0.7.0 with migration 059; older responses are explicit `unsupported`, not guessed names |

The archive is an additive host SDK API. Core releases below 0.6.0 do not implement it; hosts must
report unsupported archival while preserving the established business flow. Upgrade Core before
enabling archiving; use Core 0.9.0 for the current complete release pairing. This SDK does not add a
multi-account selector or transcript capture to the standalone MCP tools; native host adapters
own that interface and durable outbox.

`server.json` remains the MCP Registry descriptor for the standalone stdio/Client Token entry and
therefore intentionally requires `BAILINGHUB_CLIENT_TOKEN`. Native host adapters do not consume
that descriptor; they import `bailinghub-mcp-server/sdk` and use browser-authorized Agent Session
credentials. These are two installation surfaces of one package, not one shared configuration
form.

The host-neutral `bailinghub-mcp-server/sdk` export remains part of the public package surface. Host
adapters must use an exact compatible normal dependency for reproducible installation. A host
adapter must not depend on an optional peer, a local `file:` path, or copied SDK sources.

One public binding is `Hub + client_app_id + workspace`. The multi-connection lifecycle uses
`connectionName` only as a local selector. After authorization it reconciles same-binding
connections by Core's trusted `on_behalf_of`: the same identity replaces its older local Session,
while different identities retain separate credentials and revocation. The host never configures a
business authorization URL; Core resolves the one stable entry registered for the client app.
Standard v1 login still requests one workspace, and another Hub or route requires another
connection and authorization.

For legacy same-binding archives, freeze one explicit ordered member set under that binding. Every
member confirms through its own original Agent Session, and text is readable only through Core's
administrator audit permissions. Per-authorization runs and memory keep their existing ownership.
There is no Agent Session transcript-read endpoint. Archive retry reuses original event IDs and
must not resubmit business invocations.

Version 0.5.0 adds an opt-in same-Hub, same-administrator-audit-domain cross-App/workspace
member representation. Its
`getConversationArchiveCapabilities({ members })` is a host-only, body-free probe; 404 means
unsupported, and malformed capability responses fail closed. The SDK never probes support by
sending cross-system text or falling back to a v1 registration. New Core accepts old v1 clients;
new SDK keeps same-binding v1 requests unchanged. Cross-system hosts require the new SDK method,
freeze `hubUrl/clientAppId/workspace/expectedSessionId` for every exact connection key, and must
not silently ignore those fields on an older SDK. A separate Session is required for each target.

Optional `expectedBinding` guards are additive to existing per-call methods. They do not change
business HTTP DTOs, route authority or invocation recovery. Their local identity mismatch code is
`agent_binding_changed` (403, non-retryable); network failures remain separate. A binding guard
does not make remote authorization checks or local filesystem changes an atomic distributed transaction.

Agent Session credential storage currently supports macOS Keychain and an explicitly enabled
current-user-owned mode-0600 file on Linux and other POSIX platforms. Windows uses CurrentUser
DPAPI-protected files under LocalAppData through the system Windows PowerShell 5.1 runtime. DPAPI
or PowerShell unavailability fails closed without a plaintext fallback. Client Token mode remains
compatible on Windows.

## Local task control

Task control was introduced in Core 0.8.0 / SDK 0.6.0 and remains available in the current
Core 0.9.0 / SDK 0.7.0 pairing. See [the host contract and Chinese scenarios](TASK_CONTROL.md).
`getTaskControlCapabilities` and `getTask` require original binding checks; managed `startTurn`
requires both task and read-only receipt support and a matching `task_binding` echo. A valid
`supported: false` response remains distinct from an unavailable network. Missing old endpoints
are `TASK_UNSUPPORTED`; malformed task records fail closed. Existing optional, unmanaged turns
keep their one-POST path. Sticky required Sessions must be enforced by Core even for old clients
or a missing task association; SDK negotiation cannot replace that enforcement.

No task creation/control tools or admin credentials enter the SDK. Existing invocation IDs,
resume inputs, receipt schema and original authorization guards are retained. Hosts must validate
all original same-Hub members, preserve task references in their durable journal, and use GET
inspection for managed background polling. A different task or connection is not recovery.

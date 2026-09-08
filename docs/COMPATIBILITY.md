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

Version 0.4.0 retains Agent Auth v1, Agent Client Runtime v1 and the existing Client Token flow.
The Client API contract and payload semantics remain unchanged; the consumer declaration records
the adapter's new version.

| Feature | Server requirement |
| --- | --- |
| Standalone MCP Client Token jobs | Existing `bailing.client-api.v1` contract |
| Browser authorization, Agent turns, governed calls and completion | Existing Agent Auth v1 and Agent Client Runtime v1, including Core 0.5.1 |
| Host SDK visible conversation archive | BailingHub Core 0.6.0 conversation audit v1 |

The archive is an additive host SDK API. Older Core releases do not implement it; hosts must
report unsupported archival while preserving the established business flow. Upgrade Core before
enabling archiving. This SDK does not add a multi-account selector or transcript capture to the
standalone MCP tools; native host adapters own that interface and durable outbox.

`server.json` remains the MCP Registry descriptor for the standalone stdio/Client Token entry and
therefore intentionally requires `BAILINGHUB_CLIENT_TOKEN`. Native host adapters do not consume
that descriptor; they import `bailinghub-mcp-server/sdk` and use browser-authorized Agent Session
credentials. These are two installation surfaces of one package, not one shared configuration
form.

The host-neutral `bailinghub-mcp-server/sdk` export is part of the 0.4 package surface. Host
adapters must use an exact compatible normal dependency for reproducible installation. A host
adapter must not depend on an optional peer, a local `file:` path, or copied SDK sources.

One public binding is `Hub + client_app_id + workspace`. The multi-connection lifecycle uses
`connectionName` only as a local selector. After authorization it reconciles same-binding
connections by Core's trusted `on_behalf_of`: the same identity replaces its older local Session,
while different identities retain separate credentials and revocation. The host never configures a
business authorization URL; Core resolves the one stable entry registered for the client app.
Standard v1 login still requests one workspace, and another Hub or route requires another
connection and authorization.

For combined archives, freeze one explicit ordered member set under that same binding. Every
member confirms through its own original Agent Session, and text is readable only through Core's
administrator audit permissions. Per-authorization runs and memory keep their existing ownership.
There is no Agent Session transcript-read endpoint. Archive retry reuses original event IDs and
must not resubmit business invocations.

Agent Session credential storage currently supports macOS Keychain and an explicitly enabled
current-user-owned mode-0600 file on Linux and other POSIX platforms. Windows uses CurrentUser
DPAPI-protected files under LocalAppData through the system Windows PowerShell 5.1 runtime. DPAPI
or PowerShell unavailability fails closed without a plaintext fallback. Client Token mode remains
compatible on Windows.

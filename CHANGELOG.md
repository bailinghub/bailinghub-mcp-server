# Changelog

## Unreleased

- Add a source candidate for conversations with separately authorized systems on one Hub.
  Each target keeps its own Client App, workspace and Agent Session; cross-Hub groups and
  duplicate Sessions remain unsupported. The published 0.4.0 package does not include this change.
- Negotiate `session-client-route.v1` archive membership before any cross-system registration.
  Freeze each member's Hub/app/workspace/Session, confirm with its own credential and preserve
  original run links. Older Core installations receive no cross-system archive create or text.
- Add host-only `getConversationArchiveCapabilities` and optional `expectedBinding` guards for
  status, start, search, invoke, resume and completion. Check the captured identity before token
  refresh and HTTP dispatch; mutable aliases, registry replacements and new Sessions cannot
  substitute for an original target. Existing unguarded calls and same-binding v1 archives stay compatible.
- Keep combined text in the administrator audit domain. This SDK adds neither cross-system
  planning nor a model-visible connection-management tool; hosts own target selection and minimal
  per-target context. Archive retry retains original IDs and never repeats business execution.

## 0.4.0 - 2026-09-08

- Add visible conversation archives for Agent Client hosts; use BailingHub Core 0.6.1. An
  administrator can follow the user's request, visible assistant replies and original business
  runs together, including a conversation that uses several authorized accounts in one system.
- Add the host-only `syncConversationArchive` API and typed conversation registration,
  confirmation and event DTOs. Each frozen member confirms with its own original Agent Session
  before text is uploaded; the current/default connection cannot replace a member.
- Preserve stable archive/event/turn IDs and acknowledgement cursors through bounded, idempotent
  uploads. Retrying an archive never repeats a business operation. Hosts own durable capture,
  pending events, retention, scope selection and recovery status.
- Keep combined text in the administrator's audit domain, separate from each authorization's
  run summary and memory. Exclude hidden reasoning, attachments, credentials and arbitrary tool
  payloads; there is no Agent Session API for reading the combined transcript.
- Document how a host can use explicit connection keys for per-call authorization selection
  without changing business arguments or switching the global connection. This does not add a
  multi-account selector or automatic conversation capture to the standalone MCP tools.
- Preserve the existing Client Token job flow, Agent Auth/Runtime APIs, credential stores and
  connection registry. Older Core installations can continue those flows; the new archive API
  has a Core 0.6.0 API minimum, with Core 0.6.1 recommended. Hosts must report unsupported
  servers without fabricating success.
- Update the locked `fast-uri` and `qs` dependencies to their security patch versions.

## 0.3.0 - 2026-09-01

- Add Windows Agent Session support with per-user DPAPI-protected credential files, native
  multi-connection persistence, and real Windows CI coverage without a plaintext fallback.
- Give Windows DPAPI a separate bounded timeout so a slow first PowerShell startup does not
  inherit the shorter macOS Keychain command limit.
- Add secret-free `connectionsList`, `connectionsAdd`, `connectionsUse`, and
  `connectionsRemove` host APIs across multiple named local selectors.
- Add a backward-readable registry migration that preserves deterministic v1 profiles and uses an
  opaque v2 instance id only for named instances, plus cross-process mutation and binding locks.
- Stage reauthorization so cancellation preserves the working Session, then reconcile the same
  Hub/client/workspace binding by Core's trusted `on_behalf_of`: replace the same identity locally
  and retain different identities.
- Return `state: authorized` with `deferred` or `cleanup_required` reconciliation metadata when an
  older connection cannot be inspected or revoked; do not induce a second login.
- Compare the observed Session and access token under the credential lock before deleting a login
  after HTTP 401, so a concurrent token rotation cannot lose the newer credential.
- Keep connection selection host-controlled and require remote Agent Session revocation before
  local removal; failed revocation preserves the selected connection and credential for retry.

## 0.2.0 - 2026-08-26

- Added a host-neutral Agent Client SDK factory and isolated multi-connection credential registry.
- Added progressive turn bootstrap, capability search, replaceable active tools, governed invoke/resume,
  and visible-only run completion against Agent Client API v1.
- Added browser authorization with PKCE, secure Agent Session storage, token refresh, and explicit
  logout/revocation behavior for local Agent hosts.
- Preserved the `0.1.x` Client Token job flow and standalone MCP Registry configuration.

## 0.1.1 - 2026-07-28

- Added a complete Simplified Chinese setup, security-boundary, and validation guide.
- Added direct language navigation between the English and Chinese documentation.
- Updated the MCP SDK and pinned its Hono server transitive dependency to a patched release.

## 0.1.0 - 2026-07-24

- Added a stdio MCP server with submit, get, and bounded-wait tools.
- Fixed each process to one operator-configured BailingHub route.
- Added Client API compatibility checks, threat-model tests, and package-boundary checks.

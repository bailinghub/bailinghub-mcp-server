# Changelog

## 0.6.0 - 2026-09-16

See [scenarios and upgrade](docs/RELEASE_NOTES_v0.6.0.md) · [English](docs/RELEASE_NOTES_v0.6.0.en.md).

- Add task support negotiation, original task reads and trusted host-only taskBinding. Keep complete original identity checks and distinguish task policy errors from uncertain dispatch.

- Classify a token refresh that returns a different Agent Session or Client as an
  original-identity conflict. Hosts can block the selected group instead of treating
  the response as a temporary outage. Replacement tokens are never saved or used;
  transient refresh failures remain retryable with the original identity.

- Preserve structured identity failures when a host checks selected shop and
  inventory authorizations. Expired Sessions and mismatched remote identities
  no longer look like temporary network uncertainty. Recheck an original bound
  identity after failed status requests as well as successful ones; keep credential
  cleanup, rotation guards and cancellation behavior. No Core API change is needed.

- Add explicit, read-only original-invocation inspection for adapted hosts. A shop
  listing that is approved but not dispatched can be checked without continuing
  it. Original result, approval and journal facts remain distinct; `resume` keeps
  its existing behavior and is never called by inspection.
- Negotiate support before inspection, require the original explicit binding and
  distinguish unsupported Core, unavailable transport and a missing original
  record. See [the receipt contract](docs/INVOCATION_RECEIPTS.md). This receipt method does not add an MCP management tool or change task policy.

- Preserve Core rate-limit scope, original window and retry delay in both Agent SDK invocation paths. Older responses remain compatible; the SDK never automatically resubmits a business write.

- Add host SDK attachment delivery: register approved conversation image bytes with an
  explicit original target, store PNG/JPEG/WebP files and obtain reusable URLs.
  Recover the original upload after an uncertain response without creating a new attachment.
- Clarify capability-search counts and preserve structured discovery/dispatch feedback.
  Existing valid tools remain callable; an uncertain business write retains its original invocation.
- See [Local Agent attachment space](docs/GENERATED_ARTIFACTS.md) for campaign,
  chart and shop examples, integration requirements and separate business-call governance.

## 0.5.0 - 2026-09-10

See [scenarios and upgrade steps](docs/RELEASE_NOTES_v0.5.0.md) for the shop/inventory example, host responsibilities and the Core 0.7.0 pairing.

- Add support for conversations with separately authorized systems on one Hub.
  Each target keeps its own Client App, workspace and Agent Session; cross-Hub groups and
  duplicate Sessions remain unsupported. Version 0.4.0 did not include this change.
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
- Forward a host `AbortSignal` through local binding checks, credential refresh and HTTP timeouts.
  Cancellation before dispatch sends no business request; cancellation after invocation/resume
  dispatch keeps `accepted_unknown` with the original invocation ID and never automatically replays it.

- Read controlled system descriptions before first capability search, for selected original targets only. Descriptions create no runs and grant no permissions.
- Preserve business-supplied authorization subject names through login/status/list and an isolated display cache. Reject malformed Unicode; names, cache failures and renames never replace credentials, original bindings or archive identities.
- Update the transitive Hono lock entry to 4.13.7 for upstream fixes; direct SDK dependency versions remain unchanged.

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

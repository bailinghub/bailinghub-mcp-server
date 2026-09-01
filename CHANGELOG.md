# Changelog

## Unreleased

- Add Windows Agent Session support with per-user DPAPI-protected credential files, native
  multi-connection persistence, and real Windows CI coverage without a plaintext fallback.
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

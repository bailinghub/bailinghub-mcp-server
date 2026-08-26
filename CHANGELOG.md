# Changelog

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

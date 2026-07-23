# Releasing

## Pre-release Gate

1. `npm ci`
2. `npm run verify`
3. Validate the current BailingHub Client API contract.
4. Run the stdio E2E against a no-side-effect mock.
5. `npm pack --dry-run --json` and inspect the exact package contents.
6. Confirm package, `server.json`, changelog, Git tag, and release notes use one version.
7. Confirm no token, private URL, host configuration, or run payload exists in the repository.
8. Publish the npm package with provenance.
9. Validate `mcpName` against `server.json`.
10. Publish metadata with the official `mcp-publisher` and verify it through the Registry API.

## Stop Conditions

Pause the release if:

- an MCP host requires administrator or acting-subject credentials;
- multiple routes can only be supported by allowing the model to choose an arbitrary route;
- a private BailingHub API is required;
- an SDK or Registry preview change would reshape the BailingHub core;
- public copy would imply MCP, registry, or downstream-marketplace endorsement.


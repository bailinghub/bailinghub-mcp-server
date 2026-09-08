# Releasing

## Pre-release Gate

The stable Agent Client release order is BailingHub Core, then this MCP/SDK package, then host
adapters such as `dsh-bailinghub`. Do not publish a host adapter that resolves this SDK from an
optional peer or local path.

1. Publish through the tag-triggered CI workflow from a fresh ordinary Git clone of the
   immutable release commit. Do not publish from a linked Git worktree.
2. Confirm the matching BailingHub Core 0.6.1 release exists. SDK 0.4.0's archive API minimum
   remains Core 0.6.0; Core 0.6.1 is the recommended user installation. Existing Agent Auth v1,
   Agent Client Runtime v1 and Client API flows stay compatible.
3. Set one stable version in `package.json`, `package-lock.json`, `src/version.ts`, `server.json`,
   `compatibility/client-api.json`, changelog, Git tag, and release notes; remove private-candidate
   wording from the English and Chinese README files.
4. Set `private: false` and retain public npm provenance metadata.
5. `npm ci` and `npm run verify`.
6. Validate the existing BailingHub Client API contract and its 0.1 Client Token behavior.
7. Run the stdio E2E against a no-side-effect mock.
8. Run the Agent Session SDK seam against the matching Core: login, status, turn, search,
   invocation, resume, visible completion, logout, and business-side revoke.
9. Verify macOS Keychain, the explicit mode-0600 POSIX fallback, and real Windows CurrentUser
   DPAPI save, restart recovery, per-connection isolation, tamper rejection, and removal. Confirm
   PowerShell/DPAPI failure closes without a plaintext fallback.
10. On one Hub/client/workspace binding, prove that a second authorization with the same trusted
    `on_behalf_of` revokes and removes the older local connection, while a different
    `on_behalf_of` remains independently selectable. Cancel same-name reauthorization and prove the
    working Session survives. Force inspection and revoke failures and prove `login()` still
    returns `state: authorized` with `cleanupRequired`, preserves the relevant credentials, and
    does not advise another login. Confirm a legacy schema-v1 profile remains readable.
    For conversation archives, verify frozen member confirmation, text/run association, lost-ACK
    idempotency, revoked-member rejection and unsupported old-Core behavior from the package.
    Archive recovery must not execute any business invocation again.
11. `npm pack --dry-run --json`, unpack the tarball, and inspect the exact contents.
12. Confirm `dist/sdk.js`, `dist/sdk.d.ts`, Agent Auth/Runtime modules, and both Agent Client SDK
    guides are present.
13. Scan source and the unpacked tarball for credentials, private URLs/IPs, business identifiers,
    absolute paths, private keys, raw tool arguments/results, and hidden reasoning.
14. Install the tarball into a clean project and dynamically import
    `bailinghub-mcp-server/sdk`; no repository path or build tree may be visible.
15. Publish the npm package with provenance through CI. Verify the exact npm version, sha512
    integrity and `gitHead` matching the immutable Tag commit; missing source identity fails the gate.
16. Validate `mcpName` against `server.json`, publish metadata with the official
    `mcp-publisher`, and verify it through the Registry API.
17. Only after this package is publicly resolvable may a host adapter publish with an exact normal
    dependency on this version.

`server.json` is deliberately the standalone stdio/Client Token Registry descriptor. Its required
Client Token field must not be copied into the native SDK or DSH configuration. Release notes and
Registry copy must identify that legacy-compatible surface explicitly, while the Agent Client SDK
guides remain the authority for browser-authorized host adapters.

The public release must not reuse a maintainer's existing `dist`, local tarball, npm cache result,
or DSH profile as release evidence. Rebuild and rescan from the clean checkout.

## Registry description repair for 0.4.0

The `Publish Registry Metadata` manual workflow is restricted to `main` and the already-published
`v0.4.0` package. It checks out the exact dispatch commit and accepts only a `description` change
from the immutable Tag's descriptor. The description must contain at most 100 characters. Package,
server, transport and environment fields must remain unchanged, and npm `gitHead` must still match
the original Tag commit. Run it only after the metadata repair PR and CI pass.

This workflow calls only the official MCP Registry publisher; it cannot publish npm packages or
write Tags. Record the metadata repair commit separately from the original npm/Tag source commit,
then verify the exact Registry version before completing the GitHub Release.

## Stop Conditions

Pause the release if:

- an MCP host requires administrator or acting-subject credentials;
- multiple routes can only be supported by allowing the model to choose an arbitrary route;
- a private BailingHub API is required;
- a clean install cannot resolve `bailinghub-mcp-server/sdk` from the registry;
- any package or document contains a maintainer Hub, business-system address, business identifier,
  credential, local path, or private deployment detail;
- an SDK or Registry preview change would reshape the BailingHub core;
- public copy would imply MCP, registry, or downstream-marketplace endorsement.

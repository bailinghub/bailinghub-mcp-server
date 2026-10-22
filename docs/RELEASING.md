# Releasing

## Writing release notes

For each release, explain a concrete user problem, the new behavior, affected roles, exact upgrade steps, observable checks and limits. State which business APIs and mappings must already exist, and keep English and Chinese facts aligned. See [the 0.8.0 release notes](RELEASE_NOTES_v0.8.0.en.md) for an example.

## 1. Select the release scope

The stable Agent Client release order is BailingHub Core, then this MCP/SDK package, then host
adapters such as `dsh-bailinghub`. Do not publish a host adapter that resolves this SDK from an
optional peer or local path.

This is dependency order, not a requirement to publish every component together. An independent
SDK fix can use an already-published compatible Core. Before preparing a release, record the exact
candidate commit, changed surfaces, supported Core/host versions and required evidence:

| Changed surface | Focused acceptance |
| --- | --- |
| Every package release | Normal prepack, CI, actual archive scan, exports/contract checks, source identity and fresh official-registry consumption |
| Authorization, credentials or identity reconciliation | Affected real OS credential storage and authenticated login/revoke/replacement paths; failure must not introduce plaintext fallback |
| Invocation, approval, cancellation or recovery | Matching Core seam, original invocation IDs and no repeated business dispatch |
| Archives, context delivery or scope restoration | Frozen membership, lost-acknowledgement recovery, revocation and old-Core behavior; use the cooperating host when its final request assembly changes |
| Model transport, output budgets or continuation contracts | Exact parameter/scope and original-operation tests; changed host loops or provider behavior also need their own integration acceptance |
| Documentation or release tooling only | Package/distribution checks and targeted tests; prior unchanged runtime evidence may be reused under the rule below |

Reuse an earlier real result only when its relevant code, dependency, contract and configuration
fingerprints are unchanged, and the applicable host version, OS and tool mode still match. Record
its date, exact subject, evidence and reuse reason. Otherwise rerun the affected checks. A required
changed-surface gate cannot remain untested. Independent downstream rollout, real-model task
performance and external adoption may remain pending with explicit scope; library publication
does not complete them. Installation, composition, synthetic seams and authenticated use are
different evidence levels. New official package identity and clean-registry consumption are never
replaced by an earlier package or a source-only result.

The current project gate accepts stable public packages and explicitly private prerelease
candidates. Public prerelease publication is not supported by that gate or the stable Publish
workflow; it requires a separate reviewed policy and tested non-`latest` dist-tag before any tag.

## 2. Verify the final candidate

The list below specifies required coverage, not separate repeated runs. Cite checks already present
in this candidate's normal prepack or CI logs, including contract and stdio tests; add only applicable
seams that those logs do not cover. Actual-archive inspection and official-registry readback remain
separate gates.

1. Use a clean checkout of the exact candidate. Publication is performed by the tag-triggered
   workflow from an ordinary Git clone of the immutable commit, not a linked Git worktree.
2. Confirm the matching Core contracts are already released. SDK 0.8.0 pairs with Core 0.10.0.
   Existing same-binding archives retain the Core 0.6.0 API minimum; cross-system,
   system-description and authorization-name features retain their Core 0.7.0 minima. The new
   knowledge and explicit output-budget contracts require negotiated support from the current pairing. Existing Agent Auth v1,
   Agent Client Runtime v1 and Client API flows stay compatible.
3. Set one stable version in `package.json`, `package-lock.json`, `src/version.ts`, `server.json`,
   `compatibility/client-api.json`, changelog, Git tag, and release notes; remove private-candidate
   wording from the English and Chinese README files.
4. Set `private: false` and retain public npm provenance metadata.
5. Run `npm ci`, then one normal `npm pack --json` for the final local candidate. Its `prepack`
   already runs `verify` (project checks, build/tests and the production dependency audit). Retain
   that log and the generated archive. Do not add a separate `verify` and dry-run just to repeat
   the same local checks. The configured CI checks remain independent.
6. Validate the existing BailingHub Client API contract and its 0.1 Client Token behavior.
7. Run the stdio E2E against a no-side-effect mock.
8. When authorization or Agent Runtime behavior changes, run the affected Agent Session SDK
   seam against the matching Core: login, status, turn, search,
   invocation, resume, visible completion, logout, and business-side revoke.
9. When credential storage or its dependencies change, verify the affected macOS Keychain,
   explicit mode-0600 POSIX fallback, and real Windows CurrentUser
   DPAPI save, restart recovery, per-connection isolation, tamper rejection, and removal. Confirm
   PowerShell/DPAPI failure closes without a plaintext fallback.
10. When identity reconciliation changes, on one Hub/client/workspace binding prove that a second
    authorization with the same trusted
    `on_behalf_of` revokes and removes the older local connection, while a different
    `on_behalf_of` remains independently selectable. Cancel same-name reauthorization and prove the
    working Session survives. Force inspection and revoke failures and prove `login()` still
    returns `state: authorized` with `cleanupRequired`, preserves the relevant credentials, and
    does not advise another login. Confirm a legacy schema-v1 profile remains readable.
    When conversation archives or their contracts change, verify frozen member confirmation, text/run association, lost-ACK
    idempotency, revoked-member rejection and unsupported old-Core behavior from the package.
    Archive recovery must not execute any business invocation again.
11. Unpack the actual archive from step 5 and inspect its contents and pack JSON inventory.
    A dry-run or an archive produced with skipped lifecycle scripts is not this final gate.
12. Confirm `dist/sdk.js`, `dist/sdk.d.ts`, Agent Auth/Runtime modules, and both Agent Client SDK
    guides are present.
13. Scan source and the unpacked tarball for credentials, private URLs/IPs, business identifiers,
    absolute paths, private keys, raw tool arguments/results, and hidden reasoning.
14. Install the tarball into a clean project and dynamically import
    `bailinghub-mcp-server/sdk`; no repository path or build tree may be visible.
## 3. Publish and verify public distribution

1. Publish the npm package with provenance through CI. Verify the exact npm version, sha512
    integrity and `gitHead` matching the immutable Tag commit; missing source identity fails the gate.
    npm can accept a publication before its exact public metadata is readable. The Publish workflow
    waits at most ten minutes using read-only official registry GETs and checks name, version and
    `gitHead` before MCP Registry publication. A timeout stops the job; do not republish the accepted
    version. Inspect the original npm version status, wait for public readback, then resume only the
    necessary workflow steps. An identity mismatch requires investigation rather than another publish.
    The preflight also fails closed on locked, rate-limited or unavailable reads. Only the first
    workflow attempt can publish after an exact-version 404. A rerun must first observe matching
    public metadata and skips npm publication; if it remains unreadable, it stops conservatively,
    including when an earlier attempt failed before publishing. Investigate that state rather than
    adding an override or treating a failed read as permission to republish.
2. Validate `mcpName` against `server.json`, publish metadata with the official
    `mcp-publisher`, and verify it through the Registry API.
3. Download the official archive, verify its integrity, provenance and source identity, inspect
   its payload, and install the exact registry version into a new consumer. Check the actual
   SDK/stdio exports and resolved package rather than using a repository or ambient module.
   An official archive can have different compressed bytes from the local candidate; verify its
   own integrity and compare the payload before claiming equivalence.
4. Create the GitHub Release from the existing tag after these checks. Record which evidence was
   rerun, reused or remains an independent host/client task.
5. Only after this package is publicly resolvable may a host adapter publish with an exact normal
    dependency on this version.

`server.json` is deliberately the standalone stdio/Client Token Registry descriptor. Its required
Client Token field must not be copied into the native SDK or DSH configuration. Release notes and
Registry copy must identify that legacy-compatible surface explicitly, while the Agent Client SDK
guides remain the authority for browser-authorized host adapters.

The new artifact and installation gates must not reuse a maintainer's existing `dist`, old local
tarball, npm cache result or running DSH profile. Rebuild and rescan from the clean checkout;
referenced earlier real-runtime evidence is governed separately by the reuse rule in step 1.

## Registry description repair for 0.4.0

The `Publish Registry Metadata` manual workflow is restricted to `main` and the already-published
`v0.4.0` package. It checks out the exact dispatch commit and accepts only a `description` change
from the immutable Tag's descriptor. The description must contain at most 100 characters. Package,
server, transport and environment fields must remain unchanged, and npm `gitHead` must still match
the original Tag commit. Run it only after the metadata repair PR and CI pass.

This workflow calls only the official MCP Registry publisher; it cannot publish npm packages or
write Tags. Record the metadata repair commit separately from the original npm/Tag source commit,
then verify the exact Registry version before completing the GitHub Release.

This is a version-specific repair workflow, not a general retry entrypoint for later versions.
For a failed normal Publish run, first inspect the exact npm and Registry state. Only matching
public npm identity permits the existing workflow to skip npm and retry later steps; verify any
already-published Registry record before repeating its publication. An unreadable or mismatching
identity is not permission to republish or use the 0.4.0 repair path.

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

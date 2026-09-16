# v0.6.0 Agent Client SDK: attachments, tasks and original-call inspection

Release 0.6.0. Pairing: Core 0.8.0 / Agent Client SDK 0.6.0 / DSH 0.6.0. Changes below are relative to the preceding public release.

A host may need to upload campaign artwork, update a shop product and later explain whether the change is awaiting approval, executed or unconfirmed. This update provides the APIs, types and states for those steps. The SDK does not generate images, implement a UI or replace business permissions.

## Changes

- **Attachment delivery:** `uploadArtifact` / `getArtifact` bind approved image bytes to an explicit original target and return reusable URLs. After a lost acknowledgement, inspect the original upload ID. File access remains with the host's controlled source, not arbitrary model-supplied paths.
- **Read-only original receipts:** `inspectInvocation` is separate from the potentially executing `resume`. Hosts can distinguish approved from dispatched without submitting a business action when refreshing a panel.
- **Task support:** `getTaskControlCapabilities`, `getTask` and trusted host `taskBinding` connect fixed members and cumulative budgets to Core. There is no model task-creation, budget-increase or task-switching API. Multi-member hosts must verify the complete group.
- **Actionable discovery and failures:** retain candidate counts, loaded state, unknown totals, original rate windows and retry guidance. Transport failure, changed identity, unsupported versions, missing original records and uncertain dispatch remain distinct.
- **Refresh identity protection:** reject replacement identities reported by refresh/status and preserve structured reasons. Temporary network failures may be retried against the original identity. Cancellation and concurrent rebinding remain effective after a late response.

## Host upgrade

Upgrade the actual dependency graph and lockfile as a pair; every consumer must resolve the same SDK. Retain connection keys, Agent Sessions, fixed scopes, events and persistent records. Do not recreate authorizations simply to upgrade.

Task and receipt reads require the original `connectionKey` and full `expectedBinding`. Snapshots are not dispatch permits: Core decides current permissions, budgets and execution. Negotiate support and report unsupported versions; never replace inspection with resume.

Reusable protocol support proof is not a cache of permissions, task state, budgets or results. The SDK does not replay writes automatically. An uncertain dispatched action keeps its original invocation, arguments and identity for inspection.

See the [upgrade guide](UPGRADE_v0.6.0.en.md) for migrations 060–062 and rollout order. Existing backend declarations and approvals need no change for these host APIs; custom hosts own persistence and UI.

## Standalone MCP versus host SDK

This package includes both a standalone MCP server and a host SDK. File sources, conversation panels, task binding and cross-turn tool reuse require host integration. A Registry update alone does not add them to every MCP client. The existing fixed-route Client Token job flow remains; administrative task credentials are not exposed as model tools.

SDK regressions and paired synthetic checks are complete; verify the released package and actual installation when upgrading. Historical calls without trustworthy persisted bindings or original parameters cannot be reconstructed from chat text.

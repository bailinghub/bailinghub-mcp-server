# BailingHub Agent Client SDK

[简体中文](AGENT_CLIENT_SDK.zh-CN.md) | English

Version 0.5.0 lets a compatible host use explicitly selected authorizations from different systems
on one Hub. For example, read inventory, then update the corresponding shop product price and list it,
using each system's original authorization and approval rules. Controlled system descriptions and
business-supplied subject names help the host explain the targets before searching for tools.
The conversation archive introduced in 0.4.0 continues to link visible messages to original actions.

For this feature set, install the exact SDK version below and use BailingHub Core 0.7.0.
Implement explicit scope selection, local visible-history capture and retry in the host.
The SDK does not create an account-selection UI or automatically collect conversations.
Existing Client Token, browser authorization, business invocation and recovery APIs stay compatible.

`bailinghub-mcp-server/sdk` is the host-neutral integration seam for a local Agent framework. It
owns browser authorization, PKCE, connection metadata, secure Agent Session storage, token refresh,
and BailingHub Runtime DTO mapping. A host adapter owns its own lifecycle, model invocation,
visible conversation IDs, and dynamic tool registration.

The SDK does not embed BailingHub, register a business system, generate a business authorization
page, or store model-provider credentials. The host never asks for a business-system URL: Core
resolves the one authorization entry registered for `clientAppId`.

## Installation and compatibility

Install the SDK package version that matches the Agent Client release line:

```bash
npm install --save-exact bailinghub-mcp-server@0.5.0
```

Use an exact ordinary dependency for a published host adapter. Publish it only after `0.5.0`
resolves from the public npm registry; never substitute a local path in a public manifest.

Required server surfaces:

- BailingHub Agent Auth v1;
- BailingHub Agent Client Runtime v1;
- route `tools.agent_direct` and `agent_client` configuration;
- a registered public Client App ID and business authorization page.

Same-binding archives retain a Core 0.6.0 API minimum. Use Core 0.7.0 for cross-system archives,
controlled system descriptions and authorization subject names, and negotiate server support.
Follow the [0.5.0 upgrade steps](RELEASE_NOTES_v0.5.0.md#how-to-upgrade), including Core migrations
058/059 and preservation of the host's credentials, original scopes and archive outbox.
On Core releases below that minimum, existing Agent Auth/Runtime flows remain available;
an archive request can return unsupported.
Display that limitation without claiming the text was saved or retrying a business operation.

The older Client Token/MCP job mode remains a separate compatibility path. Agent Client hosts do
not require `BAILINGHUB_CLIENT_TOKEN`.

## Configuration ownership

### Authorization subject display (0.5.0)

This optional addition lets a host show **which authorized subject the user approved**, without asking
them to type a second name. For example, display `Project Workspace · Example Team` by combining
separate controlled system information and the authorization subject name. A developer may call its
subject an organization, team, project, account, location or another business term. The wire contract
is generic and does not require a `store_name` field.

The authorizing business backend reads the real name for the subject the user confirmed and submits
`subject_display: { name: 'Example Team' }` with authorization approval. Core keeps it separate from
`principal`, `on_behalf_of`, permissions and system information. Core 0.7.0 returns
`subject_display` and `subject_display_status` from both token exchange and Session inspection.
Only `name` is accepted: inspect the original string for C0/C1 controls and U+2028/U+2029, reject any,
then trim; require 1–120 JavaScript UTF-16 code units. Names are descriptive data, not instructions.
Unpaired UTF-16 surrogates are invalid; valid characters such as emoji remain supported.

`login()`, `status()` and each `connectionsList().connections` row expose:

| Field | Meaning |
| --- | --- |
| `subjectDisplay` | `{ name: string }` or `null`; never inferred from aliases, principal, device label or system description |
| `subjectDisplayStatus` | `provided`: current Core supplied a valid name; `missing`: Core supports it but this authorization has no name; `unsupported`: Session response lacks the feature; `unavailable`: not yet read, invalid optional data, or cache unavailable |
| `subjectDisplaySource` | `verified`: read from an identity-validated Session; `cache`: previously saved display data; `none`: no usable display response |
| `subjectDisplayCacheStatus` | `saved`, `not_cached` or `storage_error`; independent of authorization success |
| `subjectDisplayCachedAt` | Cache observation time when a cached value is available; not authorization expiry or proof of current validity |

The low-level `AgentAuthHttpClient` token result uses `subjectDisplay` / `subjectDisplayStatus`;
its Session result retains `subject_display` / `subject_display_status`. Missing fields on old Core
become explicit `unsupported`; malformed optional data becomes `unavailable` without invalidating a
valid token or Session. Authentication or identity validation failures still follow the existing error
path; a cached name never opens business tools.

Names are cached in an independent, mode-0600 sidecar beside the connection registry, bound to the
original connection key, Hub, Client, workspace and Agent Session. The credential and registry schemas
are unchanged. `connectionsList()` reads only local data, makes zero Hub requests, and always labels
its names `cache`; an older installation with no cache reports `unavailable`, not a guessed name or a
claim that the old Core was checked. Call `status({ connectionKey })` to validate the original Session
and refresh the name. Expected bindings and cancellation remain supported as before.

Credential storage remains the primary login result. Optional display caching happens afterwards.
If it fails, login still returns `state: 'authorized'` and `subjectDisplayCacheStatus: 'storage_error'`.
The host must not ask the user to authorize again to repair a display cache; retry status later.
Network or authorization errors from status must not be converted to an authorized state from cache.

Hosts may remove the user-facing “connection note” input and render the returned name as text. Keep
`connectionKey` and any existing internal `connectionName` independent: never use the returned name
to look up, deduplicate, rename or replace connections. Identical names and later renames do not change
identity, fixed conversation scope, invocation records or archive links. Quote names as untrusted data
in model-facing target descriptions; they are never system instructions or evidence of tool permission.

For older authorizations, show a generic label such as **Authorization name pending** when `missing`.
A product-specific host may translate this to its own business term. The owning business backend can
use the Client-protected `PUT /agent-auth/v1/sessions/{session_id}/subject-display` with
`{ subject_display: { name: 'Updated Team' } }` to supply or update a name without replacing the
authorization. The Agent SDK only refreshes through status; it has no Client credential or name-write
API. Existing scope, API declarations and approvals require no change.

This optional feature is included in SDK 0.5.0 with Core 0.7.0. Older Core responses remain
readable and explicitly report missing support; display data never decides whether an authorization is valid.

### Host connection configuration

```js
import { createAgentClientTransport } from 'bailinghub-mcp-server/sdk';

const transport = createAgentClientTransport({
  hubUrl: 'https://hub.example.com',
  clientAppId: 'merchant-agent',
  workspace: 'order-assistant',
  connectionName: 'default',
});
```

| Field | Meaning | Secret |
|---|---|---|
| `hubUrl` | public HTTPS origin of the deployer's BailingHub | no |
| `clientAppId` | public `app_id` registered by the Hub administrator | no |
| `workspace` | initial BailingHub route key | no |
| `connectionName` | local readable selector; not a business identity assertion | no |

Do not add BailingHub Client Tokens, admin tokens, business passwords/cookies, Tool Provider
Secrets, business API or authorization-page URLs, model API keys, or Agent access/refresh tokens
to host configuration. The model provider and key remain in the host's own credential system.

### Host-owned local storage namespace

A product-specific host that can run beside another Agent Client host under the same operating-
system user should assign one fixed local storage namespace in the SDK dependency options:

```js
const transport = createAgentClientTransport({
  hubUrl: 'https://hub.example.com',
  clientAppId: 'merchant-agent',
  workspace: 'order-assistant',
  connectionName: 'default',
}, {
  storageNamespace: 'my-product-desktop',
});
```

The equivalent host-process setting is
`BAILINGHUB_AGENT_CLIENT_STORAGE_NAMESPACE=my-product-desktop`. If both are present, they must be
identical or startup fails closed. The namespace is a non-secret host constant, not a fifth user
connection field, business identity, model input, or value sent to Core. Host adapters must not
let a model or conversation change it.

Accepted values are lowercase identifiers of 1 to 64 characters using `a-z`, `0-9`, `.`, `_`, and
`-`, starting with a letter or number. The SDK hashes the value before using it and isolates the
connection registry, POSIX credential files, macOS Keychain accounts, Windows DPAPI paths and
entropy, and local lock scopes. When the namespace is unset, every historical POSIX path and
Keychain account stays exactly unchanged
for backward compatibility.

Namespaces do not copy or migrate credentials between hosts. The first run after a host adopts a
new namespace therefore starts with an empty local registry and requires normal browser
authorization. Do not copy credential files, DPAPI ciphertext, or Keychain records to bypass that boundary; revoke
and remove an obsolete host connection through the matching host when retiring it. Advanced hosts
that inject custom registry or credential paths are responsible for keeping those overrides inside
the same namespace boundary.

## Multiple connection lifecycle

These APIs were introduced in 0.3.0 and remain compatible in 0.5.0. Host adapters should depend
on the exact SDK version and keep connection management in user-owned commands or settings. A host may publish
available authorization references for a model to select per call; the host fixes each reference's
connection binding as described below. Login, connection management, identities, and credentials
must never become model-controlled inputs.

The SDK registry can retain multiple named connection instances. `connectionName` is only a local
selector. After browser authorization, the SDK compares the same public
`Hub + clientAppId + workspace` binding using Core's trusted `on_behalf_of`: the newly authorized
Session replaces older local connections for that same identity, while different identities keep
separate Agent Sessions, credentials, and revocation lifecycles. None of these methods returns
access or refresh tokens:

```js
await transport.connectionsAdd({
  connectionName: 'shop-a',
  hubUrl: 'https://hub-a.example.com',
  clientAppId: 'merchant-agent',
  workspace: 'order-assistant',
});

await transport.connectionsList();
await transport.connectionsUse('shop-a');
await transport.login({ connectionName: 'shop-a' });
await transport.connectionsRemove('shop-a');
```

`connectionsAdd()` creates a new local instance for a new `connectionName`, registers only its
public metadata, and selects it; it does not fabricate or copy a login. Repeating the exact same
name and binding is idempotent, while reusing that name for different public metadata fails.
Browser authorization is required for every new, still-unauthorized selector. Hosts must expose
add/use only through user commands or settings, never as model tools. Each run and invocation
stays pinned to its captured connection; changing the current connection only changes the default
for future captures, not any authorization reference already available in a conversation.

When credentials exist, `connectionsRemove()` revokes the remote Agent Session before deleting
local credentials and public metadata. A failed remote revoke keeps both intact for retry. This is
different from `use(workspace)`: connection lifecycle selects a complete Hub/client/workspace
instance, while `use()` rebinds the same instance within the workspaces already granted to its
current business authorization. It never turns one authorized identity into another.
If the removed connection was current, the same atomic registry mutation selects the remaining
entry with the lexicographically smallest opaque connection key. Only removing the final entry
returns `currentConnectionKey: null`. The fallback selection affects new sessions only; existing
conversations and runs remain pinned to their captured connection.

Existing deterministic v1 registry entries remain readable and keep their credential key. The
registry is written as schema v2 only while at least one named instance exists; the
instance id is opaque local metadata, not a credential or an identity assertion sent to Core.
An SDK older than 0.3.0 fails closed on schema v2. Before downgrading below that version, use the
installed 0.3.0 or later SDK to revoke and remove every
named instance; after the last one is removed, the registry is written
back as schema v1. Do not delete credential files or Keychain entries manually.

### Per-call authorization references within one system

A host can use the existing API for two independently authorized identities on the same
`Hub + clientAppId + workspace` binding without switching the current connection. The host chooses
which authorizations are available to a conversation and assigns safe references such as
`store_a` and `store_b`, with user-approved display names. These references are not credentials,
`on_behalf_of` values, or new Core fields. Do not expose the raw `status()` result to a model.
The `authorized` state from `connectionsList()` only means local credentials exist; session
inspection and Core authorization still determine whether an operation can proceed.

Resolve each reference once to its opaque `connectionKey` and fixed `workspace`. Pass that pair
as the second argument to `startTurn`, `searchCapabilities`, `invoke`, and `completeRun`, or the
third argument to `resume`. Keep a separate run, capability revision, active tool set, and recovery
state for each authorization, even when the returned tool declarations and revisions are equal.
Do not resolve a mutable alias or current connection again when continuing an existing invocation.
A removed, revoked, or rebound connection must fail closed rather than fall back to another identity.

When the tool name, input schema, and public governance properties match, the host may show one
shared typed tool with this model-facing envelope:

```json
{"authorization_ref":"store_a","arguments":{"id":42,"name":"Updated product"}}
```

The outer object requires both fields and rejects additional properties. Its `authorization_ref`
enum contains only references available for that tool; `arguments` retains the original business
schema. The host validates and consumes the reference, then forwards only the inner `arguments`
to the SDK with the selected authorization's run and revision. If declarations differ, do not
merge them into this shared presentation. Connection management remains outside the model tools.
Persist each `invocation_id` with its captured authorization so approval recovery, uncertain outcomes,
and retries retain the same identity and invocation. This is host integration guidance using existing
SDK methods; the standalone MCP server does not add an authorization-selection tool.

## Login lifecycle

```js
await transport.login();
const status = await transport.status();
const workspaces = await transport.workspaces();
```

`login()` binds a random loopback callback, creates a PKCE request, and asks Core to open the one
stable authorization entry registered by the business system. That entry is not account-, tenant-,
or store-specific. It handles sign-in, account switching, and tenant/store selection, then the
business backend derives trusted user, tenant, roles, `principal`, and `on_behalf_of` from the
confirmed server-side session. The plugin never receives the business URL or business credential.

macOS uses Keychain. Linux and other POSIX systems require explicit opt-in to the current-user-owned
mode-`0600` file fallback. Windows stores each credential slot in a CurrentUser DPAPI-protected
binary file under LocalAppData. The ciphertext is bound to the CurrentUser protection scope plus
the host namespace and connection slot; copying it is not a supported login migration, while
Windows profile and enterprise recovery policies determine any roaming exceptions. The SDK invokes
the system Windows PowerShell 5.1 non-interactively with a fixed script and
sends dynamic values only through stdin. If PowerShell or DPAPI is unavailable, login fails closed.
Never implement a host-specific plaintext token field as a workaround.

The standard v1 factory login requests one workspace. Treat the public binding as
`Hub + clientAppId + workspace`; `connectionName` merely selects where that local attempt starts.
Register a new name and authorize in the business page when adding another identity. If the trusted
`on_behalf_of` matches an older same-binding connection, the SDK revokes and removes the older
local Session. If it differs, both remain independently selectable. Reauthorizing an existing name
uses a staging credential slot, so cancelling the browser flow leaves the working Session intact.
When that staged attempt confirms a different identity, the existing name remains attached to the
older identity and the newly current connection receives a collision-safe local suffix such as
`shop-2`; the suffix is derived only from the local selector, never from business identity. The
SDK does not silently steal the older identity's name.
Register another connection for another Hub or route. `use()` succeeds only when the selected
Agent Session explicitly includes that workspace.

`login()` always returns `state: "authorized"` after the new Session is safely stored. It also
returns `identityReconciliation` as `not_needed`, `distinct`, `replaced`, `deferred`, or
`cleanup_required`, plus `cleanupRequired`, `replacedConnections`, and `cleanupConnections`.
`deferred` or `cleanup_required` means authorization succeeded but an older connection still needs
inspection or cleanup. Show the warning and let the user retry status/removal; do **not** tell them
to authorize again. Registry mutations and same-binding reconciliation use cross-process locks,
and neither lock metadata nor the registry stores tokens or `on_behalf_of`. Lock keys are hashed
onto OS-released loopback listeners, so a process crash releases ownership automatically. A rare
unrelated port collision only serializes the operations or fails closed after a bounded wait.
If that bounded wait expires after a staged Session is already stored, `login()` keeps its
collision-safe local suffix and returns `cleanup_required`; show the warning instead of starting
another authorization.

Logout revokes the remote session before removing local credentials:

```js
await transport.logout();
```

If remote revocation fails, preserve the local credential so the user can retry instead of falsely
reporting a complete logout.

## One visible turn

Use stable host IDs. Retrying the same visible turn must reuse the same values.

```js
const turn = await transport.startTurn({
  clientConversationId: 'conversation-1',
  clientTurnId: 'turn-1',
  userMessageId: 'message-1',
  userInput: 'Find the employee named Ada',
  pageContext: { page: 'staff' },
  renderers: ['markdown'],
});
```

The response contains safe instructions, memory, reference-only knowledge, governance, a
`run_id`, a capability revision, and a bounded active typed-tool set. It does not contain model
credentials, Tool Provider URLs/secrets, hidden reasoning, or raw private route configuration.

Discover another authorized tool only when needed:

```js
const found = await transport.searchCapabilities({
  query: 'edit staff profile',
  runId: turn.run_id,
  limit: 8,
});
```

The host must replace the previous dynamic business-tool set rather than append schemas forever.
Only the current run/session/workspace authorization set can be searched.

## Governed invocation and recovery

```js
const result = await transport.invoke({
  invocationId: '<stable-64-hex-id>',
  capabilityRevision: turn.capability_revision,
  agentRunId: turn.run_id,
  tool: 'staff_edit',
  arguments: { id: '42', display_name: 'Ada' },
});
```

The SDK sends the call to BailingHub, not directly to the business endpoint. Core revalidates the
session, route, tool, ACC declaration, approval state, limits, and business authority. Do not let
the model supply a Hub URL, credential, approval decision, acting subject, or arbitrary route.

If the result is awaiting approval, in progress, retryable before dispatch, or accepted with an
unknown outcome, preserve the original `invocation_id` and resume it:

```js
const resumed = await transport.resume(result.invocation_id);
```

Never create a replacement write invocation merely because polling timed out.

## Complete the visible run

```js
await transport.completeRun(turn.run_id, {
  status: 'completed',
  assistant: {
    message_id: 'assistant-message-1',
    visible_text: 'The profile was updated.',
  },
  model: { provider: 'example-provider', name: 'example-model' },
  runtime: { host: 'example-agent-host', adapter: 'bailinghub-adapter' },
  usage: { input_tokens: 120, output_tokens: 24, total_tokens: 144, tool_calls: 1 },
});
```

Only visible final content and the public usage allowlist are mapped. Do not pass hidden reasoning,
thinking chunks, complete sensitive arguments, or raw business responses. Reuse the same assistant
message ID and payload until Core confirms completion.

## Visible conversation archive

Version 0.4.0 introduced the host-only `syncConversationArchive(envelope, { members })` API.
Same-binding usage retains the Core 0.6.0 API minimum; use Core 0.7.0 for the 0.5.0 feature set.
It does not add an MCP/model tool or change
business API declarations.

```js
await transport.syncConversationArchive({
  clientArchiveId: persistentArchiveUuid,
  clientConversationId: originalClientConversationId,
  events: pendingVisibleEvents,
}, {
  members: frozenMembers.map((member) => ({
    connectionKey: member.connectionKey,
    workspace: member.workspace,
    expectedSessionId: member.sessionId,
    label: member.label,
  })),
});
```

The host persists a random archive UUID and the ordered member set before first upload. Member
zero is the fixed writer. In this legacy same-binding form, all members share one Hub, public client
application and workspace (the scope introduced in 0.4.0);
the current/default connection is never consulted. Core enrolls the group, each member confirms
with its own original Agent Session, and only the writer can append visible events after all
members are confirmed and still valid. Labels are display hints, not identity assertions.

Events use `event_id`, consecutive positive `sequence`, `client_turn_id`, and `kind`:
`turn_start`, `user_message`/`assistant_message` with `content`, `run_link` with the original
`run_id` and `member_session_id`, or `turn_end` with `status` (`completed`, `failed`, `cancelled`).
Conversation and turn IDs must match the original `startTurn` values for run links. Visible
messages are text only; attachments, cards, hidden reasoning and arbitrary local tool payloads
are outside this contract. The SDK projects allowed fields and sends bounded batches (up to
50 events and 192 KiB). Oversized events are rejected, never silently truncated.

The result is `{ schema: 'bailing.agent-conversation-audit-ack.v1', conversation_id,
last_sequence }`. An empty event array can enroll/reconfirm the fixed group and return its
cursor without reading any transcript. The host owns durable event IDs, frozen event payloads,
ordering, acknowledgement persistence and retries. Retry an uncertain upload with the same
events; conflicting content under an existing event ID or sequence is an error. Never repeat a
business invocation to repair an archive failure.

The archive is separate from authorization run completion and per-authorization memory.
Only the deployment's administrative `runs:read` audit domain can read combined text; there is
no Agent Session transcript read API. Empty selection must make no SDK request. Unsupported
Core/SDK, revoked members and failed uploads must be reported as incomplete/unsupported archive
state, not as successful archival or as permission to use another connection. Historical final
replies not retained by the host cannot be reconstructed from execution summaries.

## Cross-system conversations (0.5.0)

SDK 0.5.0 with Core 0.7.0 supports a compatible host selecting independent systems on **one Hub
and one administrator audit domain**. Each target keeps its own Client App, workspace,
Agent Session, run, declarations and invocation records. Duplicate Sessions and cross-Hub groups
are rejected. The SDK routes calls; it does not plan dependencies or decide which system receives
the user's text. A host must explicitly control target selection, separate conflicting tool
declarations and send only the context needed for each target's task.

Capture and persist the full public binding when the user selects a target:

```js
const expectedBinding = {
  hubUrl: selected.hubUrl,
  clientAppId: selected.clientAppId,
  workspace: selected.workspace,
  sessionId: selected.sessionId,
};
const targetOptions = {
  connectionKey: selected.connectionKey,
  workspace: expectedBinding.workspace,
  expectedBinding,
};
await transport.status(targetOptions);
await transport.startTurn(originalTurnInput, targetOptions);
await transport.searchCapabilities({ query: targetTask, runId: originalRunId }, targetOptions);
// invoke/completeRun use the same options; resume(originalInvocationId, {}, targetOptions).
```

`expectedBinding` is optional for backward compatibility but required by a cross-system host.
It requires an exact key; aliases/default selection are rejected. It is local host metadata and
never enters the business arguments or HTTP DTO. SDK checks the original registry and credential
binding before refresh/status/business dispatch; identity substitution throws
`publicCode: 'agent_binding_changed'` (403, non-retryable). Freeze options for each invocation and
reuse the same run/revision/invocation during recovery. Scope restoration does not recreate a lost
invocation mapping or authorize a replacement Session. Local checks do not replace Core or the
business system's final authorization and do not promise an atomic transaction across systems.

Pass `signal: turnAbortController.signal` in the same options for cancellable status and business
calls. The SDK snapshots the signal before asynchronous reads and combines it with the HTTP timeout.
Cancellation before dispatch has `agent_request_cancelled` (499, non-retryable,
`definitive_rejection`). After an invocation or resume has been dispatched, cancellation retains
`accepted_unknown` and the original `invocationId`: cancellation is not proof the action was undone.
The SDK does not replay it. Keep archive synchronization independent of turn cancellation; a host
may use a separate completion lifecycle to record the ended target run's summary.

Cross-system archive members add required `hubUrl` and `clientAppId` to the existing member shape:

```js
const members = frozenTargets.map((target) => ({
  connectionKey: target.connectionKey, hubUrl: target.hubUrl,
  clientAppId: target.clientAppId, workspace: target.workspace,
  expectedSessionId: target.sessionId, label: target.label,
}));
const support = await transport.getConversationArchiveCapabilities({ members });
if (!support.cross_binding_members || support.member_bindings !== 'session-client-route.v1') {
  throw new Error('This Hub does not support cross-system conversations.');
}
await transport.syncConversationArchive(originalEnvelope, { members });
```

Check for the new SDK method before enabling this host mode, and repeat capability and original
member validation when restoring the scope. `GET /agent-api/v1/conversation-audits/capabilities`
uses the fixed writer's bearer and sends no text. A 404 yields `cross_binding_members: false`;
invalid capability data fails closed. Sync negotiates again before cross-system create. A missing
capability rejects with `conversation_audit_cross_binding_unavailable`; it never falls back to a
same-binding archive, broadcasts completion text, or repeats business actions.

The low-level `createConversationAudit` accepts either old `memberSessionIds/memberLabels` or
new `members: [{ sessionId, clientAppId, workspace, label? }]`. New membership is sent as
`schema: 'bailing.agent-conversation-audit-create.v2'` with
`members: [{ session_id, client_app_id, route, label? }]`; member zero must match the writer.
Each original member still confirms with its own bearer and Core verifies each member's binding
and run links. Registration/confirmation/ACK and event shapes are unchanged. Same-binding host
archives keep the old v1 request even when their local members include the new frozen fields.
All archive requests recheck local group membership, including after asynchronous negotiation;
revocation is independently enforced by Core. Combined text stays in the administrator audit
domain. This extension adds no Agent bearer transcript reader or cross-system memory sharing.

## Explain selected systems before searching their tools

A host can show what each selected business system is for before the model chooses where to
search. For example, an order service can describe online fulfillment while a workforce service
describes scheduling. These are controlled product descriptions, not instructions, tool grants,
or proof that a business operation is available. Authorization names supplied by users remain
display labels; never infer system identity or access rights from them.

After validating the complete frozen session scope, read only its selected members:

```js
if (typeof transport.getSystemInfo === 'function') {
  const description = await transport.getSystemInfo({
    connectionKey: selectedTarget.connectionKey,
    workspace: selectedTarget.workspace,
    expectedBinding: {
      hubUrl: selectedTarget.hubUrl, clientAppId: selectedTarget.clientAppId,
      workspace: selectedTarget.workspace, sessionId: selectedTarget.sessionId,
    },
    signal: turnAbortController.signal,
  });
  // Associate description.binding with the original selected target reference.
  // description.system is positioning data, never a system prompt or permission grant.
}
```

`getSystemInfo` requires an exact `connectionKey` and `workspace`; it never selects a default,
enumerates workspaces, calls bootstrap, creates a run, loads tools, or sends user messages.
`expectedBinding` freezes the original session identity for restored and multi-system scopes.
Without it, the SDK captures that exact connection's current identity. Local binding checks run
before dispatch and after success or failure. The read uses the original Agent bearer against
`GET /agent-api/v1/workspaces/:workspace/system-info` and is never cached by the SDK.

The response retains the wire fields: `schema_version: 'bailing.agent-system-info.v1'`,
`binding: { client_app_id, session_id, workspace }`, `metadata_status`, `revision`, `system`,
`tool_status`, `availability`, and optional `unavailable_reason`. `configured` metadata includes
`system: { name, summary, domains, boundaries }`; `missing` returns `system: null` and
`revision: null`. Names are at most 120 characters, summaries 400, and each list contains at most
six strings (120 characters per domain, 160 per boundary). Unknown fields are not forwarded.

Tools always report `not_loaded`: search remains necessary to learn what this authorization
actually allows. `availability: 'unknown'` makes no claim about business connectivity. An
`unavailable` result can name `agent_client_disabled` or `agent_direct_disabled`; it does not
revoke the scope or authorize bypassing configuration. No capability count or grant is inferred.

Older SDKs can omit the method. An old Core's explicit unknown-endpoint response becomes
`publicCode: 'system_info_unsupported'`; a missing route is not classified as unsupported.
Malformed metadata reports `system_info_invalid`; ordinary network/5xx errors remain temporary
and can be retried against the same identity. The host may render unknown positioning or use a
controlled local dictionary for these description failures. It must not swallow 401/403,
`agent_binding_changed`, or cancellation, expand the scope, or fall back to another session.
This optional seam leaves the existing authorization, tool discovery, approval, and archive
flows intact and adds no business API requirement.

## Host-adapter acceptance

Before publishing an adapter:

1. install it in a clean host profile using public registry packages only;
2. verify the SDK is a regular exact dependency, not an optional peer or local path;
3. complete browser login, status, one read, one reversible write, approval/resume, completion,
   logout, and business-side revoke;
4. confirm BailingHub shows the conversation and governance trace;
   for archives, also check all original members, visible messages, run links, lost-ACK retry,
   offline recovery and member revocation against Core 0.7.0;
5. scan source, tarballs, logs, screenshots, and connection metadata for secrets/private hosts;
6. confirm hidden reasoning and raw business payloads never reach Core.

For the complete Core/business/host setup, see the
[BailingHub Agent Client v1 Integration Guide](https://github.com/bailinghub/bailinghub/blob/main/docs/AGENT_CLIENT_QUICKSTART.en.md).

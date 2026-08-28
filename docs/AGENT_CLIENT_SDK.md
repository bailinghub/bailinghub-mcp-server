# BailingHub Agent Client SDK

[简体中文](AGENT_CLIENT_SDK.zh-CN.md) | English

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
npm install bailinghub-mcp-server@0.2.0
```

`0.2.0` is the stable Agent Client SDK release. A host adapter must remain private until that exact
version resolves from the public npm registry; never substitute a local path in a public manifest.

Required server surfaces:

- BailingHub Agent Auth v1;
- BailingHub Agent Client Runtime v1;
- route `tools.agent_direct` and `agent_client` configuration;
- a registered public Client App ID and business authorization page.

The older Client Token/MCP job mode remains a separate compatibility path. Agent Client hosts do
not require `BAILINGHUB_CLIENT_TOKEN`.

## Configuration ownership

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
connection registry, POSIX credential files, macOS Keychain accounts, and local lock scopes.
When the namespace is unset, every historical path and Keychain account stays exactly unchanged
for backward compatibility.

Namespaces do not copy or migrate credentials between hosts. The first run after a host adopts a
new namespace therefore starts with an empty local registry and requires normal browser
authorization. Do not copy credential files or Keychain records to bypass that boundary; revoke
and remove an obsolete host connection through the matching host when retiring it. Advanced hosts
that inject custom registry or credential paths are responsible for keeping those overrides inside
the same namespace boundary.

## Multiple connection lifecycle

> **Unreleased candidate:** the APIs in this section are implemented on the current development
> branch and require a matching SDK/host candidate. They are not part of the public `0.2.0`
> package. Align exact versions in the order Core -> SDK -> host adapter before release.

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
add/use only through user commands or settings, never as model tools or model-controlled selectors.
Existing conversations and runs stay pinned to the connection captured when they were created;
a selection affects new sessions only.

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
An older SDK fails closed on schema v2. Before downgrading, use the matching candidate to revoke
and remove every candidate-only instance; after the last one is removed, the registry is written
back as schema v1. Do not delete credential files or Keychain entries manually.

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
mode-`0600` file fallback. Agent Session fails closed on Windows until a native secure store is
available. Never implement a host-specific plaintext token field as a workaround.

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

## Host-adapter acceptance

Before publishing an adapter:

1. install it in a clean host profile using public registry packages only;
2. verify the SDK is a regular exact dependency, not an optional peer or local path;
3. complete browser login, status, one read, one reversible write, approval/resume, completion,
   logout, and business-side revoke;
4. confirm BailingHub shows the conversation and governance trace;
5. scan source, tarballs, logs, screenshots, and connection metadata for secrets/private hosts;
6. confirm hidden reasoning and raw business payloads never reach Core.

For the complete Core/business/host setup, see the
[BailingHub Agent Client v1 Integration Guide](https://github.com/bailinghub/bailinghub/blob/main/docs/AGENT_CLIENT_QUICKSTART.en.md).

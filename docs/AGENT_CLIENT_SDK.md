# BailingHub Agent Client SDK

[简体中文](AGENT_CLIENT_SDK.zh-CN.md) | English

`bailinghub-mcp-server/sdk` is the host-neutral integration seam for a local Agent framework. It
owns browser authorization, PKCE, connection metadata, secure Agent Session storage, token refresh,
and BailingHub Runtime DTO mapping. A host adapter owns its own lifecycle, model invocation,
visible conversation IDs, and dynamic tool registration.

The SDK does not embed BailingHub, register a business system, generate a business authorization
page, or store model-provider credentials.

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
| `connectionName` | local readable alias | no |

Do not add BailingHub Client Tokens, admin tokens, business passwords/cookies, Tool Provider
Secrets, business API URLs, model API keys, or Agent access/refresh tokens to host configuration.
The model provider and key remain in the host's own credential system.

## Login lifecycle

```js
await transport.login();
const status = await transport.status();
const workspaces = await transport.workspaces();
```

`login()` binds a random loopback callback, creates a PKCE request, opens the business system's
configured authorization page, and stores the returned Agent Session. The business system derives
user, tenant, roles, and allowed route from its current authenticated backend session.

macOS uses Keychain. Linux and other POSIX systems require explicit opt-in to the current-user-owned
mode-`0600` file fallback. Agent Session fails closed on Windows until a native secure store is
available. Never implement a host-specific plaintext token field as a workaround.

The standard v1 factory login requests one workspace. Treat a connection as
`Hub + clientAppId + workspace`; use a different alias and a new browser authorization for another
Hub or route. `use()` succeeds only when the existing Agent Session explicitly includes that
workspace; do not advertise unrestricted cross-route switching.

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

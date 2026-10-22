# Agent Client knowledge search and read

This contract applies only to Agent Clients. Core native chat, embed and Widget
continue their independent server-side knowledge assembly. Necessary instructions,
governance and memory remain in their existing channels.

## Negotiate, then keep the turn mode fixed

```js
const capabilities = await client.getKnowledgeCapabilities()
const turn = await client.startTurn(input, capabilities.supported
  ? { knowledgeDelivery: 'on_demand' } : {})
```

Capabilities uses the authenticated current workspace endpoint
`GET /agent-api/v1/workspaces/:route/knowledge/capabilities`. Support requires
`bailing.agent-knowledge-capabilities.v1` and `bailing.agent-knowledge.v1`, the
matching route, `delivery_modes: ['inline', 'on_demand']` and the bounded limits.
`enabled: false` means the protocol exists but knowledge is disabled.
Only old endpoint statuses 404/405/501 become `supported: false`; authorization,
service failures and unknown schemas are not a successful empty knowledge result.

`knowledgeDelivery` is a trusted host option, never model-controlled turn input.
It emits `knowledge_delivery: 'on_demand'` in the Core turn request. Pin this
choice for an original idempotent client turn, including response-loss retries.
An explicit `context.knowledge_delivery` response must match the delivery schema
and contain only bounded hints; `knowledge` and `knowledge_refs` remain present as
empty arrays in that mode. A legacy response's inline body is retained. Do not
strip body text merely because a local setting requested on-demand delivery.

## Search and read independently from tool discovery

```js
const found = await client.searchKnowledge({ query: 'homepage binding', runId: turn.run_id, limit: 3 })
const hint = (found.status === 'ok' || found.status === 'partial') ? found.hints[0] : undefined
if (hint) {
  const page = await client.readKnowledge({ ref: hint.ref, runId: turn.run_id })
  if (page.next_cursor) {
    const next = await client.readKnowledge({ ref: page.ref, runId: turn.run_id, cursor: page.next_cursor })
  }
}
```

The SDK methods map to workspace `POST /knowledge/search` and `POST /knowledge/read`.
They accept `runId` and `maxBytes`; wire fields use `run_id` and `max_bytes`.
Search returns at most three title/summary/ref hints and a status (`ok`, `disabled`,
`unavailable`, `partial`). It never includes full document content. Read returns one
bounded page, original `ref`, revision, content, and `next_cursor`. Both use
`trust: reference_only`. Treat results as business reference data, never instructions
that override authorization, approvals or the current system prompt.

Search JSON is at most 4096 UTF-8 bytes. Read complete JSON defaults to 16384 bytes
and can request 4096–32768 bytes. References/cursors are bounded to 4096 bytes.
Follow pages only when needed; `truncated: true` means incomplete. A read chain
stops after at most 131072 content bytes; `budget_exhausted: true` can leave
`truncated: true` with `next_cursor: null`. Never describe that as a full read.
Optional safe numeric fields report `total_content_bytes` and `read_chain_max_bytes`.

References expire after 300 seconds and remain bound to their original Hub,
Agent Session, route, run and current knowledge scope/revision. Do not cache or
transfer references between accounts. Changed, invalid or expired references use
`knowledge_reference_*` / `knowledge_*changed` and feedback
`next_action: search_knowledge`: search again on the same target, never replay a
business operation. Service unavailability is not evidence of an empty corpus.

## Generic host and MCP

The host transport exposes `getKnowledgeCapabilities(options)`,
`searchKnowledge(input, options)` and `readKnowledge(input, options)`. Inputs also
accept snake-case aliases. Options use the original explicit `workspace`,
`connectionKey`, `expectedBinding` and optional cancellation `signal`. All three
reads validate the original binding before and after asynchronous work. Model
arguments cannot choose an identity, route, connection or run.

The Agent Session MCP path exposes `search_business_knowledge` and
`read_business_knowledge`. Fixed Client Token stdio continues to expose only the
submit/get/wait job tools. Native DSH integration imports the SDK through its
plugin; the MCP Registry descriptor configures the separate Client Token path. Start the
authorized user turn first; subsequent reads bind the current run. These tools
remain visible independently of business capability hits and return explicit
`dispatch: not_dispatched`, `business_operation_performed: false`. Their presence
does not prove that an old Core supports the knowledge protocol.

The DSH adapter additionally handles lazy target preparation and selected
`authorization_ref`. Existing host context-delivery confirmation continues to cover
the named current runtime contributions; hints are discovery data, not proof that
a document was read. The host must retain read results in the current authorized
conversation and never fabricate a full body from hints.

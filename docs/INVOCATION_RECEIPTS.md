# Read the outcome of an original operation

这是尚未公开发布的只读回执候选。它解决的是“刚才那次操作到底进行到哪一步”：例如商城商品上架已经通过审批，但还没有实际派发，客户端查询回执时可以看到“已批准、未派发”，查询本身不会让商品上架。若上架请求发出后断网，也应保留原调用 ID 和原授权读取已有证据，不能把查询失败当成重新上架的依据。这批只增加查询接口；主动恢复执行仍属于既有恢复流程，接入方需要分别处理。

A local assistant submitted a product change and the connection dropped before it received the result. A host can inspect the original receipt to see the evidence BailingHub currently holds. Inspection does not repeat the product change, approve it, or resume a waiting operation.

The receipt is an observation at `observed_at`. Its `business_operation_performed: false` describes **this inspection request**. The original operation may already have executed; inspect `result`, `dispatch_state`, `approval`, and `journal_state` to understand it.

## Host integration

Use the original invocation ID and the host's recorded authorization binding:

```ts
const receipt = await transport.inspectInvocation(original.invocationId, {
  connectionKey: original.connectionKey,
  workspace: original.workspace,
  expectedBinding: {
    hubUrl: original.hubUrl,
    clientAppId: original.clientAppId,
    workspace: original.workspace,
    sessionId: original.agentSessionId,
  },
  signal,
});
```

All binding fields are required by this host method. They come from the original trusted invocation record, never from a model choosing a replacement connection. A different global default is ignored. The SDK checks the frozen registry and Agent Session before requests and again after the response. If the original connection changes, it refuses the result.

The low-level `BailingHubAgentClient` also exposes `inspectInvocation(invocationId)` and `getInvocationInspectionCapabilities()`. A low-level caller owns the connection and access-token provider lifecycle. Hosts that use the SDK connection registry should use the facade above for its binding checks.

## What is requested

Each inspection first requests:

```text
GET /agent-api/v1/tool-invocations/inspection-capabilities
```

The negotiated contract must contain `schema_version: bailing.agent-invocation-inspection-capabilities.v1`, `receipt_schema: bailing.agent-invocation-receipt.v1`, and `read_only: true`. It then requests:

```text
GET /agent-api/v1/tool-invocations/{original_invocation_id}/receipt
```

Neither request carries new tool arguments, conversation text, or an alternative target. The SDK never substitutes `/resume` or a new invocation. Normal Agent Session access-token refresh may still occur through the existing authorization flow.

## Reading the result

| Field | Meaning |
| --- | --- |
| `invocation_id`, `agent_run_id`, `route`, `tool` | Original execution references. Core derives the run and tool from the original execution record; the SDK verifies the requested ID, selected workspace, and nested result identity. |
| `result` | The existing invocation result shape, or `null` when no result is available. |
| `result_source` | `job`, `journal`, or `none`; identifies the evidence used for `result`. |
| `dispatch_state` | `not_dispatched`, `attempted`, or `unknown`. An attempt alone does not prove business success. |
| `approval` | Current `none`, `pending`, `approved`, or `denied` status. Pending, approved, and denied require an approval ID; none has no ID. Approved does not by itself mean dispatched. |
| `journal_state` | `absent`, `dispatching`, `response_recorded`, `completed`, `uncertain`, `evidence_degraded`, or `unknown`. It describes dispatch evidence, not a new business operation. |

Unresolved evidence stays unresolved. The SDK returns only the documented receipt fields and the existing invocation-result allowlist; it does not forward request arguments, credentials, arbitrary journal records, or extra server fields. Receipt access remains subject to Core authorization. It is not a way to bypass revoked access or the original approval rules. The SDK does not create another local invocation journal. A host that already has a trusted invocation journal can compare the returned run and tool to that existing record when integrating receipt inspection.

## Compatibility and failures

| Outcome | Host action |
| --- | --- |
| Capability endpoint is absent or advertises an incompatible contract | `agent_schema_unsupported`, `category: unsupported`, `next_action: check_compatibility`. Existing invocation and resume interfaces keep their behavior. |
| Support is confirmed, but Core returns `invocation_not_found` for the original ID | Keep the ID and HTTP 404. Feedback is `invocation_outcome_unknown`, `next_action: inspect_original`, `retryable: false`. Missing evidence does not authorize resending the operation. |
| Core cannot validate the original execution record | Keep `invocation_record_invalid`, the original ID, and `inspect_original` with `retryable: false`; do not infer business success or resend it. |
| Temporary transport failure | Feedback remains `transport_unavailable`. `inspect_original` may retry this same read-only lookup; it never permits a new business invocation. |
| Original authorization is unavailable or its binding changed | Keep the original record. Follow the authorization/scope feedback without substituting a default connection or another Agent Session. |
| Invalid receipt or mismatched ID/workspace | Reject the receipt. Do not present it as an authoritative business result. |

The additive feedback operation is `inspect`. Hosts must preserve it when presenting structured failures. This candidate adds a host SDK interface; it does not automatically add a DSH model tool, alter business backends, or deploy Core.

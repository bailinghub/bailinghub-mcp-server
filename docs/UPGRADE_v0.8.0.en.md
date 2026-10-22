# Upgrade to SDK / MCP 0.8.0

The complete pairing is Core 0.10.0, SDK 0.8.0 and DSH 0.8.0. Existing Client API v1, Agent Auth/Runtime v1, credentials and original operation IDs remain. Do not purge history or replay business actions awaiting inspection.

1. Back up and upgrade Core first, applying only its outstanding migrations according to its guide. Installing the SDK does not migrate the Hub database.
2. Finish or checkpoint active tasks. Preserve credentials, sessions, task bindings, approvals and invocation/model-operation journals.
3. SDK hosts run `npm install --save-exact bailinghub-mcp-server@0.8.0`; standalone MCP configuration pins `bailinghub-mcp-server@0.8.0`. DSH users install `dsh-bailinghub@0.8.0`, which installs the exact SDK.
4. Restart and verify the actual loaded modules and dependency tree. Library overrides do not propagate into an installing host. Audit host production dependencies separately; a library audit does not certify the whole application.

## Adopt each feature deliberately

- **Complete tool arguments:** pass objects directly. The SDK measures the serialized UTF-8 bytes against 1 MiB. Do not turn source into a JSON string or crop it to bypass validation. Core/business fields may remain smaller; handle definitive rejection without replaying an unknown invocation.
- **Guidance detail:** observe discovery truncation/guidance flags, then read one selected tool's detail. Preserve its route, capability revision and declaration binding; treat it as reference only.
- **On-demand knowledge:** probe `getKnowledgeCapabilities()` first. Only explicit support enables the trusted host option `knowledgeDelivery:'on_demand'` on a new turn. Pin the original turn mode. Unknown protocols and authorization failures are not empty knowledge. Preserve the original ref, run and authorization across pages; `truncated` is not full-document completion. See [the protocol](AGENT_KNOWLEDGE.md).
- **Output budgets:** use `resolveModelOutputBudget()` and `modelOutputOptions()` for new requests. Consume the default and ceiling separately, retaining deliberate user budgets and declared scope. Reject wrong keys or excess budgets; do not rewrite saved intent/digests or switch models automatically. Legacy descriptors without the new grouped fields retain legacy behavior. See [budgets and continuation](USAGE_SERVICE.md).

## Recovery and acceptance

Only a positively identified truncation reason, final original operation receipt and saved checkpoint permit the host to prepare a new model continuation. Missing final frames, network uncertainty and pending originals require `inspectModelRequest()` first. Use `BailingHubAgentClient.inspectInvocation()` for read-only business receipt inspection; `resume()` is not a query. Never execute truncated tool arguments or automatically repeat completed or uncertain business effects.

Use a no-side-effect fixture to check input bounds, on-demand knowledge and old-Core fallback, separate budgets/output keys, original-ID recovery and both existing Client Token/Agent Session paths. Host automatic continuation needs its own bounded counts/cost/time, cancellation, approval, compaction and restart/deduplication acceptance. Installing this package does not add that task loop by itself.

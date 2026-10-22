# MCP / Agent Client SDK 0.8.0: complete inputs and knowledge on demand

When an agent saves a complete HTML/CSS page, an older adapter can reject its arguments before the business service receives them. Other tasks need only a stock lookup or one operating rule but receive repeated guidance bodies during preparation. This release addresses input capacity and disclosure separately, paired with **Core 0.10.0 / SDK 0.8.0 / DSH 0.8.0**.

## Additions and fixes

- Agent tool arguments allow 1 MiB measured from the UTF-8 bytes of the actual `JSON.stringify(arguments)`. Keep arguments as objects. Core envelope and business-field limits remain independent. Oversize failures expose safe size scalars and `not_dispatched`, never the full content.
- Short tool descriptions can advertise additional guidance. Use `getToolDetail()`, or Agent Session MCP `search_business_capabilities` with `tool_name` and `include_usage_guidance`, to read bounded guidance for one selected tool under the current authorization, run and capability revision.
- Add `getKnowledgeCapabilities()`, `searchKnowledge()` and `readKnowledge()`, plus Agent Session MCP `search_business_knowledge` and `read_business_knowledge`. Fixed Client Token stdio still exposes only submit/get/wait job tools. The native DSH plugin imports the SDK rather than using the MCP Registry descriptor. Negotiated support enables hints and explicit paginated reads; unsupported servers retain inline knowledge. Reference knowledge cannot override instructions, authorization, approval or memory. Core native chat and embed knowledge assembly stay unchanged.
- Add `resolveModelOutputBudget()` and `modelOutputOptions()` to `bailinghub-mcp-server/usage`. Separate a request default, service ceiling and optional verified provider ceiling, with explicit output parameter and reasoning/answer scope. Legacy catalogs remain compatible. Do not rewrite saved requests, clamp budgets or silently rename parameters.
- Update the MCP SDK to 1.32.1 and related production dependency fixes. Publication retains normal tests, audit and prepack gates.

## Long tasks and original operations

A completed provider exchange, a complete answer and a completed task are different states. A host can checkpoint truncation and prepare a new model operation; this SDK neither resends automatically nor implements the host's continuation loop. Missing final receipts and unknown outcomes require original-ID inspection first. Truncated tool arguments are not executable, and completed business actions must not repeat during continuation. `inspectInvocation()` is read-only; `resume()` can perform the first dispatch of an approved original operation and is not polling.

## Upgrade and observe

Upgrade Core before installing exact SDK 0.8.0. DSH users should install the matched plugin without manually mixing SDK versions. Preserve credentials, sessions, tasks and original operation records. Required business capabilities must already exist; larger SDK input capacity changes neither business-field limits nor permissions.

Check the existing Client Token and Agent Session flows, then verify on-demand knowledge, reference pagination/expiry, input bounds, legacy catalog fallback and the selected model output field. Actual task continuation, cancellation UI and business-effect deduplication remain host acceptance responsibilities. See [the upgrade guide](UPGRADE_v0.8.0.en.md).

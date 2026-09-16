# Local Agent attachment space: host SDK integration

Use this when a local Agent produces a file that another system needs through a URL. The host registers an approved image from the current conversation, supplies its bytes, and receives a stored image URL from BailingHub. The Agent can then pass the URL to an existing business tool.

The first increment accepts PNG, JPEG and WebP images. Examples include campaign artwork for a content platform, a chart image for a reporting system, or product pictures for a shop. Each receiving system must already expose the required URL-based action. This is not a claim of general document or video support.

Pair Core 0.8.0 / SDK 0.6.0 / DSH 0.6.0. Hosts must integrate the documented interfaces; original identities, permissions and approvals remain enforced.

## Host interface

`createAgentClientTransport()` adds `uploadArtifact(input, options)` and `getArtifact(uploadId, options)`. Both require an explicit `connectionKey`, `workspace`, and `expectedBinding` containing the original Hub URL, clientAppId, workspace and sessionId. There is no fallback to a default connection.

```ts
const target = {
  connectionKey: selected.connectionKey,
  workspace: selected.workspace,
  expectedBinding: {
    hubUrl: selected.hubUrl,
    clientAppId: selected.clientAppId,
    workspace: selected.workspace,
    sessionId: selected.sessionId,
  },
  signal,
};
const uploaded = await transport.uploadArtifact({
  uploadId, // persist a 64-character lowercase hex ID before dispatch
  body: generatedImageBytes, // Uint8Array from the authorized host artifact store
  name: 'campaign-banner.png',
  mime: 'image/png',
  sha256: originalDigest,
  clientConversationId: originalConversationId,
  clientTurnId: originalTurnId,
  // runId: originalRunId, when an owned business run already exists
}, target);
```

The SDK freezes the byte buffer before authentication awaits, computes its SHA-256, checks a supplied digest, sends raw bytes, and verifies the returned receipt against the original target and content. It never reads an arbitrary filesystem path or fetches an arbitrary image URL for the model.

Initial support: PNG, JPEG, WebP; 6 MiB maximum per image. The administrator may set a smaller limit or MIME subset. The workspace must explicitly enable `agent_client.artifact_upload` and select a registered storage. This release produces public image URLs for content intended to be publicly readable. File retention is controlled by the self-hosted deployment; no conversation expiry or cleanup policy is imposed.

## Recovery

The receipt includes `upload_id`, `workspace`, `session_id`, `sha256`, `bytes`, original conversation/turn references, `state`, and `next_action`. `ready` includes `url`; `pending` requires recovery of the original upload. No storage keys or diagnostic response bodies are projected.

After an uncertain response, use `getArtifact(originalUploadId, originalTarget)`. If ready, use that receipt without reading or re-uploading the local file. If pending or `artifact_not_found`, retry the same upload with the original metadata and bytes. Preserve the ID across process restarts. A changed artifact or destination must not reuse the original ID. The server may repeat a PUT of identical bytes to the same object key after a storage/DB acknowledgement gap; it does not create a second logical image reference.

Stable errors include `artifact_unsupported`, `artifact_upload_disabled`, `artifact_storage_unavailable`, `artifact_upload_pending`, `artifact_conflict`, `artifact_storage_changed`, `artifact_content_mismatch`, `artifact_too_large`, and `artifact_type_not_allowed`. HTTP 404 from an older Core is unsupported, while a supported Core's missing receipt remains `artifact_not_found`. Transport timeouts and connection failures preserve the uncertain disposition and are not automatically retried.

Once a receipt is ready, use its URL directly. There is no need to ask BailingHub for the address again for every business use. Receipt lookup is for recovering an uncertain upload or restoring saved upload state.

Uploading is separate from applying a business change. For a complete image collection, wait until every required image is ready before submitting the final list; retain images the user did not ask to remove. An uncertain business write must retain its original invocation, not create another one.

Hosts with multi-authorization conversations must validate the entire original selected scope before uploading or recovering. Selecting several systems does not grant permission to send files to all of them. Only the explicit selected target receives file bytes.

## Business limits and original-call recovery

The matching Core release provides configurable Hub tool limits and honors original hour/day windows. New pre-dispatch rejections preserve encrypted original arguments. SDK invocation and resume responses retain optional `retry_after_ms` and `rate_limit` (level, count, window_sec, scope, source). These limits are shared per provider/tool across users and conversations. Follow the original invocation after waiting; never replay an uncertain write or reconstruct missing historical arguments. Older Core responses without these fields remain supported.

## Upload run-link correction

`artifact_run_turn_mismatch` is an HTTP 403 rejection before storage. It proves that the referenced run belongs to the original Agent Session, client, workspace and conversation, but to another turn. `artifact_run_mismatch` remains the non-repairable response for other link mismatches. The SDK preserves these distinct codes and never retries, replaces metadata or removes a run ID by itself.

A matching DSH release can recover a legacy rejected upload only after this dedicated code and an explicit `artifact_not_found` for the original upload ID. It first persists a separate immutable correction record, then reuses the original upload ID, bytes, authorization, conversation and upload turn without the proven stale optional run ID. Ready receipts are reused; unknown outcomes and local recovery gaps must not be treated as permission to start another upload. Older Core/SDK combinations keep those legacy failures blocked.

Tool names remain compatible. Eligible registered images may come from generation or user-provided files explicitly selected for business use; ordinary chat attachments are not uploaded automatically. Current MIME and size limits are unchanged.

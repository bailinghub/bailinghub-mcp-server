# Generated image delivery (candidate)

Use this when an Agent generates product pictures locally and an online shop accepts image URLs. The host supplies the bytes; BailingHub stores each image and returns its URL. The existing governed tool then updates the product, with its original authorization and approvals.

This is an unreleased additive candidate. Install matching Core and SDK sources/packages; stable Core 0.7.0 / SDK 0.5.0 do not include it. It is a host SDK API, not an automatic upload tool added to every MCP server or desktop application.

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
  name: 'product-front.png',
  mime: 'image/png',
  sha256: originalDigest,
  clientConversationId: originalConversationId,
  clientTurnId: originalTurnId,
  // runId: originalRunId, when an owned business run already exists
}, target);
```

The SDK freezes the byte buffer before authentication awaits, computes its SHA-256, checks a supplied digest, sends raw bytes, and verifies the returned receipt against the original target and content. It never reads an arbitrary filesystem path or fetches an arbitrary image URL for the model.

First candidate: PNG, JPEG, WebP; 6 MiB maximum per image. The administrator may set a smaller limit or MIME subset. The workspace must explicitly enable `agent_client.artifact_upload` and select a registered storage. This candidate produces public image URLs, suitable for product display. Private documents are outside this first increment. File retention is controlled by the self-hosted deployment; no conversation expiry or cleanup policy is imposed.

## Recovery

The receipt includes `upload_id`, `workspace`, `session_id`, `sha256`, `bytes`, original conversation/turn references, `state`, and `next_action`. `ready` includes `url`; `pending` requires recovery of the original upload. No storage keys or diagnostic response bodies are projected.

After an uncertain response, use `getArtifact(originalUploadId, originalTarget)`. If ready, use that receipt without reading or re-uploading the local file. If pending or `artifact_not_found`, retry the same upload with the original metadata and bytes. Preserve the ID across process restarts. A changed artifact or destination must not reuse the original ID. The server may repeat a PUT of identical bytes to the same object key after a storage/DB acknowledgement gap; it does not create a second logical image reference.

Stable errors include `artifact_unsupported`, `artifact_upload_disabled`, `artifact_storage_unavailable`, `artifact_upload_pending`, `artifact_conflict`, `artifact_storage_changed`, `artifact_content_mismatch`, `artifact_too_large`, and `artifact_type_not_allowed`. HTTP 404 from an older Core is unsupported, while a supported Core's missing receipt remains `artifact_not_found`. Transport timeouts and connection failures preserve the uncertain disposition and are not automatically retried.

Uploading is separate from applying a business change. For a gallery, wait until every required image is ready before submitting the final list; retain images the user did not ask to remove. An uncertain product update must resume the original business invocation, not create another one.

Hosts with multi-authorization conversations must validate the entire original selected scope before uploading or recovering. Selecting several systems does not grant permission to send files to all of them. Only the explicit selected target receives file bytes.

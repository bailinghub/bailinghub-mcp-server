import { createHash } from 'node:crypto';
import { BailingHubClientError } from './client.js';
import type { AgentClientTransport } from './agent-client.js';

export const ARTIFACT_SCHEMA = 'bailing.agent-artifact.v1';
export const ARTIFACT_ERROR_CODES = ['artifact_invalid_request', 'artifact_content_mismatch', 'artifact_type_not_allowed', 'artifact_too_large',
  'artifact_run_mismatch', 'artifact_conflict', 'artifact_storage_changed', 'artifact_upload_disabled', 'artifact_storage_unavailable',
  'artifact_upload_pending', 'artifact_unsupported', 'artifact_not_found'];
export type AgentArtifactInput = { uploadId: string; body: Uint8Array; name: string; mime: string; clientConversationId: string; clientTurnId: string; runId?: string; sha256?: string };
export type AgentArtifactReceipt = { schema_version: typeof ARTIFACT_SCHEMA; upload_id: string; workspace: string; session_id: string;
  state: 'ready' | 'pending'; name: string; mime: string; bytes: number; sha256: string; client_conversation_id: string; client_turn_id: string;
  run_id?: string; visibility: 'public'; url?: string; next_action: 'use_url' | 'retry_same_upload' };
const hash = (body: Buffer) => createHash('sha256').update(body).digest('hex');
function text(v: unknown, n: number): v is string { return typeof v === 'string' && v.length > 0 && v.length <= n && !/[\u0000-\u001f\u007f]/.test(v); }
function validId(value: unknown): asserts value is string { if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new TypeError('A stable 64-character uploadId is required.'); }
function normalize(value: unknown, expected: { uploadId: string; workspace: string; sessionId: string }): AgentArtifactReceipt {
  const v = value as AgentArtifactReceipt;
  if (!v || v.schema_version !== ARTIFACT_SCHEMA || v.upload_id !== expected.uploadId || v.workspace !== expected.workspace || v.session_id !== expected.sessionId ||
    !['ready', 'pending'].includes(v.state) || !text(v.name, 128) || !['image/png', 'image/jpeg', 'image/webp'].includes(v.mime) || !Number.isInteger(v.bytes) || v.bytes < 1 || v.bytes > 6291456 ||
    !/^[a-f0-9]{64}$/.test(v.sha256) || !text(v.client_conversation_id, 128) || !text(v.client_turn_id, 128) || v.visibility !== 'public' || (v.run_id !== undefined && (typeof v.run_id !== 'string' || !/^[a-f0-9-]{36}$/.test(v.run_id))) ||
    v.next_action !== (v.state === 'ready' ? 'use_url' : 'retry_same_upload')) throw new BailingHubClientError('Invalid artifact receipt.', undefined, false, 'artifact_invalid_receipt');
  if (v.state === 'ready') {
    let url: URL;
    try { url = new URL(v.url!); } catch { throw new BailingHubClientError('Invalid artifact URL.', undefined, false, 'artifact_invalid_receipt'); }
    if (!text(v.url, 2048) || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new BailingHubClientError('Invalid artifact URL.', undefined, false, 'artifact_invalid_receipt');
  }
  // Project only declared fields; storage credentials and backend diagnostics never pass through.
  return { schema_version: ARTIFACT_SCHEMA, upload_id: v.upload_id, workspace: v.workspace, session_id: v.session_id, state: v.state,
    name: v.name, mime: v.mime, bytes: v.bytes, sha256: v.sha256, client_conversation_id: v.client_conversation_id, client_turn_id: v.client_turn_id,
    ...(v.run_id ? { run_id: v.run_id } : {}), visibility: 'public', ...(v.state === 'ready' ? { url: v.url! } : {}), next_action: v.next_action };
}
function unsupported(error: unknown): never {
  if (error instanceof BailingHubClientError && ((error.statusCode === 404 && error.publicCode !== 'artifact_not_found') || error.statusCode === 501)) {
    throw new BailingHubClientError('This Core does not support generated artifact delivery.', error.statusCode, false, 'artifact_unsupported');
  }
  throw error;
}
export async function uploadArtifact(transport: AgentClientTransport, binding: { workspace: string; sessionId: string }, input: AgentArtifactInput): Promise<AgentArtifactReceipt> {
  validId(input.uploadId);
  if (!(input.body instanceof Uint8Array) || !input.body.length || input.body.length > 6291456 || !text(input.name, 128) || /[\\/]/.test(input.name) ||
    !['image/png', 'image/jpeg', 'image/webp'].includes(input.mime) || !text(input.clientConversationId, 128) || !text(input.clientTurnId, 128) ||
    (input.runId !== undefined && !/^[a-f0-9-]{36}$/.test(input.runId))) throw new TypeError('Invalid image artifact metadata or bytes.');
  const body = Buffer.from(input.body); // freeze bytes before authorization and network awaits
  const sha256 = hash(body);
  if (input.sha256 !== undefined && input.sha256 !== sha256) throw new TypeError('Artifact bytes changed; restore the original generated file.');
  const metadata = { name: input.name, mime: input.mime, bytes: body.length, sha256, client_conversation_id: input.clientConversationId,
    client_turn_id: input.clientTurnId, ...(input.runId ? { run_id: input.runId } : {}) };
  const expected = { ...binding, uploadId: input.uploadId };
  try {
    const response = await transport.request('POST', `/agent-api/v1/workspaces/${binding.workspace}/artifacts/${input.uploadId}`, undefined, {
      publicErrorCodes: ARTIFACT_ERROR_CODES, acceptedUnknownOnFailure: true,
      binary: { body, contentType: input.mime, metadata: Buffer.from(JSON.stringify(metadata)).toString('base64url') },
    });
    const value = normalize(response.body, expected);
    if (value.sha256 !== sha256 || value.bytes !== body.length || value.client_conversation_id !== metadata.client_conversation_id || value.client_turn_id !== metadata.client_turn_id || value.mime !== metadata.mime || value.name !== metadata.name || value.run_id !== metadata.run_id) throw new BailingHubClientError('Artifact receipt does not match the upload.', undefined, false, 'artifact_invalid_receipt');
    return value;
  } catch (error) { return unsupported(error); }
}
export async function getArtifact(transport: AgentClientTransport, binding: { workspace: string; sessionId: string }, uploadId: string): Promise<AgentArtifactReceipt> {
  validId(uploadId);
  try { const response = await transport.request('GET', `/agent-api/v1/workspaces/${binding.workspace}/artifacts/${uploadId}`, undefined, { publicErrorCodes: ARTIFACT_ERROR_CODES });
    return normalize(response.body, { ...binding, uploadId });
  } catch (error) { return unsupported(error); }
}

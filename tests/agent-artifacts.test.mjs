import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { BailingHubAgentClient } from '../dist/agent-client.js';
import { createAgentClientTransport } from '../dist/sdk.js';
const bytes = Buffer.from('89504e470d0a1a0a00000000', 'hex');
const sha = createHash('sha256').update(bytes).digest('hex');
const sessionId = '123e4567-e89b-42d3-a456-426614174000';
const input = () => ({ uploadId: 'a'.repeat(64), body: Buffer.from(bytes), name: 'product.png', mime: 'image/png', clientConversationId: 'conversation', clientTurnId: 'turn' });
const receipt = () => ({ schema_version: 'bailing.agent-artifact.v1', upload_id: 'a'.repeat(64), workspace: 'shop', session_id: sessionId,
  state: 'ready', name: 'product.png', mime: 'image/png', bytes: bytes.length, sha256: sha, client_conversation_id: 'conversation', client_turn_id: 'turn',
  visibility: 'public', url: 'https://cdn.example.com/product.png', next_action: 'use_url' });
const client = (fetchImpl, token = { getAccessToken: async () => 'test-token' }) => new BailingHubAgentClient({ baseUrl: 'https://hub.example.com', clientAppId: 'shop-client', workspace: 'shop', sessionId, accessTokenProvider: token }, { fetchImpl });
test('uploads raw immutable bytes, binds metadata, strips undeclared receipt fields', async () => {
  let release; const waiting = new Promise(r => { release = r });
  const value = input();
  const c = client(async (url, init) => {
    assert.match(url, /\/workspaces\/shop\/artifacts\/a{64}$/);
    assert.deepEqual(Buffer.from(init.body), bytes);
    const metadata = JSON.parse(Buffer.from(init.headers['x-bailing-artifact'], 'base64url').toString());
    assert.equal(metadata.sha256, sha); assert.equal(metadata.bytes, bytes.length); assert.equal('body' in metadata, false);
    return Response.json({ ...receipt(), access_token: 'should-never-escape' });
  }, { getAccessToken: async () => { await waiting; return 'test-token' } });
  const pending = c.uploadArtifact(value); value.body.fill(0); release();
  const result = await pending;
  assert.equal(result.url, receipt().url); assert.equal('access_token' in result, false);
});
test('wrong target receipt and changed digest are rejected', async () => {
  const c = client(async () => Response.json({ ...receipt(), session_id: 'wrong' }));
  await assert.rejects(c.uploadArtifact(input()), { publicCode: 'artifact_invalid_receipt' });
  await assert.rejects(c.uploadArtifact({ ...input(), sha256: 'b'.repeat(64) }), /bytes changed/);
});
test('old Core is unsupported; missing current-Core receipt stays not_found', async () => {
  await assert.rejects(client(async () => Response.json({ error: 'not_found' }, { status: 404 })).getArtifact('a'.repeat(64)), { publicCode: 'artifact_unsupported' });
  await assert.rejects(client(async () => Response.json({ error: 'artifact_not_found' }, { status: 404 })).getArtifact('a'.repeat(64)), { publicCode: 'artifact_not_found' });
});
test('lost upload response is uncertain and never automatically resends', async () => {
  let calls = 0;
  await assert.rejects(client(async () => { calls++; throw new TypeError('offline'); }).uploadArtifact(input()), { publicCode: 'agent_transport_unavailable', disposition: 'accepted_unknown' });
  assert.equal(calls, 1);
});
test('dedicated turn mismatch remains distinct from identity mismatch without retry', async () => {
  for (const code of ['artifact_run_turn_mismatch', 'artifact_run_mismatch']) {
    let calls = 0;
    await assert.rejects(client(async () => { calls++; return Response.json({ error: code }, { status: 403 }); }).uploadArtifact(input()), { publicCode: code, statusCode: 403 });
    assert.equal(calls, 1);
  }
});
test('host uploader refuses default authorization and paths without reading credentials', async () => {
  const transport = createAgentClientTransport({ hubUrl: 'https://hub.example.com', clientAppId: 'shop-client', workspace: 'shop' });
  await assert.rejects(transport.uploadArtifact(input(), {}), /explicit original connection/);
  await assert.rejects(transport.getArtifact('a'.repeat(64), {}), /explicit original connection/);
});

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AgentConnectionRegistry, AgentConnectionStore, BailingHubAgentClient, createAgentClientTransport } from '../dist/sdk.js';

const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333'];
const conversation = '44444444-4444-4444-8444-444444444444';
const archive = '55555555-5555-4555-8555-555555555555';
const run = '66666666-6666-4666-8666-666666666666';
const json = (value, status = 200) => new Response(JSON.stringify(value), { status });
const events = () => [
  { event_id: 'start', sequence: 1, client_turn_id: 'turn.1', kind: 'turn_start' },
  { event_id: 'user.1', sequence: 2, client_turn_id: 'turn.1', kind: 'user_message', content: 'Compare A and B.' },
  { event_id: 'link.a', sequence: 3, client_turn_id: 'turn.1', kind: 'run_link', run_id: run, member_session_id: ids[0] },
  { event_id: 'reply', sequence: 4, client_turn_id: 'turn.1', kind: 'assistant_message', content: 'Combined visible reply.', hidden_reasoning: 'never export' },
  { event_id: 'end', sequence: 5, client_turn_id: 'turn.1', kind: 'turn_end', status: 'completed' },
];

async function setup(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'bailinghub-conversation-sdk-'));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const store = new AgentConnectionStore({
    registry: new AgentConnectionRegistry(join(directory, 'registry.json')), platform: 'linux',
    environment: { BAILINGHUB_ALLOW_FILE_CREDENTIAL_STORE: 'true', BAILINGHUB_CREDENTIAL_FILE: join(directory, 'legacy.json') },
    credentialPathFor: (key) => join(directory, `${key}.json`),
  });
  const members = [];
  for (const [index, id] of ids.entries()) {
    const descriptor = { baseUrl: index === 1 && options.otherHub ? 'https://other.example.com' : 'https://hub.example.com',
      clientAppId: 'example-agent', workspace: 'orders', allowInsecureHttp: false };
    const profile = await store.registerInstance(descriptor, { alias: `store-${index}`, makeCurrent: true });
    await store.credentialStore(profile.connectionKey).save({
      schema_version: 1, base_url: descriptor.baseUrl, client_app_id: descriptor.clientAppId, route: 'orders',
      session_id: id, access_token: `access-test-${index}`, refresh_token: `refresh-test-${index}`,
      access_expires_at: '2099-01-01T00:00:00.000Z', refresh_expires_at: '2099-02-01T00:00:00.000Z',
    });
    members.push({ connectionKey: profile.connectionKey, workspace: 'orders', expectedSessionId: id, label: `Store ${index}` });
  }
  const calls = [];
  let confirmed = 1;
  let last = 0;
  const transport = createAgentClientTransport({ hubUrl: 'https://hub.example.com', clientAppId: 'example-agent', workspace: 'orders' }, {
    connectionStore: store,
    fetchImpl: async (url, init) => {
      const call = { path: new URL(url).pathname, auth: new Headers(init.headers).get('authorization'), body: JSON.parse(init.body) };
      calls.push(call);
      const override = await options.intercept?.(call, { store, members });
      if (override) return override;
      if (call.path.endsWith('/confirm')) confirmed = 2;
      if (call.path.endsWith('/events')) {
        last = Math.max(last, call.body.events.at(-1).sequence);
        return json({ schema: 'bailing.agent-conversation-audit-ack.v1', conversation_id: conversation, last_sequence: last });
      }
      return json({ schema: 'bailing.agent-conversation-audit.v1', conversation_id: conversation,
        state: confirmed === 2 ? 'ready' : 'enrolling', member_count: 2, confirmed_count: confirmed, last_sequence: last });
    },
  });
  return { transport, store, calls, members: members.slice(0, 2),
    envelope: { clientArchiveId: archive, clientConversationId: 'host.conversation', events: events() } };
}

test('host archive confirms each frozen authorization, uploads visible text once and never uses default C', async (t) => {
  const f = await setup(t);
  const result = await f.transport.syncConversationArchive(f.envelope, { members: f.members });
  assert.equal(result.last_sequence, 5);
  assert.deepEqual(f.calls.map((call) => call.auth), ['Bearer access-test-0', 'Bearer access-test-1', 'Bearer access-test-0']);
  assert.deepEqual(f.calls[0].body.member_session_ids, ids.slice(0, 2));
  assert.equal(f.calls[0].body.client_archive_id, archive);
  assert.equal(f.calls[0].body.route, 'orders');
  assert.deepEqual(f.calls[1].body, {});
  assert.equal(f.calls[2].body.events[3].content, 'Combined visible reply.');
  assert.ok(!JSON.stringify(f.calls.map((call) => call.body)).includes('never export'));
  assert.ok(!JSON.stringify(f.calls.map((call) => call.body)).includes('access-test'));
  assert.ok(f.calls.every((call) => call.path.includes('/conversation-audits')));
});

test('invalid, substituted, duplicate and cross-Hub members fail before any HTTP', async (t) => {
  for (const type of ['empty', 'substitute', 'duplicate', 'cross-hub', 'foreign-link']) {
    const f = await setup(t, { otherHub: type === 'cross-hub' });
    let members = f.members;
    if (type === 'empty') members = [];
    if (type === 'substitute') members[1].expectedSessionId = ids[2];
    if (type === 'duplicate') members = [members[0], members[0]];
    if (type === 'foreign-link') f.envelope.events[2].member_session_id = ids[2];
    await assert.rejects(f.transport.syncConversationArchive(f.envelope, { members }));
    assert.equal(f.calls.length, 0, type);
  }
});

test('membership rejection never sends combined text and original identity can retry', async (t) => {
  let denied = true;
  const f = await setup(t, { intercept: (call) => call.path.endsWith('/confirm') && denied ? json({ error: 'conversation_audit_forbidden' }, 403) : undefined });
  await assert.rejects(f.transport.syncConversationArchive(f.envelope, { members: f.members }), { statusCode: 403 });
  assert.ok(!f.calls.some((call) => call.path.endsWith('/events')));
  denied = false;
  await f.transport.syncConversationArchive(f.envelope, { members: f.members });
  assert.equal(f.calls.filter((call) => call.path.endsWith('/events')).length, 1);
  assert.equal(f.calls[0].body.client_archive_id, f.calls[2].body.client_archive_id);
});

test('member replacement after confirmation blocks the combined text even when writer remains valid', async (t) => {
  const f = await setup(t, { intercept: async (call, { store, members }) => {
    if (call.path.endsWith('/confirm')) {
      const credentials = store.credentialStore(members[1].connectionKey);
      await credentials.save({ ...await credentials.load(), session_id: ids[2] });
    }
  } });
  await assert.rejects(f.transport.syncConversationArchive(f.envelope, { members: f.members }), /original conversation authorization/);
  assert.ok(!f.calls.some((call) => call.path.endsWith('/events')));
});

test('archive batches respect byte/count limits and preserve all text and sequences', async (t) => {
  const f = await setup(t);
  f.envelope.events = Array.from({ length: 60 }, (_, i) => ({ event_id: `message.${i}`, sequence: i + 1,
    client_turn_id: 'turn.1', kind: 'assistant_message', content: '文'.repeat(30_000) }));
  await f.transport.syncConversationArchive(f.envelope, { members: f.members });
  const uploads = f.calls.filter((call) => call.path.endsWith('/events'));
  assert.ok(uploads.length > 2);
  assert.ok(uploads.every((call) => Buffer.byteLength(JSON.stringify(call.body)) <= 192 * 1024));
  assert.deepEqual(uploads.flatMap((call) => call.body.events), f.envelope.events);
});

test('gap, oversized content and hidden event kinds are rejected before enrollment', async (t) => {
  const f = await setup(t);
  for (const event of [
    { ...events()[0], sequence: 0 }, { ...events()[1], content: 'a'.repeat(64_001) },
    { ...events()[0], kind: 'assistant_chunk' },
  ]) await assert.rejects(f.transport.syncConversationArchive({ ...f.envelope, events: [event] }, { members: f.members }));
  await assert.rejects(f.transport.syncConversationArchive({ ...f.envelope, events: [events()[0], events()[3]] }, { members: f.members }));
  assert.equal(f.calls.length, 0);
});

test('old Core and conflicting event responses are explicit and never fall back to run completion', async (t) => {
  for (const status of [404, 409]) {
    const f = await setup(t, { intercept: (call) => status === 404 || call.path.endsWith('/events') ? json({ error: 'conversation_audit_event_conflict' }, status) : undefined });
    await assert.rejects(f.transport.syncConversationArchive(f.envelope, { members: f.members }), { statusCode: status });
    assert.ok(f.calls.every((call) => call.path.includes('/conversation-audits')));
  }
});

test('low-level client rejects a receipt for a different conversation', async () => {
  const client = new BailingHubAgentClient({ baseUrl: 'https://hub.example.com', clientAppId: 'example-agent', workspace: 'orders',
    sessionId: ids[0], accessTokenProvider: { getAccessToken: async () => 'test' } }, {
    fetchImpl: async () => json({ schema: 'bailing.agent-conversation-audit-ack.v1', conversation_id: archive, last_sequence: 5 }),
  });
  await assert.rejects(client.appendConversationAuditEvents(conversation, events()), /invalid conversation audit acknowledgement/);
});

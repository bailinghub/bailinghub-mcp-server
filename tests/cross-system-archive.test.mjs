import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AgentConnectionRegistry, AgentConnectionStore, BailingHubAgentClient, createAgentClientTransport } from '../dist/sdk.js';

const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333'];
const archiveId = '44444444-4444-4444-8444-444444444444';
const conversationId = '55555555-5555-4555-8555-555555555555';
const runIds = ['66666666-6666-4666-8666-666666666666', '77777777-7777-4777-8777-777777777777'];
const capabilities = { schema: 'bailing.agent-conversation-audit-capabilities.v1', cross_binding_members: true, member_bindings: 'session-client-route.v1' };
const events = () => [
  { event_id: 'start', sequence: 1, client_turn_id: 'turn.1', kind: 'turn_start' },
  { event_id: 'user', sequence: 2, client_turn_id: 'turn.1', kind: 'user_message', content: 'Prepare a shop campaign and a CRM follow-up.' },
  ...runIds.map((id, index) => ({ event_id: `link.${index}`, sequence: index + 3, client_turn_id: 'turn.1',
    kind: 'run_link', run_id: id, member_session_id: ids[index] })),
  { event_id: 'reply', sequence: 5, client_turn_id: 'turn.1', kind: 'assistant_message', content: 'Shop and CRM results.', hidden_reasoning: 'excluded' },
  { event_id: 'end', sequence: 6, client_turn_id: 'turn.1', kind: 'turn_end', status: 'completed' },
];

async function setup(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'bailinghub-cross-archive-'));
  const calls = [], saved = new Map(), confirmed = new Set(), rejected = [];
  const descriptors = [{ clientAppId: 'shop-agent', workspace: 'shop' },
    { clientAppId: options.sameApp ? 'shop-agent' : 'crm-agent', workspace: options.sameRoute ? 'shop' : 'crm' },
    { clientAppId: 'unselected-agent', workspace: 'erp' }];
  let registrationBody, lostAck = false;
  const respond = (res, value, status = 200) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(value));
  };
  const server = createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const content = Buffer.concat(chunks).toString();
      const call = { path: req.url, method: req.method, auth: req.headers.authorization, body: content ? JSON.parse(content) : undefined };
      calls.push(call);
      const tokenIndex = ['Bearer fixture-0', 'Bearer fixture-1', 'Bearer fixture-2'].indexOf(call.auth);
      if (tokenIndex < 0 || options.revoked?.has(tokenIndex)) return respond(res, { error: 'conversation_audit_authorization_invalid' }, 403);
      const override = await options.intercept?.(call, { store, members });
      if (override) return respond(res, override.body, override.status);
      if (call.path === '/agent-api/v1/conversation-audits/capabilities') {
        assert.equal(call.method, 'GET');
        assert.equal(call.body, undefined);
        return respond(res, capabilities);
      }
      if (call.path === '/agent-api/v1/conversation-audits') {
        assert.equal(tokenIndex, 0);
        assert.equal(call.method, 'POST');
        const bindings = call.body.members ?? call.body.member_session_ids.map((session_id) => ({ session_id,
          client_app_id: descriptors[0].clientAppId, route: call.body.route }));
        for (const [index, binding] of bindings.entries()) {
          assert.equal(binding.session_id, ids[index]);
          assert.equal(binding.client_app_id, descriptors[index].clientAppId);
          assert.equal(binding.route, descriptors[index].workspace);
        }
        if (registrationBody) assert.deepEqual(call.body, registrationBody);
        registrationBody = call.body;
        confirmed.add(0);
      } else if (call.path === `/agent-api/v1/conversation-audits/${conversationId}/confirm`) {
        assert.equal(tokenIndex, 1);
        assert.deepEqual(call.body, {});
        confirmed.add(tokenIndex);
      } else if (call.path === `/agent-api/v1/conversation-audits/${conversationId}/events`) {
        assert.equal(tokenIndex, 0);
        assert.equal(confirmed.size, 2);
        for (const event of call.body.events) {
          if (event.kind === 'run_link') assert.equal(runIds[ids.indexOf(event.member_session_id)], event.run_id);
          if (saved.has(event.sequence)) assert.deepEqual(saved.get(event.sequence), event);
          saved.set(event.sequence, event);
        }
        if (options.loseAck && !lostAck) { lostAck = true; res.destroy(); return; }
        return respond(res, { schema: 'bailing.agent-conversation-audit-ack.v1', conversation_id: conversationId, last_sequence: saved.size });
      } else throw new Error('Unexpected endpoint');
      return respond(res, { schema: 'bailing.agent-conversation-audit.v1', conversation_id: conversationId,
        state: confirmed.size === 2 ? 'ready' : 'enrolling', member_count: 2, confirmed_count: confirmed.size, last_sequence: saved.size });
    } catch (error) { rejected.push(error); respond(res, { error: 'invalid_request' }, 400); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  const hubUrl = `http://127.0.0.1:${server.address().port}`;
  const store = new AgentConnectionStore({ registry: new AgentConnectionRegistry(join(directory, 'registry.json')), platform: 'linux',
    environment: { BAILINGHUB_ALLOW_FILE_CREDENTIAL_STORE: 'true', BAILINGHUB_CREDENTIAL_FILE: join(directory, 'legacy.json') },
    credentialPathFor: (key) => join(directory, `${key}.json`) });
  const members = [];
  for (const [index, descriptor] of descriptors.entries()) {
    const profile = await store.registerInstance({ ...descriptor, baseUrl: hubUrl, allowInsecureHttp: false }, { alias: `target-${index}`, makeCurrent: true });
    await store.credentialStore(profile.connectionKey).save({ schema_version: 1, base_url: hubUrl,
      client_app_id: descriptor.clientAppId, route: descriptor.workspace, session_id: ids[index],
      access_token: `fixture-${index}`, refresh_token: `fixture-refresh-${index}`,
      access_expires_at: '2099-01-01T00:00:00.000Z', refresh_expires_at: '2099-02-01T00:00:00.000Z' });
    members.push({ connectionKey: profile.connectionKey, hubUrl, ...descriptor, expectedSessionId: ids[index], label: `Target ${index}` });
  }
  const makeTransport = () => createAgentClientTransport({ hubUrl, ...descriptors[2] }, { connectionStore: store });
  return { transport: makeTransport(), makeTransport, store, calls, saved, rejected, members: members.slice(0, 2),
    envelope: { clientArchiveId: archiveId, clientConversationId: 'conversation.original', events: events() } };
}

test('cross-app/route archives negotiate and independently confirm original targets over real HTTP', async (t) => {
  for (const options of [{}, { sameApp: true }, { sameRoute: true }]) {
    const f = await setup(t, options);
    assert.deepEqual(await f.transport.getConversationArchiveCapabilities({ members: f.members }), capabilities);
    const result = await f.transport.syncConversationArchive(f.envelope, { members: f.members });
    assert.equal(result.last_sequence, 6);
    assert.deepEqual(f.calls.map((call) => call.method), ['GET', 'GET', 'POST', 'POST', 'POST']);
    assert.deepEqual(f.calls.map((call) => call.auth), ['Bearer fixture-0', 'Bearer fixture-0', 'Bearer fixture-0', 'Bearer fixture-1', 'Bearer fixture-0']);
    const body = f.calls[2].body;
    assert.equal(body.schema, 'bailing.agent-conversation-audit-create.v2');
    assert.equal(body.client_archive_id, archiveId);
    assert.deepEqual(body.members, f.members.map((member) => ({ session_id: member.expectedSessionId,
      client_app_id: member.clientAppId, route: member.workspace, label: member.label })));
    const wire = JSON.stringify(f.calls.map((call) => call.body));
    assert.ok(!wire.includes('connectionKey') && !wire.includes('hubUrl') && !wire.includes('excluded'));
    assert.deepEqual(f.rejected, []);
  }
});

test('missing frozen metadata and substituted Hub/app/workspace/session reject before any HTTP', async (t) => {
  for (const mutation of [
    (members) => { delete members[1].hubUrl; delete members[1].clientAppId; },
    (members) => { members[1].hubUrl = 'https://other.example.com'; },
    (members) => { members[1].clientAppId = 'other-agent'; },
    (members) => { members[1].workspace = 'other-route'; },
    (members) => { members[1].expectedSessionId = ids[2]; },
    (members) => { members[1].expectedSessionId = ids[0]; },
  ]) {
    const f = await setup(t);
    mutation(f.members);
    await assert.rejects(f.transport.syncConversationArchive(f.envelope, { members: f.members }));
    await assert.rejects(f.transport.getConversationArchiveCapabilities({ members: f.members }));
    assert.equal(f.calls.length, 0);
  }
});

test('old Core, disabled capability, malformed capability and unavailable storage never receive a v2 POST', async (t) => {
  for (const response of [
    { status: 404, body: {} }, { status: 200, body: { ...capabilities, cross_binding_members: false } },
    { status: 200, body: { ...capabilities, member_bindings: 'unknown' } },
    { status: 503, body: { error: 'conversation_audit_cross_binding_unavailable' } },
  ]) {
    const f = await setup(t, { intercept: () => response });
    await assert.rejects(f.transport.syncConversationArchive(f.envelope, { members: f.members }),
      { publicCode: 'conversation_audit_cross_binding_unavailable' });
    assert.deepEqual(f.calls.map((call) => call.method), ['GET']);
    assert.equal(f.saved.size, 0);
  }
});

test('legacy same-binding registration remains v1 and does not require the new capabilities endpoint', async (t) => {
  const f = await setup(t, { sameApp: true, sameRoute: true });
  f.members.forEach((member) => { delete member.hubUrl; delete member.clientAppId; });
  await f.transport.syncConversationArchive(f.envelope, { members: f.members });
  assert.deepEqual(f.calls.map((call) => call.method), ['POST', 'POST', 'POST']);
  assert.equal(f.calls[0].body.schema, undefined);
  assert.deepEqual(f.calls[0].body.member_session_ids, ids.slice(0, 2));
});

test('member replacement during capability negotiation blocks create and capability success', async (t) => {
  for (const action of ['sync', 'probe']) {
    const f = await setup(t, { intercept: async (call, { store, members }) => {
      if (call.path.endsWith('/capabilities')) {
        const credentials = store.credentialStore(members[1].connectionKey);
        await credentials.save({ ...await credentials.load(), session_id: ids[2] });
      }
    } });
    await assert.rejects(action === 'sync' ? f.transport.syncConversationArchive(f.envelope, { members: f.members })
      : f.transport.getConversationArchiveCapabilities({ members: f.members }), { publicCode: 'agent_binding_changed' });
    assert.deepEqual(f.calls.map((call) => call.method), ['GET']);
  }
});

test('host mutation while HTTP is pending cannot change captured members or visible events', async (t) => {
  let f;
  f = await setup(t, { intercept: (call) => {
    if (call.path.endsWith('/capabilities')) {
      f.members[1].clientAppId = 'injected-app';
      f.members[1].expectedSessionId = ids[2];
      f.envelope.events[1].content = 'injected text';
    }
  } });
  const expected = events().map(({ hidden_reasoning, ...event }) => event);
  await f.transport.syncConversationArchive(f.envelope, { members: f.members });
  assert.equal(f.calls[1].body.members[1].client_app_id, 'crm-agent');
  assert.deepEqual([...f.saved.values()], expected);
});

test('lost ACK retries after a new SDK transport retain archive/events and never repeat business calls', async (t) => {
  const f = await setup(t, { loseAck: true });
  await assert.rejects(f.transport.syncConversationArchive(f.envelope, { members: f.members }), { disposition: 'accepted_unknown' });
  assert.equal(f.saved.size, 6);
  const retry = f.makeTransport();
  assert.equal((await retry.syncConversationArchive(f.envelope, { members: f.members })).last_sequence, 6);
  assert.equal(f.saved.size, 6);
  assert.deepEqual(f.calls.filter((call) => call.path.endsWith('/events')).map((call) => call.body),
    [f.calls.find((call) => call.path.endsWith('/events')).body, f.calls.find((call) => call.path.endsWith('/events')).body]);
  assert.ok(f.calls.every((call) => call.path.startsWith('/agent-api/v1/conversation-audits')));
  assert.deepEqual(f.rejected, []);
});

test('a revoked member prevents text upload and retains the original group for a valid retry', async (t) => {
  const revoked = new Set([1]);
  const f = await setup(t, { revoked });
  await assert.rejects(f.transport.syncConversationArchive(f.envelope, { members: f.members }), { statusCode: 403 });
  assert.ok(!f.calls.some((call) => call.path.endsWith('/events')));
  revoked.clear();
  await f.transport.syncConversationArchive(f.envelope, { members: f.members });
  assert.equal(f.saved.size, 6);
  assert.deepEqual(f.rejected, []);
});

test('low-level v2 create rejects a substituted writer before probing or sending HTTP', async () => {
  let calls = 0;
  const client = new BailingHubAgentClient({ baseUrl: 'https://hub.example.com', clientAppId: 'shop-agent', workspace: 'shop',
    sessionId: ids[0], accessTokenProvider: { getAccessToken: async () => 'fixture' } }, { fetchImpl: async () => { calls++; throw new Error(); } });
  await assert.rejects(client.createConversationAudit({ clientArchiveId: archiveId, clientConversationId: 'original',
    members: [{ sessionId: ids[1], clientAppId: 'crm-agent', workspace: 'crm' }] }), /writer/);
  assert.equal(calls, 0);
});

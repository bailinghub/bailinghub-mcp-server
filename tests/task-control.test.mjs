import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { BailingHubAgentClient, AGENT_CLIENT_V1_PATHS } from '../dist/agent-client.js';
import { AgentConnectionRegistry, AgentConnectionStore, createAgentClientTransport } from '../dist/sdk.js';

const HUB = 'https://hub.example.com';
const SESSION = '11111111-1111-4111-8111-111111111111';
const OTHER_SESSION = '22222222-2222-4222-8222-222222222222';
const RUN = '33333333-3333-4333-8333-333333333333';
const TASK = '44444444-4444-4444-8444-444444444444';
const REV = 'a'.repeat(64);
const ID = 'b'.repeat(64);
const CONVERSATION = 'synthetic-conversation';
const CAPS = '/agent-api/v1/task-control/capabilities';
const RECEIPT_CAPS = '/agent-api/v1/tool-invocations/inspection-capabilities';
const TASK_PATH = `/agent-api/v1/tasks/${TASK}`;
const TURNS = '/agent-api/v1/workspaces/inventory/turns';
const json = (value, status = 200) => new Response(JSON.stringify(value), { status });
const binding = () => ({ schema_version: 'bailing.agent-task-binding.v1', task_id: TASK, scope_hash: REV });
const capabilities = () => ({ schema_version: 'bailing.agent-task-control-capabilities.v1', supported: true,
  mode: 'optional', task_schema: 'bailing.agent-task.v1', metering: 'write_invocation', same_hub_only: true,
  controls: ['pause', 'resume', 'cancel'], inspect_invocation: true });
const inspectionCapabilities = () => ({ schema_version: 'bailing.agent-invocation-inspection-capabilities.v1',
  receipt_schema: 'bailing.agent-invocation-receipt.v1', read_only: true });
const snapshot = () => ({ schema_version: 'bailing.agent-task.v1', task_id: TASK, state: 'active', revision: 2,
  ledger_sequence: 4, scope_hash: REV, member_count: 2,
  member: { session_id: SESSION, client_app_id: 'commerce-agent', workspace: 'inventory',
    client_conversation_id: CONVERSATION, allowed_tools: ['goods_read', 'goods_update'] },
  policy: { max_write_calls: 3, max_concurrent: 1, expires_at: '2099-01-01T00:00:00.000Z' },
  counters: { write_reserved: 1, write_consumed: 1, active_permits: 1 },
  metering: 'write_invocation', snapshot_is_dispatch_permission: false });
const turnInput = () => ({ clientConversationId: CONVERSATION, clientTurnId: 'synthetic-turn',
  userMessageId: 'synthetic-message', userInput: 'Inspect the synthetic inventory.' });
const turn = (managed = true) => ({ schema_version: 'bailing.agent-turn-context.v1', run_id: RUN,
  profile_revision: REV, capability_revision: REV, context: { instructions: '', page_context: {}, renderers: [],
    memory: null, memory_refs: [], knowledge: [], knowledge_refs: [], governance: {} }, active_tools: [],
  ...(managed ? { task_binding: binding() } : {}) });
function client(handler) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const parsed = new URL(String(url));
    const call = { path: parsed.pathname, query: parsed.searchParams, method: init.method,
      body: init.body ? JSON.parse(init.body) : undefined, authorization: new Headers(init.headers).get('authorization') };
    calls.push(call);
    const override = await handler?.(call);
    if (override) return override;
    if (call.path === CAPS) return json(capabilities());
    if (call.path === RECEIPT_CAPS) return json(inspectionCapabilities());
    if (call.path === TASK_PATH) return json(snapshot());
    if (call.path === TURNS) return json(turn(Boolean(call.body.task_binding)));
    assert.fail(`Unexpected request ${call.method} ${call.path}`);
  };
  const api = new BailingHubAgentClient({ baseUrl: HUB, clientAppId: 'commerce-agent', workspace: 'inventory',
    sessionId: SESSION, accessTokenProvider: { getAccessToken: async () => 'synthetic-access' } }, { fetchImpl });
  return { api, calls, fetchImpl };
}
function code(expected, category) {
  return (error) => {
    assert.equal(error.publicCode, expected);
    if (category) assert.equal(error.feedback.category, category);
    return true;
  };
}

test('task snapshots are GET only, negotiate support and disclose only the original current member', async () => {
  const value = snapshot();
  value.members = [{ session_id: OTHER_SESSION, secret: 'not-forwarded' }];
  value.creator = 'not-forwarded'; value.member.identity_hash = 'not-forwarded';
  value.member.access_token = 'not-forwarded'; value.policy.secret = 'not-forwarded';
  const f = client(({ path }) => path === TASK_PATH ? json(value) : undefined);
  assert.deepEqual(await f.api.getTask(TASK, { clientConversationId: CONVERSATION }), snapshot());
  assert.deepEqual(f.calls.map(({ path }) => path), [CAPS, TASK_PATH]);
  assert.ok(f.calls.every(({ method, body, authorization }) => method === 'GET' && body === undefined && authorization === 'Bearer synthetic-access'));
  assert.deepEqual([...f.calls[1].query.entries()], [['workspace', 'inventory'], ['client_conversation_id', CONVERSATION]]);
  assert.equal(AGENT_CLIENT_V1_PATHS.task(TASK), TASK_PATH);
});

for (const status of [404, 405, 501]) test(`old Core ${status} is unsupported and never starts a managed turn`, async () => {
  const f = client(() => json({ error: 'not_found' }, status));
  await assert.rejects(f.api.startTurn(turnInput(), { taskBinding: binding() }), code('TASK_UNSUPPORTED', 'unsupported'));
  assert.deepEqual(f.calls.map(({ path }) => path), [CAPS]);
});

test('valid unsupported capabilities preserve required mode while managed requests remain blocked', async () => {
  const value = { ...capabilities(), supported: false, inspect_invocation: false, mode: 'required' };
  const f = client(() => json(value));
  assert.deepEqual(await f.api.getTaskControlCapabilities(), value);
  await assert.rejects(f.api.getTask(TASK, { clientConversationId: CONVERSATION }), code('TASK_UNSUPPORTED', 'unsupported'));
  assert.ok(f.calls.every(({ path }) => path === CAPS));
});

for (const unavailable of ['network', 'core']) test(`${unavailable} unavailability never masquerades as unsupported`, async () => {
  const f = client(() => { if (unavailable === 'network') throw new TypeError('synthetic secret not-forwarded');
    return json({ error: 'TASK_UNAVAILABLE', message: 'not-forwarded' }, 503); });
  await assert.rejects(f.api.getTaskControlCapabilities(), (error) => {
    assert.equal(error.feedback.category, 'transport_unavailable');
    assert.equal(error.publicCode, unavailable === 'core' ? 'TASK_UNAVAILABLE' : 'agent_transport_unavailable');
    assert.equal(error.feedback.next_action, 'restore_scope');
    assert.equal(JSON.stringify(error).includes('not-forwarded'), false); return true;
  });
});

for (const [field, value, error] of [
  ['schema_version', 'future', 'TASK_UNSUPPORTED'], ['task_schema', 'future', 'TASK_UNSUPPORTED'],
  ['supported', 'true', 'TASK_RECORD_INVALID'], ['mode', 'silent', 'TASK_RECORD_INVALID'],
  ['metering', 'objects', 'TASK_RECORD_INVALID'], ['same_hub_only', false, 'TASK_RECORD_INVALID'],
  ['controls', ['pause', 'pause', 'cancel'], 'TASK_RECORD_INVALID'], ['inspect_invocation', false, 'TASK_RECORD_INVALID'],
]) test(`capabilities strictly reject ${field}`, async () => {
  const f = client(() => json({ ...capabilities(), [field]: value }));
  await assert.rejects(f.api.getTaskControlCapabilities(), code(error));
});

for (const [label, mutate, error = 'TASK_RECORD_INVALID'] of [
  ['future schema', (s) => { s.schema_version = 'future'; }, 'TASK_UNSUPPORTED'],
  ['other task', (s) => { s.task_id = RUN; }, 'TASK_BINDING_CONFLICT'],
  ...['session_id', 'client_app_id', 'workspace', 'client_conversation_id'].map((field) => [
    `different ${field}`, (s) => { s.member[field] = field === 'session_id' ? OTHER_SESSION : 'other-member'; }, 'TASK_MEMBER_MISMATCH']),
  ['completed state', (s) => { s.state = 'completed'; }],
  ['numeric string revision', (s) => { s.revision = '2'; }],
  ['invalid ledger sequence', (s) => { s.ledger_sequence = 1; }],
  ['invalid scope digest', (s) => { s.scope_hash = 'redacted'; }],
  ['zero members', (s) => { s.member_count = 0; }],
  ['wildcard tools', (s) => { s.member.allowed_tools = ['*']; }],
  ['duplicate tools', (s) => { s.member.allowed_tools = ['goods_read', 'goods_read']; }],
  ['missing cap', (s) => { delete s.policy.max_write_calls; }],
  ['zero concurrency', (s) => { s.policy.max_concurrent = 0; }],
  ['invalid calendar date', (s) => { s.policy.expires_at = '2099-02-30T00:00:00.000Z'; }],
  ['unsafe count', (s) => { s.counters.write_consumed = Number.MAX_SAFE_INTEGER + 1; }],
  ['overspent cap', (s) => { s.counters.write_consumed = 3; }],
  ['permits above maximum', (s) => { s.counters.active_permits = 2; }],
  ['snapshot permit claim', (s) => { s.snapshot_is_dispatch_permission = true; }],
]) test(`snapshot rejects ${label}`, async () => {
  const s = snapshot(); mutate(s);
  const f = client(({ path }) => path === TASK_PATH ? json(s) : undefined);
  await assert.rejects(f.api.getTask(TASK, { clientConversationId: CONVERSATION }), code(error));
  assert.ok(f.calls.every(({ method }) => method === 'GET'));
});

for (const cap of [0, null]) test(`write cap ${cap} stays distinct and never indicates object count`, async () => {
  const s = snapshot(); s.policy.max_write_calls = cap; s.policy.expires_at = null;
  s.counters = { write_reserved: 0, write_consumed: 0, active_permits: 0 };
  const f = client(({ path }) => path === TASK_PATH ? json(s) : undefined);
  const result = await f.api.getTask(TASK, { clientConversationId: CONVERSATION });
  assert.deepEqual(result, s); assert.equal(result.metering, 'write_invocation');
});

test('managed turn preserves a frozen trusted binding and validates receipt support before POST', async () => {
  const options = { taskBinding: binding() };
  const f = client(({ path }) => { if (path === CAPS) options.taskBinding.task_id = RUN; });
  const result = await f.api.startTurn(turnInput(), options);
  assert.deepEqual(result.task_binding, binding());
  assert.deepEqual(f.calls.map(({ path }) => path), [CAPS, RECEIPT_CAPS, TURNS]);
  assert.deepEqual(f.calls[2].body.task_binding, binding());
  assert.equal(f.calls[2].body.taskBinding, undefined);
});

for (const [label, echo] of [['absent', undefined], ['other task', { ...binding(), task_id: RUN }],
  ['other scope', { ...binding(), scope_hash: 'f'.repeat(64) }]]) test(`managed turn rejects ${label} echo`, async () => {
  const f = client(({ path }) => path === TURNS ? json({ ...turn(), task_binding: echo }) : undefined);
  await assert.rejects(f.api.startTurn(turnInput(), { taskBinding: binding() }), code('TASK_BINDING_CONFLICT', 'task_control'));
  assert.equal(f.calls.length, 3);
});

test('receipt-incompatible managed Core cannot create a run', async () => {
  const f = client(({ path }) => path === RECEIPT_CAPS ? json({ error: 'not_found' }, 404) : undefined);
  await assert.rejects(f.api.startTurn(turnInput(), { taskBinding: binding() }), code('agent_schema_unsupported', 'unsupported'));
  assert.deepEqual(f.calls.map(({ path }) => path), [CAPS, RECEIPT_CAPS]);
});

test('legacy turn remains one POST, but cannot silently acquire an unsolicited task', async () => {
  const f = client(); await f.api.startTurn(turnInput());
  assert.deepEqual(f.calls.map(({ path, method }) => [path, method]), [[TURNS, 'POST']]);
  const bad = client(() => json(turn()));
  await assert.rejects(bad.api.startTurn(turnInput()), code('TASK_BINDING_CONFLICT'));
});

for (const field of ['taskBinding', 'task_binding', 'task_id', 'taskId']) test(`model turn input cannot select ${field}`, async () => {
  const f = client(); await assert.rejects(f.api.startTurn({ ...turnInput(), [field]: binding() }), TypeError);
  assert.equal(f.calls.length, 0);
});

for (const taskCode of ['TASK_REQUIRED', 'TASK_SCOPE_BLOCKED', 'TASK_MEMBER_MISMATCH', 'TASK_BINDING_CONFLICT',
  'TASK_PAUSED', 'TASK_CANCELLED', 'TASK_EXPIRED', 'TASK_WRITE_BUDGET_EXHAUSTED', 'TASK_CONCURRENCY_EXHAUSTED',
  'TASK_TOOL_NOT_ALLOWED', 'TASK_REVISION_CONFLICT']) test(`${taskCode} remains a structured gate rejection without retry advice`, async () => {
  const f = client(() => json({ error: taskCode, message: 'not-forwarded' }, 429));
  await assert.rejects(f.api.invoke({ agentRunId: RUN, invocationId: ID, capabilityRevision: REV,
    tool: 'goods_update', arguments: {} }), (error) => {
    assert.equal(error.publicCode, taskCode); assert.equal(error.feedback.category, 'task_control');
    assert.equal(error.feedback.dispatch, 'not_dispatched'); assert.equal(error.feedback.next_action, 'none');
    assert.equal(error.retryable, false); assert.equal(error.feedback.retryable, false);
    assert.equal(error.feedback.invocation_id, ID); return true;
  });
});

for (const taskCode of ['TASK_UNAVAILABLE', 'TASK_RECORD_INVALID']) test(`${taskCode} does not erase an uncertain original invocation`, async () => {
  const f = client(() => json({ error: taskCode }, 503));
  await assert.rejects(f.api.invoke({ agentRunId: RUN, invocationId: ID, capabilityRevision: REV,
    tool: 'goods_update', arguments: {} }), (error) => {
    assert.equal(error.publicCode, taskCode); assert.equal(error.feedback.category, 'invocation_outcome_unknown');
    assert.equal(error.feedback.invocation_id, ID); assert.equal(error.disposition, 'accepted_unknown'); return true;
  });
});

function credentials(profile, session = SESSION) {
  return { schema_version: 1, base_url: profile.baseUrl, client_app_id: profile.clientAppId, route: profile.workspace,
    session_id: session, access_token: `synthetic-${session}`, refresh_token: `synthetic-refresh-${session}`,
    access_expires_at: '2099-01-01T00:00:00.000Z', refresh_expires_at: '2099-02-01T00:00:00.000Z' };
}
async function hostFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'bailinghub-task-sdk-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const registry = new AgentConnectionRegistry(join(directory, 'registry.json'));
  const store = new AgentConnectionStore({ platform: 'linux', registry,
    environment: { BAILINGHUB_ALLOW_FILE_CREDENTIAL_STORE: 'true' },
    credentialPathFor: (key) => join(directory, 'credentials', `${key}.json`) });
  const a = await store.register({ baseUrl: HUB, clientAppId: 'commerce-agent', workspace: 'inventory' });
  const b = await store.register({ baseUrl: HUB, clientAppId: 'other-agent', workspace: 'other' }, { makeCurrent: true });
  await store.credentialStore(a.connectionKey).save(credentials(a));
  await store.credentialStore(b.connectionKey).save(credentials(b, OTHER_SESSION));
  const hooks = {};
  const f = client((call) => hooks.request?.(call));
  const transport = createAgentClientTransport({ hubUrl: HUB, clientAppId: b.clientAppId,
    workspace: b.workspace, connectionKey: b.connectionKey }, { connectionStore: store, fetchImpl: f.fetchImpl });
  const options = () => ({ connectionKey: a.connectionKey, workspace: a.workspace, clientConversationId: CONVERSATION,
    expectedBinding: { hubUrl: HUB, clientAppId: a.clientAppId, workspace: a.workspace, sessionId: SESSION } });
  return { ...f, a, b, registry, store, transport, options, hooks };
}
const hostCalls = {
  capabilities: (f, o) => f.transport.getTaskControlCapabilities(o),
  task: (f, o) => f.transport.getTask(TASK, o),
  turn: (f, o) => f.transport.startTurn(turnInput(), { ...o, taskBinding: o.taskBinding ?? binding() }),
};
for (const [name, call] of Object.entries(hostCalls)) {
  test(`host ${name} uses only the original target and freezes caller options before async reads`, async (t) => {
    const f = await hostFixture(t); const options = { ...f.options(), taskBinding: binding() };
    const get = f.registry.get.bind(f.registry); let switched = false;
    f.registry.get = async (key) => { if (!switched) { switched = true;
      options.connectionKey = f.b.connectionKey; options.workspace = 'other'; options.clientConversationId = 'other';
      options.expectedBinding.sessionId = OTHER_SESSION; options.taskBinding.task_id = RUN;
    } return get(key); };
    await call(f, options);
    assert.ok(f.calls.every(({ authorization }) => authorization === `Bearer synthetic-${SESSION}`));
    assert.ok(f.calls.every(({ path }) => !path.includes('/other/')));
    if (name === 'task') assert.equal(f.calls.at(-1).query.get('client_conversation_id'), CONVERSATION);
    if (name === 'turn') assert.deepEqual(f.calls.at(-1).body.task_binding, binding());
  });
  test(`host ${name} requires exact original binding with no default fallback`, async (t) => {
    const f = await hostFixture(t);
    for (const field of ['connectionKey', 'expectedBinding']) {
      const options = f.options(); delete options[field];
      await assert.rejects(call(f, options), TypeError);
    }
    for (const [key, value] of Object.entries({ hubUrl: 'https://other.example.com', clientAppId: 'other-agent',
      workspace: 'other', sessionId: OTHER_SESSION })) {
      const options = f.options(); options.expectedBinding[key] = value;
      await assert.rejects(call(f, options));
    }
    assert.equal(f.calls.length, 0);
  });
  for (const transient of [false, true]) test(`host ${name} rejects Session replacement during ${transient ? 'failed' : 'successful'} response`, async (t) => {
    const f = await hostFixture(t);
    f.hooks.request = async ({ path }) => {
      const finalPath = name === 'capabilities' ? CAPS : name === 'task' ? TASK_PATH : TURNS;
      if (path === finalPath) {
        await f.store.credentialStore(f.a.connectionKey).save(credentials(f.a, OTHER_SESSION));
        if (transient) throw new TypeError('synthetic network loss');
      }
    };
    await assert.rejects(call(f, f.options()), code('agent_binding_changed', 'authorization_unavailable'));
  });
}

test('managed cancellation after capability negotiation prevents run creation', async (t) => {
  const f = await hostFixture(t); const controller = new AbortController();
  f.hooks.request = ({ path }) => { if (path === CAPS) controller.abort(); };
  await assert.rejects(hostCalls.turn(f, { ...f.options(), signal: controller.signal }), code('agent_request_cancelled', 'cancelled'));
  assert.deepEqual(f.calls.map(({ path }) => path), [CAPS]);
});

test('host facade exposes no task creation or administration method', async (t) => {
  const f = await hostFixture(t);
  assert.equal(f.transport.createTask, undefined); assert.equal(f.transport.controlTask, undefined);
  assert.equal(f.transport.pauseTask, undefined);
});

for (const path of [CAPS, TASK_PATH]) {
  test(`unstructured HTTP 503 at ${path} remains unavailable, not unsupported`, async () => {
    const f = client((call) => call.path === path ? new Response('temporary outage', { status: 503 }) : undefined);
    await assert.rejects(f.api.getTask(TASK, { clientConversationId: CONVERSATION }), code('TASK_UNAVAILABLE', 'transport_unavailable'));
  });
  test(`invalid JSON at ${path} is a structured invalid record`, async () => {
    const f = client((call) => call.path === path ? new Response('{invalid', { status: 200 }) : undefined);
    await assert.rejects(f.api.getTask(TASK, { clientConversationId: CONVERSATION }), code('TASK_RECORD_INVALID', 'task_control'));
  });
}

test('a supported Core missing task is not mistaken for an old unsupported Core', async () => {
  const f = client(({ path }) => path === TASK_PATH ? json({ error: 'not_found' }, 404) : undefined);
  await assert.rejects(f.api.getTask(TASK, { clientConversationId: CONVERSATION }), (error) => {
    assert.equal(error.statusCode, 404); assert.notEqual(error.feedback.category, 'unsupported'); return true;
  });
});

for (const field of ['task_binding', 'task_id', 'taskId']) test(`misspelled host ${field} never silently downgrades`, async (t) => {
  const f = await hostFixture(t);
  await assert.rejects(f.transport.startTurn(turnInput(), { ...f.options(), [field]: binding() }), TypeError);
  await assert.rejects(f.api.startTurn(turnInput(), { [field]: binding() }), TypeError);
  assert.equal(f.calls.length, 0);
});

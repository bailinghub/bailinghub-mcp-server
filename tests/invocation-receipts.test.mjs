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
const ID = 'a'.repeat(64);
const CAPS_PATH = '/agent-api/v1/tool-invocations/inspection-capabilities';
const RECEIPT_PATH = `/agent-api/v1/tool-invocations/${ID}/receipt`;
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
const capabilities = () => ({ schema_version: 'bailing.agent-invocation-inspection-capabilities.v1',
  receipt_schema: 'bailing.agent-invocation-receipt.v1', read_only: true });
const result = (state = 'executed') => ({ schema_version: 'bailing.agent-tool-invocation.v1', invocation_id: ID,
  route: 'inventory', tool: 'goods_update', state, ok: state === 'executed', auto_retry_allowed: false, text: 'Synthetic result.' });
const receipt = () => ({ schema_version: 'bailing.agent-invocation-receipt.v1', invocation_id: ID,
  agent_run_id: RUN, route: 'inventory', tool: 'goods_update', observed_at: '2026-09-15T12:00:00.000Z',
  read_only: true, business_operation_performed: false, result: result(), result_source: 'job',
  dispatch_state: 'attempted', approval: { status: 'none' }, journal_state: 'completed' });
const connection = { baseUrl: HUB, clientAppId: 'commerce-agent', workspace: 'inventory', sessionId: SESSION,
  accessTokenProvider: { getAccessToken: async () => 'synthetic-access' } };
function client(handler) {
  const calls = [];
  const api = new BailingHubAgentClient(connection, { fetchImpl: async (url, init) => {
    const call = { path: new URL(String(url)).pathname, method: init.method, body: init.body,
      authorization: new Headers(init.headers).get('authorization') };
    calls.push(call);
    return await handler(call, calls.length);
  } });
  return { api, calls };
}
function assertGets(calls, paths) {
  assert.deepEqual(calls.map(({ path }) => path), paths);
  for (const call of calls) { assert.equal(call.method, 'GET'); assert.equal(call.body, undefined); }
}

test('inspection negotiates support then reads the exact original receipt, with GET only and public field allowlists', async () => {
  const response = receipt();
  response.arguments = { secret: 'not-forwarded' };
  response.access_token = 'not-forwarded';
  response.journal = { request: 'not-forwarded' };
  response.result.access_token = 'not-forwarded';
  response.approval.actor = 'not-forwarded';
  const { api, calls } = client(({ path }) => json(path === CAPS_PATH ? capabilities() : response));
  assert.deepEqual(await api.inspectInvocation(ID), receipt());
  assertGets(calls, [CAPS_PATH, RECEIPT_PATH]);
  assert.equal(calls.every((call) => call.authorization === 'Bearer synthetic-access'), true);
  assert.equal(AGENT_CLIENT_V1_PATHS.invocationReceipt(ID), RECEIPT_PATH);
});

for (const [label, response, status] of [
  ['old Core HTTP 404', { error: 'not_found' }, 404],
  ['new capability schema', { ...capabilities(), schema_version: 'future' }, 200],
  ['new receipt schema', { ...capabilities(), receipt_schema: 'future' }, 200],
  ['non-read-only contract', { ...capabilities(), read_only: false }, 200],
]) test(`inspection rejects ${label} as unsupported without a receipt or resume request`, async () => {
  const { api, calls } = client(() => json(response, status));
  await assert.rejects(api.inspectInvocation(ID), (error) => {
    assert.equal(error.publicCode, 'agent_schema_unsupported');
    assert.equal(error.feedback.category, 'unsupported');
    assert.equal(error.feedback.next_action, 'check_compatibility');
    assert.equal(error.feedback.invocation_id, ID);
    return true;
  });
  assertGets(calls, [CAPS_PATH]);
});

test('after support negotiation original-ID 404 remains an unresolved original invocation, never permission to resend', async () => {
  const { api, calls } = client(({ path }) => path === CAPS_PATH ? json(capabilities())
    : json({ error: 'invocation_not_found', details: 'not-forwarded' }, 404));
  await assert.rejects(api.inspectInvocation(ID), (error) => {
    assert.equal(error.publicCode, 'invocation_not_found'); assert.equal(error.statusCode, 404);
    assert.equal(error.feedback.category, 'invocation_outcome_unknown');
    assert.equal(error.feedback.operation, 'inspect'); assert.equal(error.feedback.invocation_id, ID);
    assert.equal(error.feedback.next_action, 'inspect_original'); assert.equal(error.feedback.retryable, false);
    assert.equal(JSON.stringify(error).includes('not-forwarded'), false);
    return true;
  });
  assertGets(calls, [CAPS_PATH, RECEIPT_PATH]);
});

test('an invalid original execution record preserves the Core code and requires evidence inspection without resume', async () => {
  const { api, calls } = client(({ path }) => path === CAPS_PATH ? json(capabilities())
    : json({ error: 'invocation_record_invalid', details: 'not-forwarded' }, 503));
  await assert.rejects(api.inspectInvocation(ID), (error) => {
    assert.equal(error.publicCode, 'invocation_record_invalid'); assert.equal(error.statusCode, 503);
    assert.equal(error.retryable, false);
    assert.equal(error.feedback.code, 'invocation_record_invalid');
    assert.equal(error.feedback.category, 'invocation_outcome_unknown');
    assert.equal(error.feedback.next_action, 'inspect_original'); assert.equal(error.feedback.retryable, false);
    assert.equal(error.feedback.invocation_id, ID); return true;
  });
  assertGets(calls, [CAPS_PATH, RECEIPT_PATH]);
});

for (const step of ['capabilities', 'receipt']) {
  test(`network loss during ${step} stays retryable read-only inspection, not business recovery`, async () => {
    const { api, calls } = client(({ path }) => {
      if (step === 'receipt' && path === CAPS_PATH) return json(capabilities());
      throw new TypeError('not-forwarded network detail');
    });
    await assert.rejects(api.inspectInvocation(ID), (error) => {
      assert.equal(error.publicCode, 'agent_transport_unavailable');
      assert.equal(error.feedback.category, 'transport_unavailable');
      assert.equal(error.feedback.next_action, 'inspect_original'); assert.equal(error.feedback.retryable, true);
      assert.equal(error.feedback.operation, 'inspect'); assert.equal(error.feedback.invocation_id, ID);
      assert.equal(error.disposition, 'definitive_rejection');
      return true;
    });
    assertGets(calls, step === 'receipt' ? [CAPS_PATH, RECEIPT_PATH] : [CAPS_PATH]);
  });
  for (const status of [401, 403]) test(`HTTP ${status} during ${step} preserves authorization failure and never resumes`, async () => {
    const { api, calls } = client(({ path }) => step === 'receipt' && path === CAPS_PATH ? json(capabilities())
      : json({ error: 'route_not_allowed', detail: 'not-forwarded' }, status));
    await assert.rejects(api.inspectInvocation(ID), (error) => {
      assert.equal(error.statusCode, status); assert.equal(error.feedback.category, 'authorization_unavailable');
      assert.equal(error.feedback.next_action, 'reauthorize'); return true;
    });
    assert.equal(calls.every((call) => call.method === 'GET' && call.body === undefined), true);
    assert.equal(calls.some((call) => call.path.endsWith('/resume')), false);
  });
}

test('receipts preserve absence, dispatch evidence, approval and current original result without promoting inspection to execution', async () => {
  for (const journal of ['absent', 'dispatching', 'response_recorded', 'completed', 'uncertain', 'evidence_degraded', 'unknown']) {
    const value = { ...receipt(), journal_state: journal, result: null, result_source: 'none', dispatch_state: 'unknown' };
    const { api } = client(({ path }) => json(path === CAPS_PATH ? capabilities() : value));
    assert.deepEqual(await api.inspectInvocation(ID), value);
  }
  for (const status of ['pending', 'approved', 'denied']) {
    const value = { ...receipt(), result: result('awaiting_approval'), result_source: 'journal', dispatch_state: 'not_dispatched',
      approval: { status, approval_id: 5 } };
    const { api } = client(({ path }) => json(path === CAPS_PATH ? capabilities() : value));
    assert.deepEqual(await api.inspectInvocation(ID), value);
  }
});

test('uncertain stored result points to inspection and does not suggest resuming from a read-only response', async () => {
  const value = { ...receipt(), result: result('reconciliation_required'), journal_state: 'uncertain', dispatch_state: 'unknown' };
  const { api } = client(({ path }) => json(path === CAPS_PATH ? capabilities() : value));
  const observed = await api.inspectInvocation(ID);
  assert.equal(observed.result.state, 'reconciliation_required');
  assert.equal(observed.result.feedback.category, 'invocation_outcome_unknown');
  assert.equal(observed.result.feedback.operation, 'inspect');
  assert.equal(observed.result.feedback.next_action, 'inspect_original');
  assert.equal(observed.result.feedback.retryable, false);
});

test('receipt schema and identity checks reject untrusted, inconsistent, or malformed responses', async () => {
  const mutations = [
    (r) => { r.schema_version = 'future'; }, (r) => { r.read_only = false; },
    (r) => { r.business_operation_performed = true; }, (r) => { r.invocation_id = 'b'.repeat(64); },
    (r) => { r.route = 'other-system'; }, (r) => { r.agent_run_id = 'invalid'; },
    (r) => { r.tool = 'other_tool'; }, (r) => { r.result.invocation_id = 'b'.repeat(64); },
    (r) => { r.result.route = 'other-system'; }, (r) => { r.result.text = {}; },
    (r) => { r.result = null; }, (r) => { r.result_source = 'none'; },
    (r) => { r.dispatch_state = 'executed'; }, (r) => { r.journal_state = 'invented'; },
    (r) => { r.observed_at = 'yesterday'; }, (r) => { r.approval.approval_id = 1; },
    (r) => { r.approval.status = 'invented'; }, (r) => { r.approval = { status: 'pending', approval_id: -1 }; },
    (r) => { r.approval = { status: 'pending' }; }, (r) => { r.approval = { status: 'approved' }; },
    (r) => { r.approval = { status: 'denied' }; },
  ];
  for (const mutate of mutations) {
    const value = receipt(); mutate(value);
    const { api, calls } = client(({ path }) => json(path === CAPS_PATH ? capabilities() : value));
    await assert.rejects(api.inspectInvocation(ID));
    assertGets(calls, [CAPS_PATH, RECEIPT_PATH]);
  }
});

test('invalid invocation IDs are rejected before HTTP and do not become alternative selectors', async () => {
  const { api, calls } = client(() => { assert.fail('No request expected.'); });
  for (const id of ['', `${ID}/resume`, ` ${ID}`, 'A'.repeat(64), { invocation_id: ID }]) {
    await assert.rejects(api.inspectInvocation(id), (error) => error.feedback.category === 'invalid_request');
  }
  assert.equal(calls.length, 0);
});

function credentials(profile, sessionId) {
  return { schema_version: 1, base_url: profile.baseUrl, client_app_id: profile.clientAppId,
    route: profile.workspace, session_id: sessionId, access_token: `synthetic-${sessionId}`, refresh_token: 'synthetic-refresh',
    access_expires_at: '2099-01-01T00:00:00.000Z', refresh_expires_at: '2099-02-01T00:00:00.000Z' };
}
async function hostFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'bailing-receipt-binding-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const registry = new AgentConnectionRegistry(join(directory, 'registry.json'));
  const store = new AgentConnectionStore({ platform: 'linux', registry,
    environment: { BAILINGHUB_ALLOW_FILE_CREDENTIAL_STORE: 'true' }, credentialPathFor: (key) => join(directory, `${key}.json`) });
  const a = await store.register({ baseUrl: HUB, clientAppId: 'commerce-agent', workspace: 'inventory' }, { alias: 'a' });
  const b = await store.register({ baseUrl: HUB, clientAppId: 'other-agent', workspace: 'other' }, { alias: 'b', makeCurrent: true });
  await store.credentialStore(a.connectionKey).save(credentials(a, SESSION));
  await store.credentialStore(b.connectionKey).save(credentials(b, OTHER_SESSION));
  const calls = []; const hooks = {};
  const transport = createAgentClientTransport({ hubUrl: HUB, clientAppId: b.clientAppId, workspace: b.workspace, connectionKey: b.connectionKey },
    { connectionStore: store, fetchImpl: async (url, init) => {
      const call = { path: new URL(String(url)).pathname, method: init.method, body: init.body,
        authorization: new Headers(init.headers).get('authorization') };
      calls.push(call);
      const override = await hooks.request?.(call);
      return override ?? json(call.path === CAPS_PATH ? capabilities() : receipt());
    } });
  const options = () => ({ connectionKey: a.connectionKey, workspace: a.workspace,
    expectedBinding: { hubUrl: HUB, clientAppId: a.clientAppId, workspace: a.workspace, sessionId: SESSION } });
  return { a, b, registry, store, transport, options, hooks, calls };
}

test('host facade requires the full original binding and ignores a different global default', async (t) => {
  const f = await hostFixture(t);
  assert.deepEqual(await f.transport.inspectInvocation(ID, f.options()), receipt());
  assertGets(f.calls, [CAPS_PATH, RECEIPT_PATH]);
  assert.equal(f.calls.every((call) => call.authorization === `Bearer synthetic-${SESSION}`), true);
  f.calls.length = 0;
  for (const field of ['connectionKey', 'workspace', 'expectedBinding']) {
    const options = f.options(); delete options[field];
    await assert.rejects(f.transport.inspectInvocation(ID, options));
  }
  for (const [key, value] of Object.entries({ hubUrl: 'https://other.example.com', clientAppId: 'other-agent', workspace: 'other', sessionId: OTHER_SESSION })) {
    const options = f.options(); options.expectedBinding[key] = value;
    await assert.rejects(f.transport.inspectInvocation(ID, options));
  }
  assert.equal(f.calls.length, 0);
});

test('host options are frozen before the first asynchronous registry read', async (t) => {
  const f = await hostFixture(t);
  const original = f.registry.get.bind(f.registry); let switched = false;
  const options = f.options();
  f.registry.get = async (key) => {
    if (!switched) {
      switched = true; options.connectionKey = f.b.connectionKey; options.workspace = f.b.workspace;
      Object.assign(options.expectedBinding, { clientAppId: f.b.clientAppId, workspace: f.b.workspace, sessionId: OTHER_SESSION });
    }
    return original(key);
  };
  await f.transport.inspectInvocation(ID, options);
  assertGets(f.calls, [CAPS_PATH, RECEIPT_PATH]);
  assert.equal(f.calls.every((call) => call.authorization === `Bearer synthetic-${SESSION}`), true);
});

for (const step of ['capabilities', 'receipt']) test(`host rejects a Session replacement racing the ${step} response`, async (t) => {
  const f = await hostFixture(t);
  f.hooks.request = async ({ path }) => {
    if (path === (step === 'capabilities' ? CAPS_PATH : RECEIPT_PATH)) {
      await f.store.credentialStore(f.a.connectionKey).save(credentials(f.a, OTHER_SESSION));
    }
  };
  await assert.rejects(f.transport.inspectInvocation(ID, f.options()), (error) => {
    assert.equal(error.publicCode, 'agent_binding_changed');
    assert.equal(error.feedback.category, 'authorization_unavailable');
    assert.equal(error.feedback.invocation_id, ID); return true;
  });
  assertGets(f.calls, step === 'capabilities' ? [CAPS_PATH] : [CAPS_PATH, RECEIPT_PATH]);
});

test('host rejects a removed original registry entry after negotiation without requesting another Session', async (t) => {
  const f = await hostFixture(t);
  f.hooks.request = async ({ path }) => { if (path === CAPS_PATH) await f.registry.remove(f.a.connectionKey); };
  await assert.rejects(f.transport.inspectInvocation(ID, f.options()), (error) => error.publicCode === 'agent_binding_changed');
  assertGets(f.calls, [CAPS_PATH]);
});

test('caller cancellation during negotiation prevents receipt access and all business requests', async (t) => {
  const f = await hostFixture(t); const controller = new AbortController();
  f.hooks.request = async ({ path }) => { if (path === CAPS_PATH) controller.abort(); };
  await assert.rejects(f.transport.inspectInvocation(ID, { ...f.options(), signal: controller.signal }),
    (error) => error.publicCode === 'agent_request_cancelled' && error.feedback.category === 'cancelled');
  assertGets(f.calls, [CAPS_PATH]);
});

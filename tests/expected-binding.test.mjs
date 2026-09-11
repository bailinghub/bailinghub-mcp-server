import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { AgentConnectionRegistry, AgentConnectionStore, createAgentClientTransport } from '../dist/sdk.js';

const HUB = 'https://hub.example.com';
const SESSION_A = '11111111-1111-4111-8111-111111111111';
const SESSION_B = '22222222-2222-4222-8222-222222222222';
const RUN = '33333333-3333-4333-8333-333333333333';
const INVOCATION = 'a'.repeat(64);
const REVISION = 'b'.repeat(64);

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function credential(profile, sessionId, expired = false) {
  return {
    schema_version: 1, base_url: profile.baseUrl, client_app_id: profile.clientAppId,
    route: profile.workspace, session_id: sessionId,
    access_token: `synthetic-access-${sessionId}`, refresh_token: `synthetic-refresh-${sessionId}`,
    access_expires_at: expired ? '2020-01-01T00:00:00.000Z' : '2099-01-01T00:00:00.000Z',
    refresh_expires_at: '2099-02-01T00:00:00.000Z',
  };
}

const METHODS = {
  getSystemInfo: (transport, options) => transport.getSystemInfo(options),
  status: (transport, options) => transport.status(options),
  startTurn: (transport, options) => transport.startTurn({
    clientConversationId: 'conversation-a', clientTurnId: 'turn-a',
    userMessageId: 'message-a', userInput: 'Only the selected synthetic store.',
  }, options),
  searchCapabilities: (transport, options) => transport.searchCapabilities({ query: 'record', runId: RUN, limit: 1 }, options),
  invoke: (transport, options) => transport.invoke({
    run_id: RUN, client_invocation_id: INVOCATION, tool: 'record_update',
    capability_revision: REVISION, arguments: { record_id: 'synthetic-record-a' },
  }, options),
  resume: (transport, options) => transport.resume(INVOCATION, {}, options),
  completeRun: (transport, options) => transport.completeRun(RUN, {
    assistant_message_id: 'answer-a', content: 'Selected store completed.', status: 'completed',
  }, options),
};

async function fixture(t, { expired = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'bailinghub-expected-binding-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const registry = new AgentConnectionRegistry(join(directory, 'registry.json'));
  const store = new AgentConnectionStore({
    platform: 'linux', registry,
    environment: { BAILINGHUB_ALLOW_FILE_CREDENTIAL_STORE: 'true' },
    credentialPathFor: (key) => join(directory, 'credentials', `${key}.json`),
  });
  const a = await store.register({ baseUrl: HUB, clientAppId: 'commerce-agent', workspace: 'orders' }, { alias: 'store-a' });
  const b = await store.register({ baseUrl: HUB, clientAppId: 'crm-agent', workspace: 'contacts' }, { alias: 'crm-b', makeCurrent: true });
  const credentialsA = credential(a, SESSION_A, expired);
  const credentialsB = credential(b, SESSION_B);
  const rawStores = new Map([a, b].map((profile) => [profile.connectionKey, store.credentialStore(profile.connectionKey)]));
  await rawStores.get(a.connectionKey).save(credentialsA);
  await rawStores.get(b.connectionKey).save(credentialsB);
  const hooks = {};
  let registryReads = 0;
  const get = registry.get.bind(registry);
  registry.get = async (key) => {
    const value = await get(key);
    const read = ++registryReads;
    await hooks.registryRead?.({ key, read, value });
    return value;
  };
  for (const [key, original] of rawStores) {
    const load = original.load.bind(original);
    original.load = async () => {
      const value = await load();
      await hooks.credentialRead?.({ key, value });
      return value;
    };
  }
  store.credentialStore = (key) => {
    const original = rawStores.get(key);
    assert.ok(original, 'No unselected credential slot may be opened.');
    // Keep the real file-store identity and refresh-lock scope intact.
    return original;
  };
  const calls = [];
  const json = (value) => new Response(JSON.stringify(value), { status: 200 });
  const transport = createAgentClientTransport({
    hubUrl: HUB, clientAppId: b.clientAppId, workspace: b.workspace, connectionKey: b.connectionKey,
  }, {
    connectionStore: store,
    fetchImpl: async (url, init) => {
      const path = new URL(String(url)).pathname;
      const authorization = new Headers(init.headers).get('authorization');
      const body = init.body ? JSON.parse(init.body) : undefined;
      const request = { url: String(url), path, method: init.method, body, authorization, registryReads };
      calls.push(request);
      const override = await hooks.request?.(request);
      if (override) return override;
      if (path === '/agent-auth/v1/token') {
        return json({
          token_type: 'Bearer', access_token: credentialsA.access_token, refresh_token: credentialsA.refresh_token,
          expires_in: 3600, refresh_expires_in: 7200, session_id: SESSION_A, client_app_id: a.clientAppId,
        });
      }
      if (path === '/agent-auth/v1/session') {
        const selected = authorization === `Bearer ${credentialsB.access_token}` ? b : a;
        const sessionId = selected === a ? SESSION_A : SESSION_B;
        return json({
          session_id: sessionId, client_app_id: selected.clientAppId, device_label: 'synthetic',
          principal: { id: 'synthetic-user' }, on_behalf_of: `synthetic:${selected.alias}`,
          allowed_routes: [selected.workspace], created_at: '2026-01-01T00:00:00.000Z',
          expires_at: '2099-01-01T00:00:00.000Z', refresh_expires_at: '2099-02-01T00:00:00.000Z',
        });
      }
      if (path.endsWith('/system-info')) return json({
        schema_version: 'bailing.agent-system-info.v1',
        binding: { client_app_id: a.clientAppId, session_id: SESSION_A, workspace: a.workspace },
        metadata_status: 'configured', revision: REVISION,
        system: { name: 'Order Operations', summary: 'Manage online orders.', domains: ['Orders'], boundaries: ['No payroll'] },
        tool_status: 'not_loaded', availability: 'unknown',
      });
      if (path.endsWith('/turns')) return json({
        schema_version: 'bailing.agent-turn-context.v1', run_id: RUN,
        profile_revision: REVISION, capability_revision: REVISION,
        context: { instructions: 'Synthetic store only.', page_context: {}, renderers: [], memory: null,
          memory_refs: [], knowledge: [], knowledge_refs: [], governance: {} }, active_tools: [],
      });
      if (path.endsWith('/capabilities/search')) return json({
        schema_version: 'bailing.agent-capability-search.v1', capability_revision: REVISION, tools: [],
      });
      if (path.includes('/tool-invocations')) return json({
        schema_version: 'bailing.agent-tool-invocation.v1', invocation_id: INVOCATION,
        route: a.workspace, tool: 'record_update', state: 'executed', ok: true,
        auto_retry_allowed: false, text: 'Synthetic result.',
      });
      if (path.endsWith('/complete')) return json({ schema_version: 'bailing.agent-run-completion.v1', run_id: RUN, status: body.status });
      assert.fail(`Unexpected synthetic request: ${path}`);
    },
  });
  const expected = { hubUrl: HUB, clientAppId: a.clientAppId, workspace: a.workspace, sessionId: SESSION_A };
  const options = () => ({ connectionKey: a.connectionKey, workspace: a.workspace, expectedBinding: { ...expected } });
  return { a, b, credentialsA, credentialsB, registry, rawStores, hooks, calls, transport, expected, options };
}

for (const [name, call] of Object.entries(METHODS)) {
  test(`${name} honors the complete expected A binding despite default B`, async (t) => {
    const f = await fixture(t);
    const result = await call(f.transport, f.options());
    assert.equal(f.calls.length, 1);
    const request = f.calls[0];
    assert.equal(request.authorization, `Bearer ${f.credentialsA.access_token}`);
    assert.equal(new URL(request.url).origin, HUB);
    assert.equal((JSON.stringify(request.body) ?? '').includes('expectedBinding'), false);
    if (name === 'status') {
      assert.equal(result.sessionId, SESSION_A);
      assert.equal(result.connectionKey, f.a.connectionKey);
      assert.equal(result.workspace, f.a.workspace);
    } else if (name === 'invoke') {
      assert.equal(request.body.route, f.a.workspace);
      assert.deepEqual(request.body.arguments, { record_id: 'synthetic-record-a' });
      assert.equal(request.body.agent_run_id, RUN);
    } else if (name === 'resume') assert.ok(request.path.includes(INVOCATION));
    else if (name === 'completeRun') assert.equal(request.path, `/agent-api/v1/runs/${RUN}/complete`);
    else assert.ok(request.path.includes(`/workspaces/${f.a.workspace}/`));
  });

  test(`${name} rejects every original binding mismatch before any HTTP`, async (t) => {
    const f = await fixture(t);
    for (const [field, changed] of Object.entries({
      hubUrl: 'https://other.example.com', clientAppId: 'other-agent', workspace: 'other-route', sessionId: SESSION_B,
    })) {
      const options = f.options();
      options.expectedBinding[field] = changed;
      await assert.rejects(call(f.transport, options), undefined, field);
      assert.equal(f.calls.length, 0, `${field} mismatch sent HTTP`);
    }
  });

  test(`${name} snapshots host options before the first asynchronous registry read`, async (t) => {
    const f = await fixture(t);
    const entered = deferred();
    const release = deferred();
    f.hooks.registryRead = async ({ read }) => {
      if (read === 1) { entered.resolve(); await release.promise; }
    };
    const options = f.options();
    const pending = call(f.transport, options);
    await entered.promise;
    options.connectionKey = f.b.connectionKey;
    options.workspace = f.b.workspace;
    Object.assign(options.expectedBinding, { clientAppId: f.b.clientAppId, workspace: f.b.workspace, sessionId: SESSION_B });
    release.resolve();
    await pending;
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].authorization, `Bearer ${f.credentialsA.access_token}`);
    assert.equal(f.calls[0].path.includes('/contacts/'), false);
  });

  test(`${name} refuses a removed registry entry even when an earlier lookup returns late`, async (t) => {
    const f = await fixture(t);
    f.hooks.registryRead = async ({ read }) => { if (read === 1) await f.registry.remove(f.a.connectionKey); };
    await assert.rejects(call(f.transport, f.options()));
    assert.equal(f.calls.length, 0);
  });

  test(`${name} refuses a replaced Session after an earlier credential read resolves`, async (t) => {
    const f = await fixture(t);
    let replaced = false;
    f.hooks.credentialRead = async ({ key }) => {
      if (key === f.a.connectionKey && !replaced) {
        replaced = true;
        await f.rawStores.get(key).save({ ...f.credentialsA, session_id: SESSION_B, access_token: 'synthetic-replacement' });
      }
    };
    await assert.rejects(call(f.transport, f.options()));
    assert.equal(f.calls.length, 0);
  });
}

test('status rejects a valid but late original response after its stored Session is replaced', async (t) => {
  const f = await fixture(t);
  f.hooks.request = async ({ path }) => {
    assert.equal(path, '/agent-auth/v1/session');
    await f.rawStores.get(f.a.connectionKey).save({ ...f.credentialsA, session_id: SESSION_B, access_token: 'synthetic-replacement' });
  };
  await assert.rejects(f.transport.status(f.options()), (error) => error.publicCode === 'agent_binding_changed');
  assert.equal(f.calls.length, 1);
  assert.equal((await f.rawStores.get(f.a.connectionKey).load()).session_id, SESSION_B);
});

for (const transientFailure of [false, true]) {
  test(`system information detects replacement during a ${transientFailure ? 'failed' : 'successful'} response`, async (t) => {
    const f = await fixture(t);
    f.hooks.request = async ({ path }) => {
      assert.equal(path, '/agent-api/v1/workspaces/orders/system-info');
      await f.rawStores.get(f.a.connectionKey).save({ ...f.credentialsA, session_id: SESSION_B });
      if (transientFailure) throw new TypeError('Synthetic connection failure');
    };
    await assert.rejects(f.transport.getSystemInfo(f.options()), (error) => error.publicCode === 'agent_binding_changed');
    assert.equal(f.calls.length, 1);
  });
}

test('system information requires a selected exact target and never falls back to default B', async (t) => {
  const f = await fixture(t);
  for (const options of [{}, { workspace: 'orders' }, { connectionKey: f.a.connectionKey },
    { ...f.options(), connectionName: 'store-a' }]) {
    await assert.rejects(f.transport.getSystemInfo(options), TypeError);
  }
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(f.transport.getSystemInfo({ ...f.options(), signal: controller.signal }),
    (error) => error.publicCode === 'agent_request_cancelled');
  assert.equal(f.calls.length, 0);
});

test('system information retries only when requested, with the original identity and no cached authorization', async (t) => {
  const f = await fixture(t);
  f.hooks.request = () => { throw new TypeError('Synthetic offline error'); };
  await assert.rejects(f.transport.getSystemInfo(f.options()), (error) => error.retryable === true);
  assert.equal(f.calls.length, 1);
  f.hooks.request = undefined;
  assert.equal((await f.transport.getSystemInfo(f.options())).system.name, 'Order Operations');
  assert.equal(f.calls.length, 2);
  f.hooks.request = () => new Response(JSON.stringify({ error: 'route_not_allowed' }), { status: 403 });
  await assert.rejects(f.transport.getSystemInfo(f.options()), (error) => error.statusCode === 403);
  assert.equal(f.calls.length, 3);
  assert.ok(f.calls.every((call) => call.method === 'GET' && call.body === undefined &&
    call.path === '/agent-api/v1/workspaces/orders/system-info' &&
    call.authorization === `Bearer ${f.credentialsA.access_token}`));
});

test('legacy calls without expectedBinding retain explicit-key selection', async (t) => {
  const f = await fixture(t);
  for (const call of Object.values(METHODS)) await call(f.transport, { connectionKey: f.a.connectionKey, workspace: f.a.workspace });
  assert.equal(f.calls.length, Object.keys(METHODS).length);
  assert.ok(f.calls.every((entry) => entry.authorization === `Bearer ${f.credentialsA.access_token}`));
});

for (const expired of [false, true]) for (const operation of ['startTurn', 'invoke', 'resume']) {
  test(`the final ${operation} ${expired ? 'refresh' : 'business'} dispatch guard rejects Session replacement during registry IO`, async (t) => {
    // Locate the last registry read before the first HTTP using a healthy run,
    // without coupling the test to how many earlier validation reads are needed.
    const baseline = await fixture(t, { expired });
    await METHODS[operation](baseline.transport, baseline.options());
    const boundary = baseline.calls[0].registryReads;
    assert.equal(baseline.calls[0].path === '/agent-auth/v1/token', expired);
    const f = await fixture(t, { expired });
    let replaced = false;
    f.hooks.registryRead = async ({ key, read }) => {
      if (read === boundary) {
        replaced = true;
        await f.rawStores.get(key).save({ ...f.credentialsA, session_id: SESSION_B, access_token: 'synthetic-replacement' });
      }
    };
    await assert.rejects(METHODS[operation](f.transport, f.options()), (error) => {
      assert.equal(error.feedback.dispatch, 'not_dispatched');
      assert.equal(error.feedback.category, 'authorization_unavailable');
      return true;
    });
    assert.equal(replaced, true, 'The asynchronous dispatch boundary was exercised.');
    assert.equal(f.calls.length, 0, 'Neither refresh credentials nor business input may be sent after replacement.');
    assert.equal((await f.rawStores.get(f.a.connectionKey).load()).session_id, SESSION_B);
  });
}

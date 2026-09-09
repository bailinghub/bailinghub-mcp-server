import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentClientTransport } from '../dist/sdk.js';

const KEY = `conn_${'1'.repeat(32)}`;
const SESSION = '11111111-1111-4111-8111-111111111111';
const RUN = '22222222-2222-4222-8222-222222222222';
const INVOCATION = 'a'.repeat(64);
const REVISION = 'b'.repeat(64);
const profile = { connectionKey: KEY, baseUrl: 'https://hub.example.com', clientAppId: 'cashier_app', workspace: 'cashier', allowInsecureHttp: false };
const expectedBinding = { hubUrl: profile.baseUrl, clientAppId: profile.clientAppId, workspace: profile.workspace, sessionId: SESSION };

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

const METHODS = {
  status: (transport, options) => transport.status(options),
  startTurn: (transport, options) => transport.startTurn({ clientConversationId: 'conversation', clientTurnId: 'turn', userMessageId: 'message', userInput: 'Synthetic local task' }, options),
  searchCapabilities: (transport, options) => transport.searchCapabilities({ query: 'record', runId: RUN, limit: 1 }, options),
  invoke: (transport, options) => transport.invoke({ run_id: RUN, invocation_id: INVOCATION, tool: 'record_update', capability_revision: REVISION, arguments: { record_id: 'synthetic-record' } }, options),
  resume: (transport, options) => transport.resume(INVOCATION, {}, options),
  completeRun: (transport, options) => transport.completeRun(RUN, { assistant_message_id: 'answer', content: 'Synthetic answer', status: 'completed' }, options),
};

function fixture({ expired = false } = {}) {
  // Fully synthetic asynchronous persistence: never open a real credential store.
  let credentials = {
    schema_version: 1, base_url: profile.baseUrl, client_app_id: profile.clientAppId, route: profile.workspace,
    session_id: SESSION, access_token: 'synthetic-access', refresh_token: 'synthetic-refresh',
    access_expires_at: expired ? '2020-01-01T00:00:00.000Z' : '2099-01-01T00:00:00.000Z',
    refresh_expires_at: '2099-02-01T00:00:00.000Z',
  };
  const hooks = {};
  const calls = [];
  let registryReads = 0;
  const store = { registry: { get: async (key) => {
    assert.equal(key, KEY);
    registryReads += 1;
    await hooks.registryRead?.(registryReads);
    return structuredClone(profile);
  } }, credentialStore: (key) => {
    assert.equal(key, KEY);
    return {
      load: async () => structuredClone(credentials),
      save: async (value) => { credentials = structuredClone(value); },
      delete: async () => { credentials = undefined; },
    };
  } };
  const json = (value) => new Response(JSON.stringify(value), { status: 200 });
  const transport = createAgentClientTransport({ hubUrl: profile.baseUrl, clientAppId: profile.clientAppId, workspace: profile.workspace }, {
    connectionStore: store,
    fetchImpl: async (url, init) => {
      const path = new URL(String(url)).pathname;
      const body = init.body ? JSON.parse(init.body) : undefined;
      const call = { path, body, signal: init.signal, registryReads };
      calls.push(call);
      const override = await hooks.request?.(call);
      if (override) return override;
      if (path === '/agent-auth/v1/token') return json({ token_type: 'Bearer', access_token: 'synthetic-refreshed-access', refresh_token: 'synthetic-refreshed-refresh',
        expires_in: 3600, refresh_expires_in: 7200, session_id: SESSION, client_app_id: profile.clientAppId });
      if (path === '/agent-auth/v1/session') return json({ session_id: SESSION, client_app_id: profile.clientAppId,
        device_label: 'synthetic', principal: { id: 'synthetic-user' }, on_behalf_of: 'synthetic:store', allowed_routes: [profile.workspace],
        created_at: '2026-01-01T00:00:00.000Z', expires_at: '2099-01-01T00:00:00.000Z', refresh_expires_at: '2099-02-01T00:00:00.000Z' });
      if (path.endsWith('/turns')) return json({ schema_version: 'bailing.agent-turn-context.v1', run_id: RUN,
        profile_revision: REVISION, capability_revision: REVISION, context: { instructions: 'Synthetic', page_context: {}, renderers: [], memory: null,
          memory_refs: [], knowledge: [], knowledge_refs: [], governance: {} }, active_tools: [] });
      if (path.endsWith('/capabilities/search')) return json({ schema_version: 'bailing.agent-capability-search.v1', capability_revision: REVISION, tools: [] });
      if (path.includes('/tool-invocations')) return json({ schema_version: 'bailing.agent-tool-invocation.v1', invocation_id: INVOCATION,
        route: profile.workspace, tool: 'record_update', state: 'executed', ok: true, auto_retry_allowed: false, text: 'Synthetic response' });
      if (path.endsWith('/complete')) return json({ schema_version: 'bailing.agent-run-completion.v1', run_id: RUN, status: body.status });
      assert.fail(`Unexpected synthetic path: ${path}`);
    },
  });
  const options = (signal) => ({ connectionKey: KEY, workspace: profile.workspace, expectedBinding: { ...expectedBinding }, signal });
  return { transport, calls, hooks, options };
}

function cancellationBeforeDispatch(error) {
  assert.notEqual(error?.disposition, 'accepted_unknown', 'A request that was never dispatched has a definite cancellation outcome.');
  assert.ok(error?.name === 'AbortError' || error?.disposition === 'definitive_rejection');
  return true;
}

for (const [name, call] of Object.entries(METHODS)) {
  test(`${name} with an already cancelled caller never performs HTTP`, async () => {
    const f = fixture();
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(call(f.transport, f.options(controller.signal)), cancellationBeforeDispatch);
    assert.deepEqual(f.calls, []);
  });

  test(`${name} cancelled while awaiting registry IO never performs later HTTP`, async () => {
    const f = fixture();
    const entered = deferred();
    const release = deferred();
    f.hooks.registryRead = async (read) => { if (read === 1) { entered.resolve(); await release.promise; } };
    const controller = new AbortController();
    const pending = call(f.transport, f.options(controller.signal));
    const outcome = pending.then((value) => ({ value }), (error) => ({ error }));
    await entered.promise;
    controller.abort();
    release.resolve();
    const result = await outcome;
    assert.ok(result.error, 'The cancelled operation must reject.');
    cancellationBeforeDispatch(result.error);
    assert.deepEqual(f.calls, []);
  });
}

test('cancellation at the final refresh dispatch boundary sends neither refresh credentials nor business input', async () => {
  const baseline = fixture({ expired: true });
  await METHODS.startTurn(baseline.transport, baseline.options(new AbortController().signal));
  assert.equal(baseline.calls[0].path, '/agent-auth/v1/token');
  const lastReadBeforeRefresh = baseline.calls[0].registryReads;
  const f = fixture({ expired: true });
  const controller = new AbortController();
  f.hooks.registryRead = async (read) => { if (read === lastReadBeforeRefresh) controller.abort(); };
  await assert.rejects(METHODS.startTurn(f.transport, f.options(controller.signal)), cancellationBeforeDispatch);
  assert.deepEqual(f.calls, []);
});

for (const name of ['invoke', 'resume']) {
  test(`${name} cancelled after dispatch preserves the original invocation as accepted_unknown and does not replay`, async () => {
    const f = fixture();
    const entered = deferred();
    let releaseFailure;
    f.hooks.request = async ({ signal }) => {
      entered.resolve();
      return new Promise((_resolve, reject) => {
        const fail = () => reject(new DOMException('Synthetic cancelled fetch', 'AbortError'));
        releaseFailure = fail;
        if (signal?.aborted) fail();
        else signal?.addEventListener('abort', fail, { once: true });
      });
    };
    const controller = new AbortController();
    const outcome = METHODS[name](f.transport, f.options(controller.signal)).then((value) => ({ value }), (error) => ({ error }));
    await entered.promise;
    controller.abort();
    await new Promise((resolve) => setImmediate(resolve));
    const forwardedCancellation = f.calls[0].signal?.aborted;
    // Also settle a broken implementation without waiting for its request timeout.
    releaseFailure();
    const { error } = await outcome;
    assert.equal(forwardedCancellation, true, 'The caller cancellation must reach the actual in-flight fetch.');
    assert.equal(error?.disposition, 'accepted_unknown');
    assert.equal(error?.invocationId, INVOCATION);
    assert.equal(f.calls.length, 1, 'Cancellation must not automatically invoke, resume or refresh again.');
  });
}

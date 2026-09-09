import assert from 'node:assert/strict';
import test from 'node:test';
import { BailingHubAgentClient } from '../dist/agent-client.js';

const binding = { client_app_id: 'operations-agent', session_id: '11111111-1111-4111-8111-111111111111', workspace: 'orders' };
function info() {
  return {
    schema_version: 'bailing.agent-system-info.v1', binding: { ...binding },
    metadata_status: 'configured', revision: 'a'.repeat(64),
    system: { name: 'Order Operations', summary: 'Manage online orders.', domains: ['Orders'], boundaries: ['No payroll'] },
    tool_status: 'not_loaded', availability: 'unknown',
  };
}
function client(fetchImpl) {
  return new BailingHubAgentClient({
    baseUrl: 'https://hub.example.com', clientAppId: binding.client_app_id,
    workspace: binding.workspace, sessionId: binding.session_id,
    accessTokenProvider: { getAccessToken: async () => 'synthetic-agent-token' },
  }, { fetchImpl });
}
const json = (value, status = 200) => new Response(JSON.stringify(value), { status });

test('system info projects only product positioning and binding, without tool discovery or business input', async () => {
  const raw = info();
  raw.access_token = 'omit-top-secret';
  raw.instructions = 'omit-top-instruction';
  raw.binding.refresh_token = 'omit-binding-secret';
  raw.system.instructions = 'omit-nested-instruction';
  raw.system.tools = [{ name: 'not-a-grant' }];
  const calls = [];
  const result = await client(async (url, init) => {
    calls.push({ url, init });
    return json(raw);
  }).getSystemInfo();
  assert.deepEqual(result, info());
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://hub.example.com/agent-api/v1/workspaces/orders/system-info');
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.body, undefined);
  assert.equal(calls[0].init.headers.Authorization, 'Bearer synthetic-agent-token');
});

test('missing metadata and unavailable runtime remain different from unloaded tools', async () => {
  const missing = { ...info(), metadata_status: 'missing', system: null, revision: null };
  assert.deepEqual(await client(async () => json(missing)).getSystemInfo(), missing);
  for (const reason of ['agent_client_disabled', 'agent_direct_disabled']) {
    const unavailable = { ...info(), availability: 'unavailable', unavailable_reason: reason };
    assert.deepEqual(await client(async () => json(unavailable)).getSystemInfo(), unavailable);
  }
});

for (const key of Object.keys(binding)) {
  test(`system info rejects response identity substitution in ${key}`, async () => {
    const raw = info();
    raw.binding[key] = 'another-binding';
    await assert.rejects(client(async () => json(raw)).getSystemInfo(),
      (error) => error.statusCode === 403 && error.publicCode === 'agent_binding_changed');
  });
}

test('system info rejects malformed descriptions and capability claims with a metadata-specific error', async () => {
  const mutations = [
    (value) => { value.system.name = 'n'.repeat(121); },
    (value) => { value.system.summary = 's'.repeat(401); },
    (value) => { value.system.domains = Array(7).fill('d'); },
    (value) => { value.system.domains = ['d'.repeat(121)]; },
    (value) => { value.system.boundaries = Array(7).fill('b'); },
    (value) => { value.system.boundaries = ['b'.repeat(161)]; },
    (value) => { value.system.summary = 'one\u0000two'; },
    (value) => { value.system.domains = [{ instruction: 'not-text' }]; },
    (value) => { value.tool_status = 'loaded'; },
    (value) => { value.availability = 'available'; },
    (value) => { value.availability = 'unavailable'; },
    (value) => { value.unavailable_reason = 'agent_direct_disabled'; },
    (value) => { value.metadata_status = 'missing'; },
    (value) => { value.revision = null; },
    (value) => { value.schema_version = 'future.v2'; },
  ];
  for (const mutate of mutations) {
    const raw = info();
    mutate(raw);
    await assert.rejects(client(async () => json(raw)).getSystemInfo(),
      (error) => error.publicCode === 'system_info_invalid');
  }
});

test('only an explicitly unknown endpoint is unsupported; route/auth/transient failures retain their meaning', async () => {
  const cases = [
    [404, 'not_found', 'system_info_unsupported', false],
    [503, 'system_info_unsupported', 'system_info_unsupported', false],
    [404, 'route_unavailable', 'route_unavailable', false],
    [404, undefined, undefined, false],
    [403, 'route_not_allowed', 'route_not_allowed', false],
    [401, undefined, undefined, false],
    [503, undefined, undefined, true],
  ];
  for (const [status, code, expected, retryable] of cases) {
    await assert.rejects(client(async () => json({ error: code }, status)).getSystemInfo(),
      (error) => error.statusCode === status && error.publicCode === expected && error.retryable === retryable);
  }
});

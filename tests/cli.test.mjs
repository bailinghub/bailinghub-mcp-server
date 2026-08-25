import assert from 'node:assert/strict';
import test from 'node:test';

import { runCli } from '../dist/cli.js';
import { MemoryCredentialStore } from '../dist/credential-store.js';
import { loadRuntimeConfig } from '../dist/runtime-config.js';

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const CREDENTIALS = {
  schema_version: 1,
  base_url: 'https://hub.example.com',
  client_app_id: 'digital-cloud-agent',
  route: 'orders',
  session_id: 'session-1',
  access_token: 'access-secret',
  refresh_token: 'refresh-secret',
  access_expires_at: '2099-08-25T01:00:00.000Z',
  refresh_expires_at: '2099-09-25T00:00:00.000Z',
};

test('runtime preserves legacy Client Token precedence and otherwise loads Agent mode', async () => {
  assert.deepEqual(
    await loadRuntimeConfig({
      BAILINGHUB_BASE_URL: 'https://hub.example.com',
      BAILINGHUB_CLIENT_TOKEN: 'legacy-client-token',
      BAILINGHUB_ROUTE: 'orders',
    }),
    {
      baseUrl: 'https://hub.example.com',
      clientToken: 'legacy-client-token',
      route: 'orders',
    },
  );

  const runtime = await loadRuntimeConfig({}, new MemoryCredentialStore(CREDENTIALS));
  assert.equal(runtime.mode, 'agent');
  assert.equal(runtime.baseUrl, 'https://hub.example.com');
  assert.equal(runtime.route, 'orders');
  assert.equal(runtime.clientAppId, 'digital-cloud-agent');
  assert.equal('clientToken' in runtime, false);
});
test('status reports safe session metadata and never prints stored tokens', async () => {
  const output = [];
  const store = new MemoryCredentialStore(CREDENTIALS);
  const handled = await runCli(['status'], {
    store,
    stdout: (value) => output.push(value),
    fetchImpl: async (url, init) => {
      assert.equal(String(url), 'https://hub.example.com/agent-auth/v1/session');
      assert.equal(init.headers.Authorization, 'Bearer access-secret');
      return jsonResponse({
        session_id: 'session-1',
        client_app_id: 'digital-cloud-agent',
        device_label: 'My Mac',
        principal: { id: 'admin-1', tenant: 'tenant-1' },
        on_behalf_of: 'digital-cloud:tenant-1:admin-1',
        allowed_routes: ['orders'],
        created_at: '2026-08-25T00:00:00.000Z',
        expires_at: '2099-08-25T01:00:00.000Z',
        refresh_expires_at: '2099-09-25T00:00:00.000Z',
      });
    },
  });
  assert.equal(handled, true);
  assert.equal(output.length, 1);
  assert.equal(output[0].includes('access-secret'), false);
  assert.equal(output[0].includes('refresh-secret'), false);
  assert.equal(JSON.parse(output[0]).route, 'orders');
});

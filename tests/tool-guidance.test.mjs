import assert from 'node:assert/strict';
import test from 'node:test';
import { BailingHubAgentClient } from '../dist/agent-client.js';

const revision = 'a'.repeat(64);
const tool = { name: 'page_save', description: 'Save a page.', scope: 'pages.write', risk: 'high',
  input_schema: { type: 'object', properties: {} }, approval_required: true, readonly: false, idempotent: false,
  description_truncated: false, usage_guidance_available: true };
const connection = { baseUrl: 'https://hub.example.com', clientAppId: 'example-client', workspace: 'pages',
  sessionId: 'test-session', accessTokenProvider: { getAccessToken: async () => 'synthetic-token' } };
function detail(text = '必须绑定页面设置；冲突时停止。') {
  return { schema_version: 'bailing.agent-tool-detail.v1', route: 'pages', capability_revision: revision,
    tool, usage_guidance: { text, truncated: false, source_chars: [...text].length,
      source_bytes: Buffer.byteLength(text), max_chars: 32768, max_bytes: 65536 } };
}
function clientFor(body, calls = []) {
  return new BailingHubAgentClient(connection, { fetchImpl: async (url, init) => {
    calls.push({ url: String(url), method: init.method, body: init.body });
    return new Response(JSON.stringify(body), { status: 200 });
  } });
}

test('tool details are one authorized revision-bound GET, preserving machine fields and Unicode guidance', async () => {
  const calls = [];
  const body = detail('绑定页面设置😀；冲突时停止。');
  body.private_spec = 'must not project';
  body.usage_guidance.credentials = 'must not project';
  const result = await clientFor(body, calls).getToolDetail({ name: 'page_save', capabilityRevision: revision });
  assert.equal(calls.length, 1);
  const url = new URL(calls[0].url);
  assert.equal(url.pathname, '/agent-api/v1/tools/page_save');
  assert.equal(url.searchParams.get('route'), 'pages');
  assert.equal(url.searchParams.get('capability_revision'), revision);
  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[0].body, undefined);
  assert.equal(result.tool.approval_required, true);
  assert.equal(result.tool.usage_guidance_available, true);
  assert.equal(result.usage_guidance.text, body.usage_guidance.text);
  assert.equal(Object.hasOwn(result, 'private_spec'), false);
  assert.equal(Object.hasOwn(result.usage_guidance, 'credentials'), false);
});

test('tool detail reads reject changed bindings and malformed or dishonest length metadata', async () => {
  const mutations = [
    body => { body.route = 'another'; },
    body => { body.capability_revision = 'b'.repeat(64); },
    body => { body.tool = { ...body.tool, name: 'another' }; },
    body => { body.usage_guidance.source_bytes -= 1; },
    body => { body.usage_guidance.truncated = true; },
    body => { body.usage_guidance.max_bytes = 999999999; },
    body => { body.usage_guidance.text = '中'.repeat(22000); body.usage_guidance.source_chars = 22000; body.usage_guidance.source_bytes = 66000; },
  ];
  for (const mutate of mutations) {
    const body = detail(); mutate(body);
    await assert.rejects(clientFor(body).getToolDetail({ name: 'page_save', capabilityRevision: revision }),
      error => error.publicCode === 'agent_invalid_response' && error.feedback.dispatch === 'not_dispatched');
  }
});

test('bounded guidance can be explicitly truncated; invalid selectors make no request', async () => {
  const body = detail('中'.repeat(21845));
  body.usage_guidance.truncated = true;
  body.usage_guidance.source_chars = 22000;
  body.usage_guidance.source_bytes = 66000;
  const result = await clientFor(body).getToolDetail({ name: 'page_save', capabilityRevision: revision });
  assert.equal(result.usage_guidance.truncated, true);
  const calls = [];
  const client = clientFor(detail(), calls);
  for (const input of [{ name: '../other', capabilityRevision: revision }, { name: 'page_save', capabilityRevision: 'old' }]) {
    await assert.rejects(client.getToolDetail(input));
  }
  assert.equal(calls.length, 0);
});

test('old Core missing the detail route is unsupported and never retries a business call', async () => {
  let calls = 0;
  const client = new BailingHubAgentClient(connection, { fetchImpl: async () => { calls++;
    return new Response('{}', { status: 404 });
  } });
  await assert.rejects(client.getToolDetail({ name: 'page_save', capabilityRevision: revision }),
    error => error.publicCode === 'agent_schema_unsupported' && error.feedback.dispatch === 'not_dispatched');
  assert.equal(calls, 1);
});

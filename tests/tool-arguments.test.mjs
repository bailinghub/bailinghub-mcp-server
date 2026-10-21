import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import test from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { BailingHubAgentClient } from '../dist/agent-client.js';
import {
  BailingHubClient, BailingHubClientError, BailingHubToolArgumentsError, CLIENT_API_LIMITS,
} from '../dist/client.js';
import { createBailingHubMcpServer, initializeBailingHubMcpServer } from '../dist/server.js';

const LIMIT = 1_048_576;
const RUN_ID = '22222222-2222-4222-8222-222222222222';
const REVISION = 'a'.repeat(64);
const INVOCATION_ID = 'b'.repeat(64);
const connection = {
  baseUrl: 'https://hub.example.com', clientAppId: 'payload-test', workspace: 'shop',
  sessionId: 'synthetic-session',
  accessTokenProvider: { getAccessToken: async () => 'synthetic-test-token' },
};
const config = { ...connection, mode: 'agent', route: 'shop' };
const byteLength = (value) => Buffer.byteLength(JSON.stringify(value), 'utf8');
const invocation = (argumentsValue) => ({
  invocationId: INVOCATION_ID, capabilityRevision: REVISION, agentRunId: RUN_ID,
  tool: 'shop_ai_decoration_validate', arguments: argumentsValue,
});
const result = (body) => ({
  schema_version: 'bailing.agent-tool-invocation.v1', invocation_id: body.invocation_id,
  route: body.route, tool: body.tool, state: 'executed', ok: true,
  auto_retry_allowed: false, business_status: 200, text: 'Synthetic page validated; no draft saved.',
});
const jsonResponse = (value, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { 'content-type': 'application/json' },
});
function argumentsAtBytes(bytes, content = '') {
  const value = { source: { html: content, css: '' } };
  const padding = bytes - byteLength(value);
  assert.ok(padding >= 0);
  value.source.html += 'x'.repeat(padding);
  assert.equal(byteLength(value), bytes);
  return value;
}
const clientFactories = {
  'Agent Client v1': (fetchImpl) => {
    const client = new BailingHubAgentClient(connection, { fetchImpl });
    return (value) => client.invoke(invocation(value));
  },
  'legacy Agent client': (fetchImpl) => {
    const client = new BailingHubClient(config, fetchImpl);
    return (value) => client.invokeAgentTool(invocation(value));
  },
};

for (const [name, factory] of Object.entries(clientFactories)) {
  test(`${name} sends bounded HTML/CSS objects through the complete JSON HTTP envelope`, async () => {
    assert.equal(CLIENT_API_LIMITS.toolArgumentsBytes, LIMIT);
    const calls = [];
    const invoke = factory(async (_url, init) => {
      const body = JSON.parse(init.body);
      calls.push({ body, bytes: Buffer.byteLength(init.body), headers: init.headers });
      return jsonResponse(result(body));
    });
    for (const bytes of [4395, 5183, 16 * 1024, 64 * 1024, 256 * 1024, LIMIT]) {
      const value = argumentsAtBytes(bytes);
      assert.equal((await invoke(value)).ok, true);
      const sent = calls.at(-1);
      assert.deepEqual(sent.body.arguments, value);
      assert.equal(typeof sent.body.arguments.source, 'object');
      assert.equal(byteLength(sent.body.arguments), bytes);
      assert.ok(sent.bytes > bytes && sent.bytes < 2 * LIMIT);
      assert.equal(sent.headers.Authorization, 'Bearer synthetic-test-token');
      assert.equal(sent.body.invocation_id, INVOCATION_ID);
      assert.equal(sent.body.capability_revision, REVISION);
      assert.equal(sent.body.agent_run_id, RUN_ID);
    }
  });

  test(`${name} rejects exact limit plus one before network work`, async () => {
    let calls = 0;
    const invoke = factory(async () => { calls += 1; throw new Error('must not fetch'); });
    await assert.rejects(invoke(argumentsAtBytes(LIMIT + 1)), (error) => {
      assert.ok(error instanceof BailingHubClientError);
      assert.ok(error instanceof BailingHubToolArgumentsError);
      assert.equal(error.statusCode, 413);
      assert.equal(error.publicCode, 'arguments_too_large');
      assert.equal(error.dispatch, 'not_dispatched');
      assert.equal(error.origin, 'client');
      assert.equal(error.limitScope, 'arguments');
      assert.equal(error.actualBytes, LIMIT + 1);
      assert.equal(error.maxBytes, LIMIT);
      assert.equal(error.disposition, 'definitive_rejection');
      assert.equal(error.retryable, false);
      assert.ok(error.message.length < 200);
      assert.equal(JSON.stringify(error).includes('source'), false);
      return true;
    });
    assert.equal(calls, 0);
  });

  test(`${name} counts Chinese, emoji, quotes and backslashes after JSON serialization`, async () => {
    const content = '中文😀"\\'.repeat(60_000);
    const value = argumentsAtBytes(LIMIT, content);
    assert.ok(value.source.html.length < LIMIT);
    let calls = 0;
    const invoke = factory(async (_url, init) => {
      calls += 1;
      const body = JSON.parse(init.body);
      assert.equal(byteLength(body.arguments), LIMIT);
      assert.equal(body.arguments.source.html, value.source.html);
      return jsonResponse(result(body));
    });
    await invoke(value);
    value.source.html += 'x';
    await assert.rejects(invoke(value), (error) => error.actualBytes === LIMIT + 1);
    assert.equal(calls, 1);
  });

  test(`${name} snapshots JSON once so changing toJSON cannot evade the byte gate`, async () => {
    let serializations = 0;
    const value = { toJSON() {
      serializations += 1;
      return serializations === 1 ? argumentsAtBytes(5183) : argumentsAtBytes(LIMIT + 1);
    } };
    const invoke = factory(async (_url, init) => {
      const body = JSON.parse(init.body);
      assert.equal(byteLength(body.arguments), 5183);
      return jsonResponse(result(body));
    });
    await invoke(value);
    assert.equal(serializations, 1);
  });

  test(`${name} rejects non-JSON or non-object inputs without exposing their content`, async () => {
    let calls = 0;
    const invoke = factory(async () => { calls += 1; throw new Error('must not fetch'); });
    const circular = {}; circular.self = circular;
    for (const value of [null, [], 'not-an-object', { sensitive: 1n }, circular, { toJSON: () => [] }]) {
      await assert.rejects(invoke(value), /object|JSON serializable/);
    }
    assert.equal(calls, 0);
  });

  test(`${name} retains only scalar Core size evidence and supports old errors`, async () => {
    const cases = [
      { response: { error: 'arguments_too_large', origin: 'core', dispatch: 'not_dispatched',
        limit_scope: 'arguments', actual_bytes: 5183, max_bytes: 4096,
        arguments: { credential: 'never-expose-private-source' }, message: 'never-expose-private-source' },
        expected: { origin: 'core', dispatch: 'not_dispatched', limitScope: 'arguments', actualBytes: 5183, maxBytes: 4096 } },
      { response: { error: 'arguments_too_large', origin: 'core', dispatch: 'not_dispatched',
        limit_scope: 'request_body', observed_bytes: 2 * LIMIT + 1, max_bytes: 2 * LIMIT },
        expected: { origin: 'core', dispatch: 'not_dispatched', limitScope: 'request_body', observedBytes: 2 * LIMIT + 1, maxBytes: 2 * LIMIT } },
      { response: { error: 'arguments_too_large' }, expected: {} },
      { response: { error: 'arguments_too_large', origin: 'untrusted-value', dispatch: 'executed',
        limit_scope: 'private-value', actual_bytes: -1, max_bytes: '4096', observed_bytes: 1.5 }, expected: {} },
      { response: { error: 'route_not_allowed', origin: 'core', dispatch: 'not_dispatched', actual_bytes: 10 }, expected: {} },
    ];
    for (const { response, expected } of cases) {
      const invoke = factory(async () => jsonResponse(response, 413));
      await assert.rejects(invoke({ source: { html: '<p>synthetic</p>', css: '' } }), (error) => {
        assert.ok(error instanceof BailingHubClientError);
        assert.deepEqual(error.details, expected);
        assert.equal(error.publicCode, response.error);
        assert.equal(error.disposition, 'definitive_rejection');
        assert.equal(JSON.stringify(error).includes('never-expose-private-source'), false);
        assert.equal(error.message.includes('never-expose-private-source'), false);
        return true;
      });
    }
  });
}

// HTTP and MCP transports are real here; the Hub/business behavior is a read-only test double.
// The separate Core seam test must exercise the actual Core dispatcher and ACC validation.
test('typed and generic MCP tools preserve large objects over HTTP and reject overflow locally', async (t) => {
  const calls = [];
  let coreSizeError = false;
  const activeTool = {
    name: 'shop_ai_decoration_validate', description: 'Validate a synthetic page without saving.',
    input_schema: { type: 'object', properties: { source: { type: 'object',
      properties: { html: { type: 'string' }, css: { type: 'string' } },
      required: ['html', 'css'], additionalProperties: false } },
      required: ['source'], additionalProperties: false },
    scope: 'shop.decoration.validate', risk: 'low', approval_required: false, readonly: true, idempotent: true,
  };
  const profile = {
    schema_version: 'bailing.agent-runtime-profile.v1', workspace: { route: 'shop', name: 'Shop' },
    profile: { revision: 'f'.repeat(64), instructions: 'Validate only.', governance: {} },
    capabilities: { revision: REVISION, authorized_total: 1, active_limit: 12, active_tools: [] },
  };
  const http = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const raw = Buffer.concat(chunks);
    const body = raw.length ? JSON.parse(raw.toString('utf8')) : undefined;
    let responseBody;
    if (request.url.endsWith('/bootstrap')) responseBody = profile;
    else if (request.url.endsWith('/turns')) responseBody = {
      schema_version: 'bailing.agent-turn-context.v1', run_id: RUN_ID,
      profile_revision: 'f'.repeat(64), capability_revision: REVISION,
      context: { instructions: 'Validate only.', page_context: {}, renderers: [],
        memory: null, memory_refs: [], knowledge: [], knowledge_refs: [], governance: {} },
      active_tools: [activeTool],
    };
    else if (request.url === '/agent-api/v1/tool-invocations') {
      assert.ok(raw.length <= 2 * LIMIT);
      assert.ok(byteLength(body.arguments) <= LIMIT);
      assert.equal(typeof body.arguments.source, 'object');
      calls.push({ body, authorization: request.headers.authorization });
      if (coreSizeError) {
        response.writeHead(413, { 'content-type': 'application/json' });
        response.end(JSON.stringify({
          error: 'arguments_too_large', origin: 'core', dispatch: 'not_dispatched',
          limit_scope: 'arguments', actual_bytes: 5183, max_bytes: 4096,
          message: 'never-expose-private-source', arguments: body.arguments,
        }));
        return;
      }
      responseBody = result(body);
    } else { response.writeHead(404); response.end('{}'); return; }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(responseBody));
  });
  http.listen(0, '127.0.0.1'); await once(http, 'listening');
  t.after(() => new Promise((resolve) => http.close(resolve)));
  const baseUrl = `http://127.0.0.1:${http.address().port}`;
  const mcpConfig = { ...config, baseUrl, allowInsecureHttp: true };
  const server = createBailingHubMcpServer(mcpConfig);
  const projection = await initializeBailingHubMcpServer(server, mcpConfig, {
    agentClient: new BailingHubAgentClient({ ...connection, baseUrl }, { allowInsecureHttp: true }),
    clientConversationId: 'payload-seam',
  });
  const client = new Client({ name: 'payload-limit-seam', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  t.after(async () => { projection.close(); await client.close(); await server.close(); });
  const started = await client.callTool({ name: 'start_business_turn', arguments: { user_input: 'Validate a synthetic page.' } });
  assert.notEqual(started.isError, true);
  for (const name of ['shop_ai_decoration_validate', 'invoke_business_capability']) {
    for (const bytes of [4395, 5183, 16 * 1024, 64 * 1024, 256 * 1024, LIMIT]) {
      const value = argumentsAtBytes(bytes, '中文😀"\\');
      const input = name === 'invoke_business_capability' ? { tool: activeTool.name, arguments: value } : value;
      const response = await client.callTool({ name, arguments: input });
      assert.notEqual(response.isError, true);
      assert.equal(response.structuredContent.ok, true);
      assert.deepEqual(calls.at(-1).body.arguments, value);
      assert.equal(calls.at(-1).authorization, 'Bearer synthetic-test-token');
    }
    const before = calls.length;
    const value = argumentsAtBytes(LIMIT + 1);
    const input = name === 'invoke_business_capability' ? { tool: activeTool.name, arguments: value } : value;
    const rejected = await client.callTool({ name, arguments: input });
    assert.equal(rejected.isError, true);
    const text = rejected.content[0].text;
    const receipt = JSON.parse(text);
    assert.deepEqual(receipt, rejected.structuredContent, '0.7 text and structured feedback remain identical');
    assert.equal(receipt.feedback.code, 'arguments_too_large');
    assert.equal(receipt.feedback.origin, 'sdk');
    assert.equal(receipt.feedback.dispatch, 'not_dispatched');
    assert.equal(receipt.feedback.next_action, 'none');
    assert.deepEqual(receipt.limits, { limit_scope: 'arguments', actual_bytes: LIMIT + 1, max_bytes: LIMIT });
    assert.doesNotMatch(text, /The Hub explicitly rejected|"source"|xxxxxx/);
    assert.equal(calls.length, before);
  }
  // Typed schemas still reject invalid fields before HTTP.
  const before = calls.length;
  const invalid = await client.callTool({ name: activeTool.name, arguments: { source: 'not-an-object' } });
  assert.equal(invalid.isError, true);
  assert.equal(calls.length, before);
  // An older Core rejection keeps safe size diagnostics without replaying or exposing its body.
  coreSizeError = true;
  const coreRejected = await client.callTool({ name: activeTool.name, arguments: argumentsAtBytes(5183) });
  assert.equal(coreRejected.isError, true);
  const text = coreRejected.content[0].text;
  const receipt = JSON.parse(text);
  assert.deepEqual(receipt, coreRejected.structuredContent);
  assert.equal(receipt.feedback.origin, 'core');
  assert.equal(receipt.feedback.dispatch, 'not_dispatched');
  assert.equal(receipt.feedback.code, 'arguments_too_large');
  assert.deepEqual(receipt.limits, { limit_scope: 'arguments', actual_bytes: 5183, max_bytes: 4096 });
  assert.doesNotMatch(text, /never-expose-private-source|"source"|xxxxxx/);
  assert.equal(calls.length, before + 1);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { BailingHubAgentClient, describeAgentFailure } from '../dist/agent-client.js';
import { AgentSessionManager } from '../dist/agent-auth.js';
import { BailingHubClientError } from '../dist/client.js';
import { createAgentClientTransport } from '../dist/sdk.js';
import { createBailingHubMcpServer, initializeBailingHubMcpServer } from '../dist/server.js';

const SESSION = '11111111-1111-4111-8111-111111111111';
const RUN = '22222222-2222-4222-8222-222222222222';
const INVOCATION = 'b'.repeat(64);
const REVISION = 'a'.repeat(64);
const connection = { baseUrl: 'https://hub.example.com', clientAppId: 'shop-inventory', workspace: 'inventory',
  sessionId: SESSION, accessTokenProvider: { getAccessToken: async () => 'synthetic-access' } };
const config = { mode: 'agent', baseUrl: connection.baseUrl, route: connection.workspace,
  clientAppId: connection.clientAppId, sessionId: SESSION, allowInsecureHttp: false,
  accessTokenProvider: connection.accessTokenProvider };
const json = (value, status = 200) => new Response(JSON.stringify(value), { status });
const tool = (name = 'inventory_lookup') => ({ name, description: 'Find inventory in the authorized shop.',
  input_schema: { type: 'object', properties: {} }, scope: 'inventory:read', risk: 'low',
  approval_required: false, readonly: true, idempotent: true });
const discovery = (returned, total = returned) => ({ mode: 'ranked_candidates', scope: 'current_authorization',
  returned_count: returned, authorized_total: total, matched_total: null, matched_total_exact: false, limit: 12,
  truncated: total > returned, has_more: total > returned, truncation_scope: 'authorized_catalog', pagination: 'unsupported' });
const search = (tools, details) => ({ schema: 'bailing.agent-capability-search.v1', capability_revision: REVISION,
  tools, ...(details ? { discovery: details } : {}) });
const profile = () => ({ schema: 'bailing.agent-runtime-profile.v1', workspace: { route: 'inventory', name: 'Inventory' },
  profile: { revision: REVISION, instructions: 'Use the selected shop.' }, capabilities: { revision: REVISION } });
const turn = (tools = [tool()]) => ({ schema: 'bailing.agent-turn-context.v1', run_id: RUN,
  profile_revision: REVISION, capability_revision: REVISION,
  context: { instructions: 'Use the selected shop.', page_context: {}, renderers: [], memory: null,
    memory_refs: [], knowledge: [], knowledge_refs: [], governance: {} }, active_tools: tools });
const invoked = (id = INVOCATION, state = 'executed') => ({ schema_version: 'bailing.agent-tool-invocation.v1',
  invocation_id: id, route: 'inventory', tool: 'inventory_lookup', state, ok: state === 'executed',
  auto_retry_allowed: false, text: 'Synthetic business outcome.' });
const invokeInput = { invocationId: INVOCATION, capabilityRevision: REVISION, agentRunId: RUN,
  tool: 'inventory_lookup', arguments: {} };

async function mcp(t, overrides = {}) {
  const calls = [];
  const agentClient = {
    bootstrapWorkspace: async () => profile(), startTurn: async () => turn(),
    searchCapabilities: async () => search([tool()]),
    invoke: async (input) => { calls.push(input); return invoked(input.invocationId); },
    resume: async (id) => invoked(id), completeRun: async () => ({ schema: 'bailing.agent-run-completion.v1', run_id: RUN, status: 'completed' }),
    ...overrides,
  };
  const server = createBailingHubMcpServer(config);
  const projection = await initializeBailingHubMcpServer(server, config, { agentClient });
  const host = new Client({ name: 'feedback-fixture', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), host.connect(clientTransport)]);
  t.after(async () => { projection.close(); await host.close(); await server.close(); });
  return { host, server, projection, calls };
}

test('search preserves empty, complete and bounded discovery without inventing matching totals or pages', async () => {
  for (const [returned, total] of [[0, 0], [4, 4], [12, 20]]) {
    const details = discovery(returned, total);
    const api = new BailingHubAgentClient(connection, { fetchImpl: async () => json(search(
      Array.from({ length: returned }, (_, i) => tool(`inventory_${i}`)), details)) });
    const result = await api.searchCapabilities({ query: 'inventory' });
    assert.deepEqual(result.discovery, details);
    assert.equal(result.tools.length, returned);
    assert.equal(result.discovery.matched_total, null);
    assert.equal(result.discovery.pagination, 'unsupported');
  }
});

test('older Core metadata remains absent in SDK and explicitly unknown in model results', async (t) => {
  const api = new BailingHubAgentClient(connection, { fetchImpl: async () => json(search([])) });
  assert.equal(Object.hasOwn(await api.searchCapabilities({ query: 'inventory' }), 'discovery'), false);
  const { host } = await mcp(t, { searchCapabilities: async () => search([]) });
  const result = await host.callTool({ name: 'search_business_capabilities', arguments: { query: 'inventory' } });
  assert.equal(result.structuredContent.discovery, null);
  assert.equal(result.structuredContent.toolset.active_count, 0);
  assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
});

test('invalid optional discovery becomes unknown while valid tool definitions remain usable', async () => {
  for (const details of [discovery(0), { ...discovery(1, 2), truncated: false },
    { ...discovery(1), has_more: true }, { ...discovery(1), authorized_total: -1 }]) {
    const api = new BailingHubAgentClient(connection, { fetchImpl: async () => json(search([tool()], details)) });
    const result = await api.searchCapabilities({ query: 'inventory' });
    assert.equal(Object.hasOwn(result, 'discovery'), false);
    assert.equal(result.tools.length, 1);
  }
});

test('MCP separates authorized catalog statistics from its current registered set and generation', async (t) => {
  const details = discovery(1, 20);
  const { host } = await mcp(t, { searchCapabilities: async () => search([tool()], details) });
  const first = await host.callTool({ name: 'search_business_capabilities', arguments: { query: 'inventory' } });
  const second = await host.callTool({ name: 'search_business_capabilities', arguments: { query: 'inventory' } });
  assert.deepEqual(second.structuredContent.discovery, details);
  assert.deepEqual(second.structuredContent.target, { workspace: 'inventory' });
  assert.equal(second.structuredContent.toolset.scope, 'mcp_session');
  assert.equal(second.structuredContent.toolset.update, 'replace');
  assert.equal(second.structuredContent.toolset.active_count, 1);
  assert.equal(second.structuredContent.toolset.omitted_tool_count, 0);
  assert.equal(second.structuredContent.toolset.generation, first.structuredContent.toolset.generation + 1);
});

test('real MCP dispatch classifies only this session\'s unloaded names and never invokes them', async (t) => {
  const { host, calls } = await mcp(t, { searchCapabilities: async ({ query }) => search([tool(query)]) });
  await host.callTool({ name: 'start_business_turn', arguments: { user_input: 'Check inventory.' } });
  await host.callTool({ name: 'search_business_capabilities', arguments: { query: 'stock_lookup' } });
  const stale = await host.callTool({ name: 'inventory_lookup', arguments: {} });
  assert.equal(stale.isError, true);
  assert.equal(stale.structuredContent.feedback.category, 'tool_not_loaded');
  assert.equal(stale.structuredContent.feedback.origin, 'mcp');
  assert.equal(stale.structuredContent.feedback.dispatch, 'not_dispatched');
  assert.equal(stale.structuredContent.feedback.next_action, 'rediscover');
  assert.deepEqual(JSON.parse(stale.content[0].text), stale.structuredContent);
  assert.equal(calls.length, 0);
  const neverLoaded = await host.callTool({ name: 'never_loaded', arguments: {} });
  assert.equal(neverLoaded.isError, true);
  assert.equal(neverLoaded.structuredContent, undefined);
  assert.match(neverLoaded.content[0].text, /not found/);
  await host.callTool({ name: 'search_business_capabilities', arguments: { query: 'inventory_lookup' } });
  await host.callTool({ name: 'inventory_lookup', arguments: {} });
  await host.callTool({ name: 'inventory_lookup', arguments: {} });
  assert.equal(calls.length, 2, 'A current tool is usable directly without another search.');
});

test('network, authorization, explicit incompatible schema and ordinary HTTP failures remain distinct', async () => {
  const cases = [
    [async () => { throw new TypeError('private transport detail'); }, 'transport_unavailable', 'retry_discovery'],
    [async () => json({ error: 'route_not_allowed', message: 'private authorization detail' }, 403), 'authorization_unavailable', 'reauthorize'],
    [async () => json({ schema: 'future-search', tools: [] }), 'unsupported', 'check_compatibility'],
    [async () => json({ tools: [] }), 'unknown_failure', 'none'],
    [async () => json({ error: 'private_unknown', message: 'private response' }, 404), 'unknown_failure', 'none'],
    [async () => json({ message: 'private unavailable response' }, 503), 'unknown_failure', 'none'],
  ];
  for (const [fetchImpl, category, nextAction] of cases) {
    const api = new BailingHubAgentClient(connection, { fetchImpl });
    await assert.rejects(api.searchCapabilities({ query: 'inventory' }), (error) => {
      assert.equal(error.feedback.category, category);
      assert.equal(error.feedback.next_action, nextAction);
      assert.equal(error.feedback.operation, 'search');
      assert.equal(JSON.stringify(error.feedback).includes('private'), false);
      return true;
    });
  }
});

test('token-refresh service failures stay transport failures and do not perform a business request', async () => {
  for (const outcome of ['network', 'unavailable', 'revoked', 'missing']) {
    let credentials = { schema_version: 1, base_url: connection.baseUrl, client_app_id: connection.clientAppId,
      route: connection.workspace, session_id: SESSION, access_token: 'synthetic-access', refresh_token: 'synthetic-refresh',
      access_expires_at: '2020-01-01T00:00:00.000Z', refresh_expires_at: '2099-01-01T00:00:00.000Z' };
    const paths = [];
    const fetchImpl = async (url) => {
      paths.push(new URL(String(url)).pathname);
      if (outcome === 'network') throw new TypeError('private network detail');
      return json({ message: 'private auth detail' }, outcome === 'revoked' ? 401 : outcome === 'missing' ? 404 : 503);
    };
    const manager = new AgentSessionManager({ load: async () => credentials,
      save: async (value) => { credentials = value; }, delete: async () => { credentials = undefined; } }, fetchImpl);
    const api = new BailingHubAgentClient({ ...connection, accessTokenProvider: manager }, { fetchImpl });
    await assert.rejects(api.searchCapabilities({ query: 'inventory' }), (error) => {
      assert.equal(error.feedback.category, outcome === 'revoked' ? 'authorization_unavailable'
        : outcome === 'network' ? 'transport_unavailable' : 'unknown_failure');
      assert.equal(error.feedback.dispatch, 'not_dispatched');
      if (outcome !== 'revoked') assert.notEqual(error.statusCode, 401);
      return true;
    });
    assert.deepEqual(paths, ['/agent-auth/v1/token']);
    assert.equal(Boolean(credentials), outcome !== 'revoked');
  }
});

test('MCP error text and structuredContent retain the same sanitized actionable feedback', async (t) => {
  const { host } = await mcp(t, { searchCapabilities: async () => {
    throw new BailingHubClientError('private upstream detail', 503, true, 'agent_tools_unavailable');
  } });
  const result = await host.callTool({ name: 'search_business_capabilities', arguments: { query: 'inventory' } });
  assert.equal(result.structuredContent.feedback.category, 'unknown_failure');
  assert.equal(result.structuredContent.feedback.next_action, 'none');
  assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
  assert.equal(JSON.stringify(result).includes('private'), false);
});

test('uncertain writes and failed recovery keep the original invocation and never replay the write', async () => {
  const paths = [];
  const api = new BailingHubAgentClient(connection, { fetchImpl: async (url) => {
    const path = new URL(String(url)).pathname;
    paths.push(path);
    if (path.endsWith('/resume')) return json(invoked());
    throw new TypeError('Synthetic acknowledgement lost after write.');
  } });
  await assert.rejects(api.invoke(invokeInput), (error) => {
    assert.equal(error.feedback.category, 'invocation_outcome_unknown');
    assert.equal(error.feedback.next_action, 'resume_original');
    assert.equal(error.feedback.invocation_id, INVOCATION);
    assert.equal(error.feedback.dispatch, 'attempted');
    return true;
  });
  assert.equal((await api.resume(INVOCATION)).state, 'executed');
  assert.deepEqual(paths, ['/agent-api/v1/tool-invocations', `/agent-api/v1/tool-invocations/${INVOCATION}/resume`]);
  const rejectedResume = new BailingHubAgentClient(connection, { fetchImpl: async () => json({ error: 'route_not_allowed' }, 403) });
  await assert.rejects(rejectedResume.resume(INVOCATION), (error) => {
    assert.equal(error.feedback.next_action, 'inspect_original');
    assert.equal(error.feedback.invocation_id, INVOCATION);
    assert.equal(error.feedback.retryable, false);
    return true;
  });
});

test('HTTP success with reconciliation_required carries formal feedback without changing the state', async () => {
  const api = new BailingHubAgentClient(connection, { fetchImpl: async () => json(invoked(INVOCATION, 'reconciliation_required')) });
  for (const result of [await api.invoke(invokeInput), await api.resume(INVOCATION)]) {
    assert.equal(result.state, 'reconciliation_required');
    assert.equal(result.auto_retry_allowed, false);
    assert.equal(result.feedback.category, 'invocation_outcome_unknown');
    assert.equal(result.feedback.code, 'reconciliation_required');
    assert.equal(result.feedback.next_action, 'inspect_original');
    assert.equal(result.feedback.retryable, false);
    assert.equal(result.feedback.invocation_id, INVOCATION);
  }
});

test('capability change rediscovery is distinguished from unresolved invocation recovery', () => {
  const rejected = new BailingHubClientError('private rejection', 409, false, 'capability_changed', 'refresh_required', INVOCATION);
  const feedback = describeAgentFailure(rejected, { operation: 'invoke', origin: 'core', dispatch: 'not_dispatched' });
  assert.equal(feedback.next_action, 'rediscover');
  assert.equal(feedback.category, 'capability_changed');
  assert.equal(feedback.invocation_id, INVOCATION);
  const uncertain = describeAgentFailure(rejected, { operation: 'invoke', origin: 'host', dispatch: 'unknown' });
  assert.equal(uncertain.category, 'invocation_outcome_unknown');
  assert.equal(uncertain.next_action, 'resume_original');
});

test('SDK host binding failures expose guidance and never fall back to a different default authorization', async () => {
  let requests = 0;
  const transport = createAgentClientTransport({ hubUrl: connection.baseUrl, clientAppId: connection.clientAppId, workspace: 'other' }, {
    connectionStore: { registry: { get: async () => undefined } }, fetchImpl: async () => { requests += 1; throw new Error('No request expected.'); },
  });
  const options = { connectionKey: `conn_${'1'.repeat(32)}`, workspace: 'inventory',
    expectedBinding: { hubUrl: connection.baseUrl, clientAppId: connection.clientAppId, workspace: 'inventory', sessionId: SESSION } };
  for (const action of [() => transport.searchCapabilities({ query: 'inventory' }, options), () => transport.resume(INVOCATION, {}, options)]) {
    await assert.rejects(action(), (error) => {
      assert.equal(error.feedback.category, 'authorization_unavailable');
      assert.equal(error.feedback.dispatch, 'not_dispatched');
      assert.equal(error.feedback.retryable, error.feedback.next_action === 'restore_scope');
      return true;
    });
  }
  assert.equal(requests, 0);
});


test('MCP unknown invocation failures recover the original call and never claim pre-dispatch rejection', async (t) => {
  const ids = [];
  const recovered = [];
  const { host } = await mcp(t, {
    invoke: async (input) => { ids.push(input.invocationId); throw new Error('private unexpected failure'); },
    resume: async (id) => { recovered.push(id); return invoked(id); },
  });
  await host.callTool({ name: 'start_business_turn', arguments: { user_input: 'Check inventory.' } });
  const failed = await host.callTool({ name: 'inventory_lookup', arguments: {} });
  const feedback = failed.structuredContent.feedback;
  assert.equal(feedback.category, 'invocation_outcome_unknown');
  assert.equal(feedback.dispatch, 'unknown');
  assert.equal(feedback.next_action, 'resume_original');
  assert.equal(feedback.invocation_id, ids[0]);
  assert.equal(JSON.stringify(failed).includes('private'), false);
  await host.callTool({ name: 'resume_governed_tool_invocation', arguments: { invocation_id: feedback.invocation_id } });
  assert.equal(ids.length, 1);
  assert.deepEqual(recovered, ids);
});

test('MCP carries reconciliation feedback from the real SDK normalization on an HTTP success', async (t) => {
  const api = new BailingHubAgentClient(connection, { fetchImpl: async (_url, init) => {
    const input = JSON.parse(init.body);
    return json(invoked(input.invocation_id, 'reconciliation_required'));
  } });
  const { host } = await mcp(t, { invoke: (input) => api.invoke(input) });
  await host.callTool({ name: 'start_business_turn', arguments: { user_input: 'Check inventory.' } });
  const result = await host.callTool({ name: 'inventory_lookup', arguments: {} });
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.state, 'reconciliation_required');
  assert.equal(result.structuredContent.auto_retry_allowed, false);
  assert.equal(result.structuredContent.feedback.next_action, 'inspect_original');
  assert.equal(result.structuredContent.feedback.invocation_id, result.structuredContent.invocation_id);
  assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
});


test('network recovery actions retry the original verification scope without requesting new business execution', () => {
  const error = new BailingHubClientError('Synthetic network failure.', undefined, true, 'agent_transport_unavailable');
  for (const operation of ['authorize', 'scope']) {
    const feedback = describeAgentFailure(error, { operation, origin: 'sdk', dispatch: 'not_dispatched' });
    assert.equal(feedback.next_action, 'restore_scope');
    assert.equal(feedback.retryable, true);
  }
});


test('MCP capability_changed cannot overwrite evidence of an uncertain original invocation', async (t) => {
  let bootstrapCalls = 0;
  const { host } = await mcp(t, {
    bootstrapWorkspace: async () => { bootstrapCalls += 1; return profile(); },
    invoke: async (input) => { throw new BailingHubClientError('Synthetic uncertain original call.',
      undefined, true, 'capability_changed', 'accepted_unknown', input.invocationId,
      { operation: 'invoke', origin: 'sdk', dispatch: 'unknown' }); },
  });
  await host.callTool({ name: 'start_business_turn', arguments: { user_input: 'Check inventory.' } });
  const result = await host.callTool({ name: 'inventory_lookup', arguments: {} });
  assert.equal(result.structuredContent.feedback.category, 'invocation_outcome_unknown');
  assert.equal(result.structuredContent.feedback.next_action, 'resume_original');
  assert.equal(result.structuredContent.feedback.dispatch, 'unknown');
  assert.equal(bootstrapCalls, 1, 'An uncertain invocation must not trigger catalog refresh as a substitute recovery.');
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { BailingHubAgentClient, describeAgentFailure } from '../dist/agent-client.js';
import { createBailingHubMcpServer, initializeBailingHubMcpServer } from '../dist/server.js';

const REV = 'a'.repeat(64), RUN = '22222222-2222-4222-8222-222222222222';
const connection = { baseUrl: 'https://hub.example.com', clientAppId: 'shop-app', workspace: 'shop', sessionId: '11111111-1111-4111-8111-111111111111', accessTokenProvider: { getAccessToken: async () => 'synthetic' } };
const caps = () => ({ schema_version: 'bailing.agent-knowledge-capabilities.v1', protocol: 'bailing.agent-knowledge.v1', supported: true, route: 'shop', enabled: true, knowledge_scope_revision: REV,
  delivery_modes: ['inline', 'on_demand'], limits: { search_max_results: 3, search_max_bytes: 4096, read_default_bytes: 16384, read_max_bytes: 32768, reference_ttl_seconds: 300, read_chain_max_bytes: 131072 } });
const hint = () => ({ ref: 'opaque-ref', title: 'Home page setup', summary: 'Bind the saved page to page settings.', revision: REV, score: .85, expires_at: '2099-01-01T00:00:00.000Z' });
const search = () => ({ schema_version: 'bailing.agent-knowledge-search.v1', route: 'shop', run_id: RUN, knowledge_scope_revision: REV, status: 'ok', trust: 'reference_only', hints: [hint()], truncated: false });
const read = () => ({ schema_version: 'bailing.agent-knowledge-read.v1', route: 'shop', run_id: RUN, knowledge_scope_revision: REV, ref: 'opaque-ref', revision: REV, title: 'Home page setup', content: 'Bind the page before expecting the storefront to change.', trust: 'reference_only', next_cursor: null, truncated: false });
const delivery = () => ({ schema_version: 'bailing.agent-knowledge-delivery.v1', protocol: 'bailing.agent-knowledge.v1', mode: 'on_demand', knowledge_scope_revision: REV, status: 'ok', hints: [hint()] });
const turn = () => ({ schema: 'bailing.agent-turn-context.v1', run_id: RUN, profile_revision: REV, capability_revision: REV, context: { instructions: 'Keep approvals.', page_context: {}, renderers: [], memory: null, memory_refs: [], knowledge: [], knowledge_refs: [], governance: { approvals: true } }, active_tools: [] });
const input = { clientConversationId: 'conversation', clientTurnId: 'turn', userMessageId: 'message', userInput: 'How does this work?' };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
const api = fetchImpl => new BailingHubAgentClient(connection, { fetchImpl });

test('knowledge protocol is explicitly negotiated; old endpoints preserve inline while errors and future schema do not pretend support', async () => {
  assert.deepEqual(await api(async () => json(caps())).getKnowledgeCapabilities(), caps());
  for (const status of [404, 405, 501]) assert.equal((await api(async () => json({}, status)).getKnowledgeCapabilities()).supported, false);
  for (const status of [401, 403, 503]) await assert.rejects(api(async () => json({}, status)).getKnowledgeCapabilities(), { statusCode: status });
  await assert.rejects(api(async () => json({ ...caps(), schema_version: 'future' })).getKnowledgeCapabilities(), { publicCode: 'agent_invalid_response' });
});
test('SDK search and read preserve exact original route/run and separate full body from hints', async () => {
  const calls = [], client = api(async (url, init) => { calls.push({ path: new URL(url).pathname, body: JSON.parse(init.body) }); return json(calls.length === 1 ? search() : read()); });
  const result = await client.searchKnowledge({ query: 'homepage', runId: RUN });
  assert.deepEqual(result.hints, [hint()]); assert.equal(Object.hasOwn(result.hints[0], 'content'), false);
  assert.equal((await client.readKnowledge({ ref: result.hints[0].ref, runId: RUN })).content, read().content);
  assert.deepEqual(calls, [{ path: '/agent-api/v1/workspaces/shop/knowledge/search', body: { query: 'homepage', limit: 3, run_id: RUN } }, { path: '/agent-api/v1/workspaces/shop/knowledge/read', body: { ref: 'opaque-ref', run_id: RUN } }]);
});
for (const [field, bad] of [['route', 'other'], ['run_id', '33333333-3333-4333-8333-333333333333'], ['schema_version', 'future'], ['trust', 'instructions'], ['knowledge_scope_revision', 'old']]) test(`knowledge search rejects mismatched ${field}`, async () => {
  await assert.rejects(api(async () => json({ ...search(), [field]: bad })).searchKnowledge({ query: 'policy', runId: RUN }), { publicCode: 'agent_invalid_response' });
});
test('search/read count UTF-8 serialized JSON bytes and bound references, queries and pages before dispatch', async () => {
  let calls = 0; const client = api(async () => { calls++; return json(read()); });
  for (const bad of [{ ref: 'x'.repeat(4097) }, { ref: 'opaque-ref', maxBytes: 32769 }, { ref: 'opaque-ref', cursor: '中'.repeat(2000) }]) await assert.rejects(client.readKnowledge(bad));
  for (const bad of [{ query: '', limit: 1 }, { query: 'policy', limit: 4 }, { query: 'x', runId: 'invalid' }]) await assert.rejects(client.searchKnowledge(bad));
  assert.equal(calls, 0);
  await assert.rejects(api(async () => json({ ...search(), hints: [{ ...hint(), summary: '中'.repeat(1200) }] })).searchKnowledge({ query: 'policy', runId: RUN }), { publicCode: 'agent_invalid_response' });
  await assert.rejects(api(async () => json({ ...read(), content: '中'.repeat(5500) })).readKnowledge({ ref: 'opaque-ref', runId: RUN }), { publicCode: 'agent_invalid_response' });
});
test('read pagination and budget exhaustion remain explicitly incomplete and stale refs advise knowledge search only', async () => {
  const page = { ...read(), truncated: true, next_cursor: 'next-page' };
  assert.deepEqual(await api(async () => json(page)).readKnowledge({ ref: 'opaque-ref', runId: RUN }), page);
  const exhausted = { ...read(), truncated: true, budget_exhausted: true, total_content_bytes: 262144, read_chain_max_bytes: 131072 };
  assert.deepEqual(await api(async () => json(exhausted)).readKnowledge({ ref: 'opaque-ref', runId: RUN }), exhausted);
  await assert.rejects(api(async () => json({ ...read(), truncated: true })).readKnowledge({ ref: 'opaque-ref', runId: RUN }));
  for (const patch of [{ truncated: false }, { next_cursor: 'next-page' }, { read_chain_max_bytes: 131073 }, { total_content_bytes: -1 }, { total_content_bytes: 131072 }, { total_content_bytes: Number.MAX_SAFE_INTEGER + 1 }]) {
    await assert.rejects(api(async () => json({ ...exhausted, ...patch })).readKnowledge({ ref: 'opaque-ref', runId: RUN }));
  }
  const unicodeTitle = { ...read(), title: '😀'.repeat(300) };
  assert.deepEqual(await api(async () => json(unicodeTitle)).readKnowledge({ ref: 'opaque-ref', runId: RUN }), unicodeTitle);
  for (const code of ['knowledge_reference_invalid', 'knowledge_reference_expired', 'knowledge_changed', 'knowledge_scope_changed']) await assert.rejects(api(async () => json({ error: code }, 409)).readKnowledge({ ref: 'opaque-ref', runId: RUN }), error => {
    assert.equal(error.publicCode, code); assert.equal(describeAgentFailure(error, { operation: 'search', dispatch: 'not_dispatched' }).next_action, 'search_knowledge'); return true;
  });
});
test('only trusted options request on-demand delivery; legacy body is retained and no unrequested mode can erase knowledge', async () => {
  const calls = []; const client = api(async (_url, init) => { calls.push(JSON.parse(init.body)); return json({ ...turn(), context: { ...turn().context, knowledge_delivery: delivery() } }); });
  await assert.rejects(client.startTurn({ ...input, knowledge_delivery: 'on_demand' }));
  const result = await client.startTurn(input, { knowledgeDelivery: 'on_demand' });
  assert.equal(calls[0].knowledge_delivery, 'on_demand'); assert.deepEqual(result.context.knowledge_delivery, delivery());
  await assert.rejects(client.startTurn(input), { publicCode: 'agent_invalid_response' });
  const old = { ...turn(), context: { ...turn().context, knowledge: [{ content: 'Keep the entire old inline body.' }] } };
  assert.deepEqual((await api(async () => json(old)).startTurn(input)).context.knowledge, old.context.knowledge);
});
test('MCP exposes knowledge-only search/read without discovering or invoking a business tool', async t => {
  const calls = [], config = { mode: 'agent', ...connection, route: 'shop', allowInsecureHttp: false };
  const agentClient = { bootstrapWorkspace: async () => ({ schema: 'bailing.agent-runtime-profile.v1', workspace: { route: 'shop', name: 'Shop' }, profile: { revision: REV, instructions: '' }, capabilities: { revision: REV } }),
    getKnowledgeCapabilities: async () => caps(), searchKnowledge: async value => { calls.push(['search', value]); return search(); }, readKnowledge: async value => { calls.push(['read', value]); return read(); },
    startTurn: async (_input, options) => { assert.equal(options.knowledgeDelivery, 'on_demand'); return { ...turn(), context: { ...turn().context, knowledge_delivery: delivery() } }; },
    searchCapabilities: async () => { throw new Error('No business discovery'); }, invoke: async () => { throw new Error('No business invoke'); }, resume: async () => {}, completeRun: async () => {} };
  const server = createBailingHubMcpServer(config), projection = await initializeBailingHubMcpServer(server, config, { agentClient });
  const host = new Client({ name: 'knowledge-test', version: '1' }), [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([host.connect(a), server.connect(b)]); t.after(async () => { projection.close(); await host.close(); await server.close(); });
  await host.callTool({ name: 'start_business_turn', arguments: { user_input: 'How do pages work?' } });
  const found = await host.callTool({ name: 'search_business_knowledge', arguments: { query: 'homepage' } });
  assert.equal(found.structuredContent.business_operation_performed, false);
  assert.equal(found.structuredContent.hints[0].ref, 'opaque-ref');
  const page = await host.callTool({ name: 'read_business_knowledge', arguments: { ref: 'opaque-ref' } });
  assert.equal(page.structuredContent.content, read().content); assert.equal(calls.length, 2);
});

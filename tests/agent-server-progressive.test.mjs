import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { BailingHubClientError } from '../dist/client.js';
import {
  createAgentTurnMessageIds,
  createBailingHubMcpServer,
  initializeBailingHubMcpServer,
} from '../dist/server.js';

const AGENT_CONFIG = {
  mode: 'agent',
  baseUrl: 'https://hub.example.com',
  route: 'orders',
  clientAppId: 'example-agent-client',
  sessionId: 'session-1',
  allowInsecureHttp: false,
  accessTokenProvider: { getAccessToken: async () => 'never-print-this-token' },
};
const RUN_ID = '22222222-2222-4222-8222-222222222222';
const CAPABILITY_REVISION = 'a'.repeat(64);
const NEXT_REVISION = 'c'.repeat(64);
const INVOCATION_ID = 'b'.repeat(64);
const META_TOOLS = [
  'complete_business_run',
  'invoke_business_capability',
  'resume_governed_tool_invocation',
  'search_business_capabilities',
  'start_business_turn',
];

function tool(name = 'employee_search', overrides = {}) {
  return {
    name,
    description: `Use ${name} for the authorized tenant.`,
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1 },
        nickname: { type: 'string', nullable: true },
      },
      required: ['query'],
      additionalProperties: false,
    },
    scope: `${name}:read`,
    risk: 'low',
    approval_required: false,
    readonly: true,
    idempotent: true,
    ...overrides,
  };
}

function profile(overrides = {}) {
  return {
    schema: 'bailing.agent-runtime-profile.v1',
    workspace: { route: 'orders', name: 'Orders' },
    profile: {
      revision: 'f'.repeat(64),
      instructions: 'Use only authorized capabilities.',
      knowledge: { enabled: true },
      memory: { recent_messages: 5 },
      governance: { planner: 'local_agent' },
    },
    capabilities: {
      revision: CAPABILITY_REVISION,
      active_tools: [],
      authorized_total: 20,
      active_limit: 12,
    },
    ...overrides,
  };
}

function turn(activeTools = [tool()]) {
  return {
    schema: 'bailing.agent-turn-context.v1',
    run_id: RUN_ID,
    profile_revision: 'f'.repeat(64),
    capability_revision: CAPABILITY_REVISION,
    context: {
      instructions: 'Use only authorized capabilities.',
      page_context: {},
      renderers: [],
      memory: { recent: [] },
      memory_refs: [],
      knowledge: [],
      knowledge_refs: [],
      governance: { planner: 'local_agent' },
    },
    active_tools: activeTools,
  };
}

async function connect(server, name) {
  const client = new Client({ name, version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

test('Agent MCP starts with bounded meta tools and no full business catalog', async (t) => {
  let bootstrapCalls = 0;
  const server = createBailingHubMcpServer(AGENT_CONFIG);
  const projection = await initializeBailingHubMcpServer(server, AGENT_CONFIG, {
    agentClient: {
      async bootstrapWorkspace() { bootstrapCalls += 1; return profile(); },
      async startTurn() { return turn(); },
      async searchCapabilities() { throw new Error('not used'); },
      async invoke() { throw new Error('not used'); },
      async resume() { throw new Error('not used'); },
      async completeRun() { throw new Error('not used'); },
    },
    clientConversationId: 'conversation-1',
  });
  const client = await connect(server, 'progressive-initial');
  t.after(async () => { projection.close(); await client.close(); await server.close(); });

  const listed = await client.listTools();
  assert.deepEqual(listed.tools.map((entry) => entry.name).sort(), META_TOOLS);
  assert.equal(bootstrapCalls, 1);
  assert.deepEqual(projection.activeToolNames(), []);
  const start = listed.tools.find((entry) => entry.name === 'start_business_turn');
  assert.equal(start.annotations.idempotentHint, true);
  assert.equal(start.inputSchema.properties.user_input.maxLength, 64_000);
  assert.equal(start.inputSchema.properties.renderers.maxItems, 20);
  const complete = listed.tools.find((entry) => entry.name === 'complete_business_run');
  assert.equal(complete.inputSchema.properties.content.maxLength, 64_000);
  assert.equal(complete.inputSchema.properties.model.maxLength, 191);
  assert.equal(complete.inputSchema.properties.usage.additionalProperties, false);
});

test('turn and search replace the active set while typed and generic invocation stay governed', async (t) => {
  const calls = [];
  const server = createBailingHubMcpServer(AGENT_CONFIG);
  const projection = await initializeBailingHubMcpServer(server, AGENT_CONFIG, {
    agentClient: {
      async bootstrapWorkspace() { return profile(); },
      async startTurn(input) { calls.push({ kind: 'turn', input }); return turn(); },
      async searchCapabilities(input) {
        calls.push({ kind: 'search', input });
        return {
          schema: 'bailing.agent-capability-search.v1',
          capability_revision: NEXT_REVISION,
          tools: [tool('order_lookup')],
        };
      },
      async invoke(input) {
        calls.push({ kind: 'invoke', input });
        return {
          schema_version: 'bailing.agent-tool-invocation.v1',
          invocation_id: input.invocationId,
          route: 'orders',
          tool: input.tool,
          state: 'executed',
          ok: true,
          auto_retry_allowed: false,
          text: 'done',
        };
      },
      async resume(invocationId) {
        calls.push({ kind: 'resume', invocationId });
        return {
          schema_version: 'bailing.agent-tool-invocation.v1', invocation_id: invocationId,
          route: 'orders', tool: 'order_lookup', state: 'executed', ok: true,
          auto_retry_allowed: false, text: 'done',
        };
      },
      async completeRun() { throw new Error('not used'); },
    },
    clientConversationId: 'conversation-1',
  });
  const client = await connect(server, 'progressive-replacement');
  t.after(async () => { projection.close(); await client.close(); await server.close(); });

  const started = await client.callTool({
    name: 'start_business_turn',
    arguments: { user_input: 'Find Alice\nthen show her team', renderers: ['bailing-form.v1'] },
  });
  assert.equal(started.isError, undefined);
  assert.match(calls[0].input.clientTurnId, /^mcp_turn:[a-f0-9]{64}$/);
  assert.match(calls[0].input.userMessageId, /^mcp_user:[a-f0-9]{64}$/);
  let listed = await client.listTools();
  assert.equal(listed.tools.some((entry) => entry.name === 'employee_search'), true);
  const employee = listed.tools.find((entry) => entry.name === 'employee_search');
  assert.match(employee.description, /^Use employee_search for the authorized tenant\./);
  assert.match(employee.description, /Use this tool directly while it is currently listed/);
  assert.equal(JSON.stringify(employee.inputSchema).includes('nullable'), false);
  assert.equal(JSON.stringify(employee.inputSchema).includes('"null"'), true);

  const invoked = await client.callTool({
    name: 'employee_search', arguments: { query: 'Alice', nickname: null },
  });
  assert.equal(invoked.structuredContent.state, 'executed');
  assert.match(calls.at(-1).input.invocationId, /^[a-f0-9]{64}$/);

  await client.callTool({
    name: 'search_business_capabilities', arguments: { query: 'order 42', limit: 8 },
  });
  listed = await client.listTools();
  assert.equal(listed.tools.some((entry) => entry.name === 'employee_search'), false);
  assert.equal(listed.tools.some((entry) => entry.name === 'order_lookup'), true);
  assert.deepEqual(projection.activeToolNames(), ['order_lookup']);

  await client.callTool({
    name: 'invoke_business_capability',
    arguments: { tool: 'order_lookup', arguments: { query: '42' } },
  });
  assert.equal(calls.at(-1).input.capabilityRevision, NEXT_REVISION);
  const resumed = await client.callTool({
    name: 'resume_governed_tool_invocation', arguments: { invocation_id: INVOCATION_ID },
  });
  assert.equal(resumed.structuredContent.invocation_id, INVOCATION_ID);
});

test('capability search falls back to the active run and fails closed without query or run', async (t) => {
  const searches = [];
  const server = createBailingHubMcpServer(AGENT_CONFIG);
  const projection = await initializeBailingHubMcpServer(server, AGENT_CONFIG, {
    agentClient: {
      async bootstrapWorkspace() { return profile(); },
      async startTurn() { return turn([]); },
      async searchCapabilities(input) {
        searches.push(input);
        return {
          schema: 'bailing.agent-capability-search.v1',
          capability_revision: NEXT_REVISION,
          tools: [],
        };
      },
      async invoke() { throw new Error('not used'); },
      async resume() { throw new Error('not used'); },
      async completeRun() { throw new Error('not used'); },
    },
    clientConversationId: 'conversation-search-fallback',
  });
  const client = await connect(server, 'progressive-search-fallback');
  t.after(async () => { projection.close(); await client.close(); await server.close(); });

  const missingWithoutRun = await client.callTool({
    name: 'search_business_capabilities', arguments: {},
  });
  const blankWithoutRun = await client.callTool({
    name: 'search_business_capabilities', arguments: { query: ' \n\t ' },
  });
  assert.equal(missingWithoutRun.isError, true);
  assert.equal(blankWithoutRun.isError, true);
  assert.equal(searches.length, 0);

  await client.callTool({
    name: 'start_business_turn', arguments: { user_input: 'Find the employee from this turn' },
  });
  const missingWithRun = await client.callTool({
    name: 'search_business_capabilities', arguments: {},
  });
  const blankWithRun = await client.callTool({
    name: 'search_business_capabilities', arguments: { query: ' \n\t ' },
  });
  assert.equal(missingWithRun.isError, undefined);
  assert.equal(blankWithRun.isError, undefined);
  assert.deepEqual(searches, [
    { limit: 12, runId: RUN_ID },
    { limit: 12, runId: RUN_ID },
  ]);
});

test('turn identity is deterministic for an exact MCP replay and changes with payload or request id', () => {
  const visible = { user_input: 'hello', page_context: null, renderers: [] };
  const first = createAgentTurnMessageIds('session-1', 'conversation-1', 17, visible);
  assert.deepEqual(first, createAgentTurnMessageIds('session-1', 'conversation-1', 17, visible));
  assert.notDeepEqual(first, createAgentTurnMessageIds('session-1', 'conversation-1', 18, visible));
  assert.notDeepEqual(first, createAgentTurnMessageIds('session-1', 'conversation-1', 17, { ...visible, user_input: 'other' }));
  assert.ok(first.clientTurnId.length <= 128);
  assert.ok(first.userMessageId.length <= 128);
});

test('completion retries keep one assistant id, retain the run while uncertain, and replay locally after success', async (t) => {
  const completions = [];
  const server = createBailingHubMcpServer(AGENT_CONFIG);
  const projection = await initializeBailingHubMcpServer(server, AGENT_CONFIG, {
    agentClient: {
      async bootstrapWorkspace() { return profile(); },
      async startTurn() { return turn([]); },
      async searchCapabilities() { throw new Error('not used'); },
      async invoke() { throw new Error('not used'); },
      async resume() { throw new Error('not used'); },
      async completeRun(runId, input) {
        completions.push({ runId, input });
        if (completions.length === 1) {
          throw new BailingHubClientError(
            'BailingHub completion outcome is uncertain.', undefined, true, undefined, 'accepted_unknown',
          );
        }
        return { schema: 'bailing.agent-run-completion.v1', run_id: runId, status: input.status };
      },
    },
    clientConversationId: 'conversation-1',
  });
  const client = await connect(server, 'completion-replay');
  t.after(async () => { projection.close(); await client.close(); await server.close(); });
  await client.callTool({ name: 'start_business_turn', arguments: { user_input: 'Do it' } });
  const completionArguments = {
    content: 'Visible result only.', status: 'completed', model: 'provider:model',
    runtime: 'test-host', usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 },
  };
  const uncertain = await client.callTool({ name: 'complete_business_run', arguments: completionArguments });
  assert.equal(uncertain.isError, true);
  const completed = await client.callTool({ name: 'complete_business_run', arguments: completionArguments });
  assert.equal(completed.structuredContent.status, 'completed');
  const replayed = await client.callTool({ name: 'complete_business_run', arguments: completionArguments });
  assert.deepEqual(replayed.structuredContent, completed.structuredContent);
  assert.equal(completions.length, 2);
  assert.equal(completions[0].input.assistantMessageId, completions[1].input.assistantMessageId);
  assert.match(completions[0].input.assistantMessageId, /^mcp_assistant:[a-f0-9]{64}$/);
  assert.deepEqual(Object.keys(completions[0].input).sort(), [
    'assistantMessageId', 'content', 'model', 'runtime', 'status', 'usage',
  ]);
});

test('bootstrap polling sends If-None-Match and stops without downloading a full catalog', async () => {
  const bootstrapOptions = [];
  const server = createBailingHubMcpServer(AGENT_CONFIG);
  const projection = await initializeBailingHubMcpServer(server, AGENT_CONFIG, {
    agentClient: {
      async bootstrapWorkspace(options = {}) {
        bootstrapOptions.push(options);
        if (bootstrapOptions.length === 1) return profile({ etag: '"profile-1"' });
        return { ...profile(), not_modified: true, etag: '"profile-1"' };
      },
      async startTurn() { throw new Error('not used'); },
      async searchCapabilities() { throw new Error('not used'); },
      async invoke() { throw new Error('not used'); },
      async resume() { throw new Error('not used'); },
      async completeRun() { throw new Error('not used'); },
    },
    catalogPollIntervalMs: 20,
  });
  const client = await connect(server, 'etag-polling');
  await delay(75);
  assert.ok(bootstrapOptions.length >= 2);
  assert.deepEqual(bootstrapOptions[1], { ifNoneMatch: '"profile-1"' });
  await client.close();
  await server.close();
  const callsAfterClose = bootstrapOptions.length;
  await delay(60);
  assert.equal(bootstrapOptions.length, callsAfterClose);
  projection.close();
});

test('active set validation rejects reserved, duplicate, and over-limit turn tools without partial projection', async (t) => {
  const invalidSets = [
    [tool('start_business_turn')],
    [tool(), tool()],
    Array.from({ length: 13 }, (_value, index) => tool(`tool_${index}`)),
  ];
  for (const [index, activeTools] of invalidSets.entries()) {
    const server = createBailingHubMcpServer(AGENT_CONFIG);
    const projection = await initializeBailingHubMcpServer(server, AGENT_CONFIG, {
      agentClient: {
        async bootstrapWorkspace() { return profile(); },
        async startTurn() { return turn(activeTools); },
        async searchCapabilities() { throw new Error('not used'); },
        async invoke() { throw new Error('not used'); },
        async resume() { throw new Error('not used'); },
        async completeRun() { throw new Error('not used'); },
      },
      clientConversationId: `conversation-${index}`,
    });
    const client = await connect(server, `invalid-active-${index}`);
    const result = await client.callTool({ name: 'start_business_turn', arguments: { user_input: 'test' } });
    assert.equal(result.isError, true);
    assert.deepEqual((await client.listTools()).tools.map((entry) => entry.name).sort(), META_TOOLS);
    projection.close();
    await client.close();
    await server.close();
  }
  t.after(() => undefined);
});

const flaggedTool = () => tool('employee_search', { description_truncated: true, usage_guidance_available: true });
function toolDetail(definition = flaggedTool()) {
  const text = 'Bind the page to settings before publishing. 先确认绑定。';
  return { schema_version: 'bailing.agent-tool-detail.v1', route: 'orders', capability_revision: CAPABILITY_REVISION,
    tool: definition, usage_guidance: { text, truncated: false, source_chars: [...text].length, max_chars: 32768,
      source_bytes: Buffer.byteLength(text), max_bytes: 65536 } };
}
async function guidanceFixture(t, options = {}) {
  let starts = 0;
  let detailReads = 0;
  let searches = 0;
  let invokes = 0;
  const adapter = {
    async bootstrapWorkspace() { return profile(); },
    async startTurn() { starts++; return { ...turn([flaggedTool()]), run_id: starts === 1 ? RUN_ID : '33333333-3333-4333-8333-333333333333' }; },
    async searchCapabilities() { searches++; return { schema: 'bailing.agent-capability-search.v1', capability_revision: NEXT_REVISION, tools: [flaggedTool()] }; },
    async invoke() { invokes++; throw new Error('No business invocation expected'); },
    async resume() { throw new Error('No recovery expected'); },
    async completeRun(runId, input) { return { schema: 'bailing.agent-run-completion.v1', run_id: runId, status: input.status }; },
    ...(options.supported === false ? {} : { async getToolDetail(input) { detailReads++; return options.getToolDetail ? options.getToolDetail(input) : toolDetail(); } }),
  };
  const server = createBailingHubMcpServer(AGENT_CONFIG);
  const projection = await initializeBailingHubMcpServer(server, AGENT_CONFIG, { agentClient: adapter,
    clientConversationId: 'guidance-reference-conversation' });
  const client = await connect(server, 'guidance-reference');
  t.after(async () => { projection.close(); await client.close(); await server.close(); });
  const start = () => client.callTool({ name: 'start_business_turn', arguments: { user_input: `Read this declared capability ${starts}.` } });
  const read = (extra = {}) => client.callTool({ name: 'search_business_capabilities',
    arguments: { tool_name: 'employee_search', include_usage_guidance: true, ...extra } });
  return { client, projection, start, read, counts: () => ({ starts, detailReads, searches, invokes }) };
}

test('MCP tool flags are visible on start and search; full guidance is fetched only for an explicit loaded name', async t => {
  const f = await guidanceFixture(t);
  const started = await f.start();
  assert.equal(started.structuredContent.active_tools[0].description_truncated, true);
  assert.equal(started.structuredContent.active_tools[0].usage_guidance_available, true);
  assert.equal(f.counts().detailReads, 0);
  const typed = (await f.client.listTools()).tools.find(entry => entry.name === 'employee_search');
  assert.match(typed.description, /tool_name=employee_search and include_usage_guidance=true/);
  const reference = await f.read();
  assert.equal(reference.isError, undefined);
  assert.equal(reference.structuredContent.dispatch, 'not_dispatched');
  assert.equal(reference.structuredContent.business_operation_performed, false);
  assert.equal(Object.hasOwn(reference.structuredContent, 'invocation_id'), false);
  assert.match(reference.structuredContent.usage_guidance.text, /先确认绑定/);
  assert.equal(reference.structuredContent.usage_guidance.original_name, 'employee_search');
  assert.equal(f.counts().detailReads, 1);
  assert.equal(f.counts().searches, 0, 'exact known references do not run another discovery');
  await f.read({ include_usage_guidance: false });
  assert.equal(f.counts().detailReads, 1, 'false explicitly preserves the no-detail path');
  const searched = await f.client.callTool({ name: 'search_business_capabilities', arguments: { query: 'employee' } });
  assert.equal(searched.structuredContent.active_tools[0].usage_guidance_available, true);
  assert.equal(searched.structuredContent.active_tools[0].description_truncated, true);
  assert.equal(Object.hasOwn(searched.structuredContent, 'usage_guidance'), false);
  assert.equal(f.counts().detailReads, 1);
  assert.equal(f.counts().invokes, 0);
});

test('MCP explicit guidance rejects missing runs, unknown names and unsupported optional clients without business calls', async t => {
  const f = await guidanceFixture(t, { supported: false });
  assert.equal((await f.read()).isError, true);
  await f.start();
  const unsupported = await f.read();
  assert.equal(unsupported.isError, true);
  assert.equal(unsupported.structuredContent.feedback.code, 'agent_schema_unsupported');
  assert.equal(unsupported.structuredContent.feedback.next_action, 'check_compatibility');
  const missing = await f.read({ tool_name: 'missing_tool' });
  assert.equal(missing.structuredContent.feedback.code, 'tool_not_loaded');
  const noName = await f.client.callTool({ name: 'search_business_capabilities', arguments: { include_usage_guidance: true } });
  assert.equal(noName.structuredContent.feedback.code, 'invalid_request');
  assert.deepEqual(f.projection.activeToolNames(), ['employee_search']);
  assert.equal(f.counts().invokes, 0);
});

test('MCP custom detail clients cannot return mismatched bindings, malformed sizes, unsafe fields or oversized text', async t => {
  let response = toolDetail();
  const f = await guidanceFixture(t, { getToolDetail: async input => {
    assert.deepEqual(input, { name: 'employee_search', capabilityRevision: CAPABILITY_REVISION }); return response;
  } });
  await f.start();
  for (const mutate of [
    value => { value.route = 'other_route'; },
    value => { value.capability_revision = NEXT_REVISION; },
    value => { value.tool.name = 'other_tool'; },
    value => { value.tool.readonly = false; },
    value => { value.usage_guidance.source_bytes = 1; },
    value => { value.usage_guidance.truncated = true; },
    value => { value.usage_guidance.text = 'PRIVATE\0'; },
    value => { value.usage_guidance.text = '中'.repeat(23000); value.usage_guidance.source_chars = 23000; value.usage_guidance.source_bytes = 69000; },
  ]) {
    response = toolDetail(); mutate(response);
    const returned = await f.read();
    assert.equal(returned.isError, true);
    assert.equal(returned.structuredContent.feedback.code, 'agent_invalid_response');
    assert.equal(Object.hasOwn(returned.structuredContent, 'usage_guidance'), false);
    assert.doesNotMatch(JSON.stringify(returned.structuredContent), /PRIVATE/);
  }
  response = { ...toolDetail(), private: 'PRIVATE', usage_guidance: { ...toolDetail().usage_guidance, private: 'PRIVATE' } };
  const clean = await f.read();
  assert.doesNotMatch(JSON.stringify(clean.structuredContent), /PRIVATE/);
  assert.equal(f.counts().invokes, 0);
});

for (const change of ['run', 'revision', 'completion', 'close']) test(`MCP late guidance is rejected after ${change} changes`, async t => {
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  const f = await guidanceFixture(t, { getToolDetail: async () => { entered(); await gate; return toolDetail(); } });
  await f.start();
  const pending = f.read();
  await started;
  if (change === 'run') await f.start();
  else if (change === 'revision') await f.client.callTool({ name: 'search_business_capabilities', arguments: { query: 'refresh tools' } });
  else if (change === 'completion') await f.client.callTool({ name: 'complete_business_run', arguments: { content: 'Read only preparation completed.' } });
  else f.projection.close();
  release();
  const returned = await pending;
  assert.equal(returned.isError, true);
  assert.equal(returned.structuredContent.feedback.code, 'capability_changed');
  assert.equal(returned.structuredContent.feedback.dispatch, 'not_dispatched');
  assert.equal(Object.hasOwn(returned.structuredContent, 'usage_guidance'), false);
  assert.equal(f.counts().invokes, 0);
});

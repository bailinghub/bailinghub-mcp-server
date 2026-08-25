import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';

import { BailingHubClient, BailingHubClientError } from '../dist/client.js';
import {
  createAgentToolInvocationId,
  createBailingHubMcpServer,
  initializeBailingHubMcpServer,
} from '../dist/server.js';

const JOB_ID = '11111111-1111-4111-8111-111111111111';
const config = {
  baseUrl: 'https://hub.example.com',
  clientToken: 'client-token',
  route: 'orders',
};

test('tool schemas do not expose route, credentials, identity, approval, or callbacks', async (t) => {
  const mockClient = new BailingHubClient(config, async () => {
    throw new Error('network should not be used while listing tools');
  });
  const server = createBailingHubMcpServer(config, mockClient);
  const client = new Client({ name: 'schema-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const listed = await client.listTools();
  assert.deepEqual(
    listed.tools.map((tool) => tool.name).sort(),
    ['get_governed_job', 'submit_governed_job', 'wait_for_governed_job'],
  );

  const serialized = JSON.stringify(listed.tools);
  for (const forbidden of [
    'client_token',
    'admin_token',
    'subject',
    'approval_evidence',
    'approval_decision',
    'callback_url',
    'executor',
  ]) {
    assert.equal(serialized.includes(`"${forbidden}"`), false, `${forbidden} leaked into schema`);
  }

  const submit = listed.tools.find((tool) => tool.name === 'submit_governed_job');
  assert.deepEqual(Object.keys(submit.inputSchema.properties).sort(), ['input', 'request_id']);
  assert.equal(JSON.stringify(submit.inputSchema).includes('"route"'), false);
});

test('MCP errors remain structured and sanitized', async (t) => {
  const mockClient = new BailingHubClient(config, async () =>
    new Response('{}', { status: 401 }),
  );
  const server = createBailingHubMcpServer(config, mockClient);
  const client = new Client({ name: 'error-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const result = await client.callTool({
    name: 'get_governed_job',
    arguments: { job_id: JOB_ID },
  });
  assert.equal(result.isError, true);
  assert.equal(result.content[0].text, 'BailingHub rejected the Client Token.');
});

const agentConfig = {
  mode: 'agent',
  baseUrl: 'https://hub.example.com',
  route: 'orders',
  clientAppId: 'digital-cloud-agent',
  sessionId: 'session-1',
  accessTokenProvider: { getAccessToken: async () => 'access-secret' },
};
const AGENT_RUN_ID = '22222222-2222-4222-8222-222222222222';
const CAPABILITY_REVISION = 'a'.repeat(64);
const INVOCATION_ID = 'b'.repeat(64);

function agentCatalog(tools, capabilityRevision = CAPABILITY_REVISION) {
  return {
    schema_version: 'bailing.agent-tool-catalog.v1',
    route: 'orders',
    capability_revision: capabilityRevision,
    tools,
  };
}

function projectedTool(overrides = {}) {
  return {
    name: 'employee_search',
    description: 'Search the authorized tenant employee directory.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1 },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
        nickname: { type: 'string', nullable: true },
      },
      required: ['query'],
      additionalProperties: false,
    },
    scope: 'employee:read',
    risk: 'low',
    approval_required: false,
    readonly: true,
    idempotent: true,
    ...overrides,
  };
}

test('Agent mode exposes only direct tools, normalizes nullable, and resumes by invocation id', async (t) => {
  const calls = [];
  const mockClient = {
    async getAgentToolCatalog() {
      return agentCatalog([projectedTool()]);
    },
    async invokeAgentTool(input) {
      calls.push({ kind: 'invoke', input });
      return {
        schema_version: 'bailing.agent-tool-invocation.v1',
        invocation_id: input.invocationId,
        route: 'orders',
        tool: input.tool,
        state: 'executed',
        ok: true,
        auto_retry_allowed: false,
        text: 'Employee found.',
        business_status: 200,
      };
    },
    async resumeAgentToolInvocation(invocationId) {
      calls.push({ kind: 'resume', invocationId });
      return {
        schema_version: 'bailing.agent-tool-invocation.v1',
        invocation_id: invocationId,
        route: 'orders',
        tool: 'employee_search',
        state: 'executed',
        ok: true,
        auto_retry_allowed: false,
        text: 'Employee found.',
      };
    },
    submitJob: async () => assert.fail('not used'),
    getJob: async () => assert.fail('not used'),
    waitForJob: async () => assert.fail('not used'),
  };
  const server = createBailingHubMcpServer(agentConfig, mockClient);
  await initializeBailingHubMcpServer(server, agentConfig, {
    agentRunId: AGENT_RUN_ID,
  });
  const client = new Client({ name: 'agent-tool-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const listed = await client.listTools();
  assert.deepEqual(
    listed.tools.map((tool) => tool.name).sort(),
    ['employee_search', 'resume_governed_tool_invocation'],
  );
  const employeeSearch = listed.tools.find((tool) => tool.name === 'employee_search');
  assert.match(employeeSearch.description, /risk=low/);
  assert.match(employeeSearch.description, /access=read-only/);
  assert.match(employeeSearch.description, /approval=no route-level human approval required/);
  assert.equal(JSON.stringify(employeeSearch.inputSchema).includes('"default"'), false);
  assert.equal(JSON.stringify(employeeSearch.inputSchema).includes('"nullable"'), false);
  assert.equal(JSON.stringify(employeeSearch.inputSchema).includes('"null"'), true);

  const invoked = await client.callTool({
    name: 'employee_search',
    arguments: { query: 'Alice', nickname: null },
  });
  assert.equal(invoked.isError, undefined);
  assert.equal(invoked.structuredContent.state, 'executed');
  assert.match(calls[0].input.invocationId, /^[0-9a-f]{64}$/);
  assert.equal(calls[0].input.agentRunId, AGENT_RUN_ID);
  assert.equal(calls[0].input.capabilityRevision, CAPABILITY_REVISION);
  assert.deepEqual(calls[0].input.arguments, { query: 'Alice', nickname: null });

  const resumed = await client.callTool({
    name: 'resume_governed_tool_invocation',
    arguments: { invocation_id: INVOCATION_ID },
  });
  assert.equal(resumed.structuredContent.invocation_id, INVOCATION_ID);
  assert.deepEqual(calls[1], {
    kind: 'resume',
    invocationId: INVOCATION_ID,
  });
});

test('dynamic invocation HTTP uncertainty is sanitized and directs exact-id recovery', async (t) => {
  const mockClient = {
    async getAgentToolCatalog() {
      return agentCatalog([projectedTool()]);
    },
    async invokeAgentTool() {
      throw new BailingHubClientError(
        'Could not connect to BailingHub.',
        undefined,
        true,
        undefined,
        'accepted_unknown',
      );
    },
    submitJob: async () => assert.fail('not used'),
    getJob: async () => assert.fail('not used'),
    waitForJob: async () => assert.fail('not used'),
  };
  const server = createBailingHubMcpServer(agentConfig, mockClient);
  await initializeBailingHubMcpServer(server, agentConfig, {
    agentRunId: AGENT_RUN_ID,
  });
  const client = new Client({ name: 'agent-error-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const result = await client.callTool({
    name: 'employee_search',
    arguments: { query: 'Alice' },
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /invocation_id=[0-9a-f]{64}/);
  assert.match(result.content[0].text, /resume_governed_tool_invocation/);
  assert.match(result.content[0].text, /may have accepted/);
});

test('capability_changed refreshes handles, notifies DSH, and requires a fresh tool choice', async (t) => {
  const nextRevision = 'c'.repeat(64);
  let catalogCalls = 0;
  const invocationCalls = [];
  const mockClient = {
    async getAgentToolCatalog() {
      catalogCalls += 1;
      return catalogCalls === 1
        ? agentCatalog([projectedTool()])
        : agentCatalog(
            [projectedTool({ name: 'employee_lookup', description: 'Lookup employees.' })],
            nextRevision,
          );
    },
    async invokeAgentTool(input) {
      invocationCalls.push(input);
      if (input.tool === 'employee_search') {
        throw new BailingHubClientError(
          'BailingHub rejected the request because its capability catalog changed.',
          409,
          false,
          'capability_changed',
          'refresh_required',
        );
      }
      return {
        schema_version: 'bailing.agent-tool-invocation.v1',
        invocation_id: input.invocationId,
        route: 'orders',
        tool: input.tool,
        state: 'executed',
        ok: true,
        auto_retry_allowed: false,
        text: 'Employee found.',
      };
    },
  };
  const server = createBailingHubMcpServer(agentConfig, mockClient);
  const projection = await initializeBailingHubMcpServer(server, agentConfig, {
    agentRunId: AGENT_RUN_ID,
  });
  const client = new Client({ name: 'agent-refresh-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  let notifyChanged;
  const toolsChanged = new Promise((resolve) => {
    notifyChanged = resolve;
  });
  client.setNotificationHandler(ToolListChangedNotificationSchema, () => notifyChanged());
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const stale = await client.callTool({
    name: 'employee_search',
    arguments: { query: 'Alice' },
  });
  assert.equal(stale.isError, true);
  assert.match(stale.content[0].text, /catalog changed/);
  assert.match(stale.content[0].text, /Re-list the MCP tools/);
  assert.equal(stale.content[0].text.includes('resume_governed_tool_invocation'), false);
  await Promise.race([
    toolsChanged,
    delay(1_000).then(() => assert.fail('tools/list_changed was not delivered')),
  ]);

  const listed = await client.listTools();
  assert.deepEqual(
    listed.tools.map((tool) => tool.name).sort(),
    ['employee_lookup', 'resume_governed_tool_invocation'],
  );
  assert.equal(projection.revision(), nextRevision);

  const fresh = await client.callTool({
    name: 'employee_lookup',
    arguments: { query: 'Alice' },
  });
  assert.equal(fresh.structuredContent.state, 'executed');
  assert.equal(invocationCalls[1].capabilityRevision, nextRevision);
});

test('catalog refresh rejects same-revision mutation before changing registered handles', async (t) => {
  let catalogCalls = 0;
  const mockClient = {
    async getAgentToolCatalog() {
      catalogCalls += 1;
      return catalogCalls === 1
        ? agentCatalog([projectedTool()])
        : agentCatalog([projectedTool({ name: 'employee_lookup' })]);
    },
  };
  const server = createBailingHubMcpServer(agentConfig, mockClient);
  const projection = await initializeBailingHubMcpServer(server, agentConfig, {
    agentRunId: AGENT_RUN_ID,
  });
  await assert.rejects(
    projection.refresh(),
    /different Agent tools under the same capability revision/,
  );

  const client = new Client({ name: 'agent-invalid-refresh-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  t.after(async () => {
    await client.close();
    await server.close();
  });
  assert.deepEqual(
    (await client.listTools()).tools.map((tool) => tool.name).sort(),
    ['employee_search', 'resume_governed_tool_invocation'],
  );
});

test('connected Agent projection polls with one bounded timer and stops it on close', async () => {
  const nextRevision = 'd'.repeat(64);
  let catalogCalls = 0;
  const mockClient = {
    async getAgentToolCatalog() {
      catalogCalls += 1;
      return catalogCalls === 1
        ? agentCatalog([projectedTool()])
        : agentCatalog(
            [projectedTool({ name: 'employee_lookup' })],
            nextRevision,
          );
    },
  };
  const server = createBailingHubMcpServer(agentConfig, mockClient);
  await initializeBailingHubMcpServer(server, agentConfig, {
    agentRunId: AGENT_RUN_ID,
    catalogPollIntervalMs: 20,
  });
  const client = new Client({ name: 'agent-poll-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  let notifyChanged;
  const toolsChanged = new Promise((resolve) => {
    notifyChanged = resolve;
  });
  client.setNotificationHandler(ToolListChangedNotificationSchema, () => notifyChanged());
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  await Promise.race([
    toolsChanged,
    delay(1_000).then(() => assert.fail('catalog polling did not refresh tools')),
  ]);
  assert.deepEqual(
    (await client.listTools()).tools.map((tool) => tool.name).sort(),
    ['employee_lookup', 'resume_governed_tool_invocation'],
  );

  await client.close();
  await server.close();
  const callsAfterClose = catalogCalls;
  await delay(80);
  assert.equal(catalogCalls, callsAfterClose);
});

test('Agent tool projection rejects reserved or duplicated tool names before connect', async () => {
  for (const tools of [
    [projectedTool({ name: 'submit_governed_job' })],
    [projectedTool(), projectedTool()],
  ]) {
    const mockClient = {
      async getAgentToolCatalog() {
        return agentCatalog(tools);
      },
    };
    const server = createBailingHubMcpServer(agentConfig, mockClient);
    await assert.rejects(
      initializeBailingHubMcpServer(server, agentConfig, {
        agentRunId: AGENT_RUN_ID,
      }),
      /conflicts with a reserved MCP tool|is duplicated/,
    );
    await server.close();
  }
});

test('Agent invocation ids bind session, local run, and MCP request id', () => {
  assert.equal(
    createAgentToolInvocationId('session-1', AGENT_RUN_ID, 17),
    createAgentToolInvocationId('session-1', AGENT_RUN_ID, 17),
  );
  assert.notEqual(
    createAgentToolInvocationId('session-1', AGENT_RUN_ID, 17),
    createAgentToolInvocationId('session-1', AGENT_RUN_ID, 18),
  );
  assert.match(
    createAgentToolInvocationId('session-1', AGENT_RUN_ID, 'request-1'),
    /^[0-9a-f]{64}$/,
  );
  assert.notEqual(
    createAgentToolInvocationId('session-1', AGENT_RUN_ID, 1),
    createAgentToolInvocationId('session-1', AGENT_RUN_ID, '1'),
  );
  assert.throws(
    () => createAgentToolInvocationId('session-1', AGENT_RUN_ID, 1.5),
    /MCP request id is invalid/,
  );
  assert.throws(
    () => createAgentToolInvocationId('session-1', AGENT_RUN_ID, ''),
    /MCP request id is invalid/,
  );
});

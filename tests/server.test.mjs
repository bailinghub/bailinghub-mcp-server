import assert from 'node:assert/strict';
import test from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { BailingHubClient } from '../dist/client.js';
import {
  createAgentToolInvocationId,
  createBailingHubMcpServer,
} from '../dist/server.js';

const JOB_ID = '11111111-1111-4111-8111-111111111111';
const AGENT_RUN_ID = '22222222-2222-4222-8222-222222222222';
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
    'client_token', 'admin_token', 'subject', 'approval_evidence',
    'approval_decision', 'callback_url', 'executor',
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
    name: 'get_governed_job', arguments: { job_id: JOB_ID },
  });
  assert.equal(result.isError, true);
  assert.equal(result.content[0].text, 'BailingHub rejected the Client Token.');
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

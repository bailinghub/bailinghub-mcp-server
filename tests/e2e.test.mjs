import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const JOB_ID = '11111111-1111-4111-8111-111111111111';

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address()));
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

test('stdio MCP server submits and waits against a no-side-effect BailingHub mock', async (t) => {
  let postCount = 0;
  let getCount = 0;
  const mock = createServer(async (request, response) => {
    assert.equal(request.headers.authorization, 'Bearer test-client-token');
    if (request.method === 'POST' && request.url === '/run') {
      postCount += 1;
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString('utf8')), {
        request_id: 'mcp:e2e:1',
        route: 'orders',
        input: 'Read order 42 without changing it.',
      });
      response.writeHead(202, { 'Content-Type': 'application/json' });
      response.end(
        JSON.stringify({ job_id: JOB_ID, request_id: 'mcp:e2e:1', status: 'queued' }),
      );
      return;
    }
    if (request.method === 'GET' && request.url === `/jobs/${JOB_ID}`) {
      getCount += 1;
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(
        JSON.stringify({
          job_id: JOB_ID,
          request_id: 'mcp:e2e:1',
          status: 'done',
          result: { governed: true },
        }),
      );
      return;
    }
    response.writeHead(404).end();
  });
  const address = await listen(mock);
  t.after(() => close(mock));

  const cleanEnvironment = Object.fromEntries(
    Object.entries(process.env).filter((entry) => typeof entry[1] === 'string'),
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['dist/index.js'],
    env: {
      ...cleanEnvironment,
      BAILINGHUB_BASE_URL: `http://127.0.0.1:${address.port}`,
      BAILINGHUB_CLIENT_TOKEN: 'test-client-token',
      BAILINGHUB_ROUTE: 'orders',
    },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'stdio-e2e', version: '1.0.0' });
  await client.connect(transport);
  t.after(() => client.close());

  const submitted = await client.callTool({
    name: 'submit_governed_job',
    arguments: {
      request_id: 'mcp:e2e:1',
      input: 'Read order 42 without changing it.',
    },
  });
  assert.equal(submitted.isError, undefined);
  assert.equal(submitted.structuredContent.job_id, JOB_ID);
  assert.equal(submitted.structuredContent.status, 'queued');

  const waited = await client.callTool({
    name: 'wait_for_governed_job',
    arguments: { job_id: JOB_ID, max_wait_seconds: 1 },
  });
  assert.equal(waited.isError, undefined);
  assert.equal(waited.structuredContent.status, 'done');
  assert.deepEqual(waited.structuredContent.result, { governed: true });
  assert.equal(postCount, 1);
  assert.equal(getCount, 1);
});

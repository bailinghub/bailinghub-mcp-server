import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  BailingHubClient,
  BailingHubClientError,
  CLIENT_API_LIMITS,
  KNOWN_STATUSES,
  TERMINAL_STATUSES,
} from '../dist/client.js';

const JOB_ID = '11111111-1111-4111-8111-111111111111';
const config = {
  baseUrl: 'https://hub.example.com',
  clientToken: 'client-token',
  route: 'orders',
};

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

test('compatibility declaration matches exported status and size limits', async () => {
  const compatibility = JSON.parse(
    await readFile(new URL('../compatibility/client-api.json', import.meta.url), 'utf8'),
  );
  assert.deepEqual(compatibility.known_job_statuses, [...KNOWN_STATUSES]);
  assert.deepEqual(compatibility.terminal_job_statuses, [...TERMINAL_STATUSES]);
  assert.equal(compatibility.limits.request_id_max_length, CLIENT_API_LIMITS.requestId);
  assert.equal(compatibility.limits.input_max_length, CLIENT_API_LIMITS.input);
  assert.equal(compatibility.limits.response_max_bytes, CLIENT_API_LIMITS.responseBytes);
});

test('submit sends only the minimal public contract and filters private response fields', async () => {
  const calls = [];
  const client = new BailingHubClient(config, async (url, init) => {
    calls.push({ url: String(url), init });
    return jsonResponse(
      {
        job_id: JOB_ID,
        request_id: 'mcp:run:1',
        status: 'queued',
        project: 'must-not-leak',
        metadata: { principal: { id: 'must-not-leak' } },
      },
      202,
    );
  });

  assert.deepEqual(await client.submitJob('mcp:run:1', 'Read order 42'), {
    job_id: JOB_ID,
    request_id: 'mcp:run:1',
    status: 'queued',
    terminal: false,
  });
  assert.equal(calls[0].url, 'https://hub.example.com/run');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer client-token');
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    request_id: 'mcp:run:1',
    route: 'orders',
    input: 'Read order 42',
  });
});

test('get returns only documented result fields', async () => {
  const client = new BailingHubClient(config, async () =>
    jsonResponse({
      job_id: JOB_ID,
      request_id: 'r1',
      status: 'done',
      result: { text: 'done' },
      report: { severity: 'P2' },
      raw_result: 'raw',
      usage: { tokens: 10 },
      metadata: { private: true },
      dispatch: { target_config: { secret: true } },
    }),
  );

  assert.deepEqual(await client.getJob(JOB_ID), {
    job_id: JOB_ID,
    request_id: 'r1',
    status: 'done',
    terminal: true,
    report: { severity: 'P2' },
    result: { text: 'done' },
    usage: { tokens: 10 },
    raw_result: 'raw',
  });
});

test('unknown job status fails closed', async () => {
  const client = new BailingHubClient(config, async () =>
    jsonResponse({ job_id: JOB_ID, request_id: 'r1', status: 'future_status' }),
  );
  await assert.rejects(client.getJob(JOB_ID), /invalid job response/);
});

test('upstream errors are classified without exposing response bodies or credentials', async () => {
  const client = new BailingHubClient(config, async () =>
    jsonResponse({ error: 'client-token and private stack trace' }, 401),
  );
  await assert.rejects(
    client.getJob(JOB_ID),
    (error) =>
      error instanceof BailingHubClientError &&
      error.message === 'BailingHub rejected the Client Token.' &&
      !error.message.includes('client-token'),
  );
});

test('response size is bounded before JSON reaches the MCP host', async () => {
  const client = new BailingHubClient(config, async () =>
    jsonResponse(
      { job_id: JOB_ID, request_id: 'r1', status: 'done' },
      200,
      { 'Content-Length': String(CLIENT_API_LIMITS.responseBytes + 1) },
    ),
  );
  await assert.rejects(client.getJob(JOB_ID), /1 MiB safety limit/);
});

test('bounded wait reaches terminal state without resubmitting', async () => {
  const states = ['queued', 'done'];
  let now = 0;
  let requestCount = 0;
  const client = new BailingHubClient(config, async () => {
    requestCount += 1;
    return jsonResponse({
      job_id: JOB_ID,
      request_id: 'r1',
      status: states.shift(),
    });
  });

  const result = await client.waitForJob(JOB_ID, 20, {
    pollIntervalMilliseconds: 2000,
    now: () => now,
    sleep: async (milliseconds) => {
      now += milliseconds;
    },
  });
  assert.equal(requestCount, 2);
  assert.equal(result.status, 'done');
  assert.equal(result.wait_timed_out, false);
  assert.equal(result.poll_count, 2);
});

test('bounded wait timeout returns the latest state and never submits a replacement job', async () => {
  let now = 0;
  let requestCount = 0;
  const client = new BailingHubClient(config, async (_url, init) => {
    requestCount += 1;
    assert.equal(init.method, 'GET');
    return jsonResponse({ job_id: JOB_ID, request_id: 'r1', status: 'running' });
  });

  const result = await client.waitForJob(JOB_ID, 1, {
    pollIntervalMilliseconds: 1000,
    now: () => now,
    sleep: async (milliseconds) => {
      now += milliseconds;
    },
  });
  assert.equal(requestCount, 2);
  assert.equal(result.status, 'running');
  assert.equal(result.wait_timed_out, true);
});

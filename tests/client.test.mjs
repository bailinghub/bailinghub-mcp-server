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
  assert.equal(calls[0].init.redirect, 'error');
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

test('Agent mode forbids delegated jobs and refreshes Agent auth once for direct catalog access', async () => {
  const calls = [];
  const tokenRequests = [];
  const agentConfig = {
    mode: 'agent',
    baseUrl: 'https://hub.example.com',
    route: 'orders',
    clientAppId: 'digital-cloud-agent',
    sessionId: 'session-1',
    accessTokenProvider: {
      async getAccessToken(forceRefresh = false) {
        tokenRequests.push(forceRefresh);
        return forceRefresh ? 'rotated-access-secret' : 'old-access-secret';
      },
    },
  };
  const client = new BailingHubClient(agentConfig, async (url, init) => {
    calls.push({ url: String(url), init });
    if (calls.length === 1) return jsonResponse({}, 401);
    return jsonResponse({
      schema_version: 'bailing.agent-tool-catalog.v1',
      route: 'orders',
      capability_revision: 'a'.repeat(64),
      tools: [],
    });
  });

  await assert.rejects(
    client.submitJob('agent:run:1', 'Read order 42'),
    /does not support delegated BailingHub jobs/,
  );
  assert.equal(calls.length, 0);
  assert.equal((await client.getAgentToolCatalog()).route, 'orders');
  assert.deepEqual(tokenRequests, [false, true]);
  assert.equal(calls[0].url, 'https://hub.example.com/agent-api/v1/tools?route=orders');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer old-access-secret');
  assert.equal(calls[0].init.redirect, 'error');
  assert.equal(calls[1].init.headers.Authorization, 'Bearer rotated-access-secret');
  assert.equal(calls[1].init.body, undefined);
});

test('Agent mode job lookup remains session-owned and never falls back to the Client API', async () => {
  const agentConfig = {
    mode: 'agent',
    baseUrl: 'https://hub.example.com',
    route: 'orders',
    clientAppId: 'digital-cloud-agent',
    sessionId: 'session-1',
    accessTokenProvider: { getAccessToken: async () => 'access-secret' },
  };
  const client = new BailingHubClient(agentConfig, async (url, init) => {
    assert.equal(String(url), `https://hub.example.com/agent-api/v1/jobs/${JOB_ID}`);
    assert.equal(init.headers.Authorization, 'Bearer access-secret');
    return jsonResponse({ job_id: JOB_ID, request_id: 'r1', status: 'done' });
  });
  assert.equal((await client.getJob(JOB_ID)).status, 'done');
});

const AGENT_RUN_ID = '22222222-2222-4222-8222-222222222222';
const INVOCATION_ID = 'b'.repeat(64);
const CAPABILITY_REVISION = 'a'.repeat(64);

function agentRuntimeConfig() {
  return {
    mode: 'agent',
    baseUrl: 'https://hub.example.com',
    route: 'orders',
    clientAppId: 'digital-cloud-agent',
    sessionId: 'session-1',
    accessTokenProvider: { getAccessToken: async () => 'access-secret' },
  };
}

test('Agent tool catalog is route-bound and strictly filters the public projection', async () => {
  const calls = [];
  const client = new BailingHubClient(agentRuntimeConfig(), async (url, init) => {
    calls.push({ url: String(url), init });
    return jsonResponse({
      schema_version: 'bailing.agent-tool-catalog.v1',
      route: 'orders',
      capability_revision: CAPABILITY_REVISION,
      principal: { id: 'must-not-leak' },
      tools: [
        {
          name: 'employee_search',
          description: 'Search employees.',
          input_schema: {
            type: 'object',
            properties: { query: { type: 'string' } },
            required: ['query'],
          },
          scope: 'employee:read',
          risk: 'low',
          approval_required: false,
          readonly: true,
          idempotent: true,
          provider_base_url: 'https://private.example.com',
        },
      ],
    });
  });

  assert.deepEqual(await client.getAgentToolCatalog(), {
    schema_version: 'bailing.agent-tool-catalog.v1',
    route: 'orders',
    capability_revision: CAPABILITY_REVISION,
    tools: [
      {
        name: 'employee_search',
        description: 'Search employees.',
        input_schema: {
          type: 'object',
          properties: { query: { type: 'string' } },
          required: ['query'],
        },
        scope: 'employee:read',
        risk: 'low',
        approval_required: false,
        readonly: true,
        idempotent: true,
      },
    ],
  });
  assert.equal(
    calls[0].url,
    'https://hub.example.com/agent-api/v1/tools?route=orders',
  );
  assert.equal(calls[0].init.headers.Authorization, 'Bearer access-secret');
});

test('Agent tool invocation sends the frozen contract and filters private response data', async () => {
  const calls = [];
  const client = new BailingHubClient(agentRuntimeConfig(), async (url, init) => {
    calls.push({ url: String(url), init, body: JSON.parse(init.body) });
    return jsonResponse({
      schema_version: 'bailing.agent-tool-invocation.v1',
      invocation_id: INVOCATION_ID,
      route: 'orders',
      tool: 'employee_search',
      state: 'executed',
      ok: true,
      auto_retry_allowed: false,
      text: 'Employee found.',
      business_status: 200,
      result: { private_record: true },
      agent_run_id: AGENT_RUN_ID,
      capability_revision: CAPABILITY_REVISION,
    });
  });

  assert.deepEqual(
    await client.invokeAgentTool({
      invocationId: INVOCATION_ID,
      capabilityRevision: CAPABILITY_REVISION,
      agentRunId: AGENT_RUN_ID,
      tool: 'employee_search',
      arguments: { query: 'Alice' },
    }),
    {
      schema_version: 'bailing.agent-tool-invocation.v1',
      invocation_id: INVOCATION_ID,
      route: 'orders',
      tool: 'employee_search',
      state: 'executed',
      ok: true,
      auto_retry_allowed: false,
      text: 'Employee found.',
      business_status: 200,
    },
  );
  assert.equal(
    calls[0].url,
    'https://hub.example.com/agent-api/v1/tool-invocations',
  );
  assert.deepEqual(calls[0].body, {
    invocation_id: INVOCATION_ID,
    route: 'orders',
    capability_revision: CAPABILITY_REVISION,
    agent_run_id: AGENT_RUN_ID,
    tool: 'employee_search',
    arguments: { query: 'Alice' },
  });
});

test('Agent tool resume depends only on the exact invocation id', async () => {
  const calls = [];
  const client = new BailingHubClient(agentRuntimeConfig(), async (url, init) => {
    calls.push({ url: String(url), body: init.body });
    return jsonResponse({
      schema_version: 'bailing.agent-tool-invocation.v1',
      invocation_id: INVOCATION_ID,
      route: 'orders',
      tool: 'employee_search',
      state: 'awaiting_approval',
      ok: false,
      auto_retry_allowed: true,
      text: 'Approval is pending.',
      approval_id: 42,
    });
  });

  const result = await client.resumeAgentToolInvocation(INVOCATION_ID);
  assert.equal(result.state, 'awaiting_approval');
  assert.equal(result.approval_id, 42);
  assert.equal(
    calls[0].url,
    `https://hub.example.com/agent-api/v1/tool-invocations/${INVOCATION_ID}/resume`,
  );
  assert.equal(calls[0].body, undefined);
});

test('Agent HTTP errors retain only allowlisted codes and classify capability refresh safely', async () => {
  const client = new BailingHubClient(agentRuntimeConfig(), async () =>
    jsonResponse(
      {
        error: 'capability_changed',
        message: 'access-secret private database trace',
      },
      409,
    ),
  );

  await assert.rejects(
    client.invokeAgentTool({
      invocationId: INVOCATION_ID,
      capabilityRevision: CAPABILITY_REVISION,
      agentRunId: AGENT_RUN_ID,
      tool: 'employee_search',
      arguments: {},
    }),
    (error) =>
      error instanceof BailingHubClientError &&
      error.publicCode === 'capability_changed' &&
      error.disposition === 'refresh_required' &&
      !error.message.includes('access-secret') &&
      !error.message.includes('database trace'),
  );
});

test('Agent HTTP errors treat an allowlisted pre-dispatch pause as a definitive rejection', async () => {
  const client = new BailingHubClient(agentRuntimeConfig(), async () =>
    jsonResponse(
      {
        error: 'hub_paused',
        message: 'access-secret private maintenance detail',
      },
      503,
    ),
  );

  await assert.rejects(
    client.invokeAgentTool({
      invocationId: INVOCATION_ID,
      capabilityRevision: CAPABILITY_REVISION,
      agentRunId: AGENT_RUN_ID,
      tool: 'employee_search',
      arguments: {},
    }),
    (error) =>
      error instanceof BailingHubClientError &&
      error.publicCode === 'hub_paused' &&
      error.disposition === 'definitive_rejection' &&
      !error.message.includes('access-secret') &&
      !error.message.includes('maintenance detail'),
  );
});

test('Agent tool responses fail closed on route, identifier, or governance-state substitution', async () => {
  for (const override of [
    { route: 'other-route' },
    { invocation_id: 'c'.repeat(64) },
    { state: 'future_state' },
  ]) {
    const client = new BailingHubClient(agentRuntimeConfig(), async () =>
      jsonResponse({
        schema_version: 'bailing.agent-tool-invocation.v1',
        invocation_id: INVOCATION_ID,
        route: 'orders',
        tool: 'employee_search',
        state: 'executed',
        ok: true,
        auto_retry_allowed: false,
        text: '',
        ...override,
      }),
    );
    await assert.rejects(
      client.invokeAgentTool({
        invocationId: INVOCATION_ID,
        capabilityRevision: CAPABILITY_REVISION,
        agentRunId: AGENT_RUN_ID,
        tool: 'employee_search',
        arguments: {},
      }),
      /invalid Agent tool invocation/,
    );
  }
});

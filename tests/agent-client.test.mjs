import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BailingHubAgentClient,
} from '../dist/agent-client.js';
import { BailingHubClientError } from '../dist/client.js';

const RUN_ID = '22222222-2222-4222-8222-222222222222';
const INVOCATION_ID = 'b'.repeat(64);
const CAPABILITY_REVISION = 'a'.repeat(64);

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function activeTool(name = 'employee_search') {
  return {
    name,
    description: 'Search employees.\nUse a tenant-visible name.\tTabs are allowed.',
    input_schema: {
      type: 'object', properties: { query: { type: 'string' } },
      required: ['query'], additionalProperties: false,
    },
    scope: 'tenant.employee.read',
    risk: 'low',
    approval_required: false,
    readonly: true,
    idempotent: true,
  };
}

function connection(accessTokenProvider = { getAccessToken: async () => 'access-token' }) {
  return {
    baseUrl: 'https://hub.example.com',
    clientAppId: 'example-agent-client',
    workspace: 'orders',
    sessionId: 'session-1',
    accessTokenProvider,
  };
}

test('Agent Client v1 maps the frozen Core paths and DTOs without hidden reasoning', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const path = new URL(String(url)).pathname;
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ path, method: init.method, headers: init.headers, body });
    if (path === '/agent-api/v1/workspaces') {
      return jsonResponse({
        schema_version: 'bailing.agent-workspaces.v1',
        workspaces: [{ route: 'orders', name: 'Orders', description: 'Order\nworkspace' }],
      }, 200, { ETag: '"workspaces-1"' });
    }
    if (path.endsWith('/bootstrap')) {
      return jsonResponse({
        schema_version: 'bailing.agent-runtime-profile.v1',
        workspace: { route: 'orders', name: 'Orders', description: 'Order workspace' },
        profile: {
          revision: 'f'.repeat(64), instructions: 'Plan locally.',
          knowledge: { enabled: true, sources: 2 },
          memory: { recent_messages: 5 }, governance: { planner: 'local_agent' },
        },
        capabilities: {
          revision: CAPABILITY_REVISION, authorized_total: 20, active_limit: 12,
          readonly: 15, writes: 5, approval_required: 3,
        },
      });
    }
    if (path.endsWith('/turns')) {
      return jsonResponse({
        schema_version: 'bailing.agent-turn-context.v1', run_id: RUN_ID,
        profile_revision: 'f'.repeat(64), capability_revision: CAPABILITY_REVISION,
        context: {
          instructions: 'Plan locally.', page_context: { page_key: 'staff' },
          renderers: ['bailing-form.v1'], memory: { recent: [] },
          memory_refs: [{ thread_id: 7 }], knowledge: [{ content: 'Visible knowledge' }],
          knowledge_refs: [{ ref: 'knowledge:1' }], governance: { planner: 'local_agent' },
        },
        active_tools: [activeTool()],
      });
    }
    if (path.endsWith('/capabilities/search')) {
      return jsonResponse({
        schema_version: 'bailing.agent-capability-search.v1', route: 'orders',
        capability_revision: CAPABILITY_REVISION, query: body.query ?? '', tools: [activeTool()],
      });
    }
    if (path === '/agent-api/v1/tool-invocations') {
      return jsonResponse({
        schema_version: 'bailing.agent-tool-invocation.v1', invocation_id: INVOCATION_ID,
        route: 'orders', tool: 'employee_search', state: 'executed', ok: true,
        auto_retry_allowed: false, text: 'done', business_status: 200,
      });
    }
    if (path.endsWith(`/tool-invocations/${INVOCATION_ID}/resume`)) {
      return jsonResponse({
        schema_version: 'bailing.agent-tool-invocation.v1', invocation_id: INVOCATION_ID,
        route: 'orders', tool: 'employee_search', state: 'executed', ok: true,
        auto_retry_allowed: false, text: 'done',
      });
    }
    if (path.endsWith(`/runs/${RUN_ID}/complete`)) {
      return jsonResponse({
        schema_version: 'bailing.agent-run-completion.v1', run_id: RUN_ID,
        assistant_message_id: body.assistant_message_id, status: body.status,
      });
    }
    throw new Error(`Unexpected path ${path}`);
  };
  const client = new BailingHubAgentClient(connection(), { fetchImpl });

  const workspaces = await client.listWorkspaces();
  assert.equal(workspaces.etag, '"workspaces-1"');
  assert.match(workspaces.workspaces[0].description, /\n/);
  const bootstrap = await client.bootstrapWorkspace();
  assert.deepEqual(bootstrap.profile.knowledge, { enabled: true, sources: 2 });
  assert.equal(bootstrap.capabilities.authorized_total, 20);
  assert.equal(Object.hasOwn(bootstrap.capabilities, 'active_tools'), false);
  const started = await client.startTurn({
    clientConversationId: 'conversation-1', clientTurnId: 'turn-1',
    userMessageId: 'message-1', userInput: 'Find Alice\nthen show the team\tplease',
    pageContext: { page_key: 'staff' }, renderers: ['bailing-form.v1'],
  });
  assert.deepEqual(started.context.memory_refs, [{ thread_id: 7 }]);
  assert.deepEqual(started.context.knowledge, [{ content: 'Visible knowledge' }]);
  assert.deepEqual(started.context.page_context, { page_key: 'staff' });
  assert.deepEqual(started.context.renderers, ['bailing-form.v1']);
  await client.searchCapabilities({ query: 'employee\nlookup', limit: 8, runId: RUN_ID });
  await client.searchCapabilities({ query: '', runId: RUN_ID });
  await client.invoke({
    invocationId: INVOCATION_ID, capabilityRevision: CAPABILITY_REVISION,
    agentRunId: RUN_ID, tool: 'employee_search', arguments: { query: 'Alice' },
  });
  await client.resume(INVOCATION_ID);
  await client.completeRun(RUN_ID, {
    assistantMessageId: 'assistant-1'.replace('-', '_'),
    content: 'Visible final\nanswer', status: 'completed', model: 'provider:model',
    runtime: 'test-host', usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 },
    reasoning: 'must never cross', hidden_reasoning: 'must never cross',
  });

  assert.deepEqual(calls.map((entry) => [entry.method, entry.path]), [
    ['GET', '/agent-api/v1/workspaces'],
    ['GET', '/agent-api/v1/workspaces/orders/bootstrap'],
    ['POST', '/agent-api/v1/workspaces/orders/turns'],
    ['POST', '/agent-api/v1/workspaces/orders/capabilities/search'],
    ['POST', '/agent-api/v1/workspaces/orders/capabilities/search'],
    ['POST', '/agent-api/v1/tool-invocations'],
    ['POST', `/agent-api/v1/tool-invocations/${INVOCATION_ID}/resume`],
    ['POST', `/agent-api/v1/runs/${RUN_ID}/complete`],
  ]);
  assert.equal(calls[2].body.user_input, 'Find Alice\nthen show the team\tplease');
  assert.deepEqual(calls[4].body, { limit: 12, run_id: RUN_ID });
  assert.deepEqual(Object.keys(calls[7].body).sort(), [
    'assistant_message_id', 'content', 'model', 'runtime', 'status', 'usage',
  ]);
  assert.equal(JSON.stringify(calls).includes('must never cross'), false);
  assert.equal(calls.every((entry) => entry.headers.Authorization === 'Bearer access-token'), true);
});

test('Agent Client enforces Core limits before network I/O', async () => {
  let fetchCalls = 0;
  const client = new BailingHubAgentClient(connection(), {
    fetchImpl: async () => { fetchCalls += 1; throw new Error('must not fetch'); },
  });
  const baseTurn = {
    clientConversationId: 'c', clientTurnId: 't', userMessageId: 'm', userInput: 'hello',
  };
  await assert.rejects(client.startTurn({ ...baseTurn, clientConversationId: 'c'.repeat(129) }), /clientConversationId/);
  await assert.rejects(client.startTurn({ ...baseTurn, userInput: 'x'.repeat(64_001) }), /userInput/);
  await assert.rejects(client.startTurn({ ...baseTurn, pageContext: { value: 'x'.repeat(16 * 1024) } }), /safety limit/);
  await assert.rejects(client.startTurn({ ...baseTurn, renderers: Array.from({ length: 21 }, (_, index) => `r${index}`) }), /at most 20/);
  await assert.rejects(client.searchCapabilities({}), /query or runId/);
  await assert.rejects(client.completeRun(RUN_ID, {
    assistantMessageId: 'assistant_1', content: 'done', status: 'completed',
    usage: { private_provider_counter: 1 },
  }), /not supported/);
  await assert.rejects(client.completeRun(RUN_ID, {
    assistantMessageId: 'assistant_1', content: 'x'.repeat(64_001), status: 'completed',
  }), /content/);
  await assert.rejects(client.completeRun(RUN_ID, {
    assistantMessageId: 'assistant_1', content: 'done', status: 'completed', model: 'm'.repeat(192),
  }), /model/);
  assert.equal(fetchCalls, 0);
});

test('Agent Client conditionally refreshes once, supports 304, and defaults to HTTPS', async () => {
  const tokenCalls = [];
  const accessTokenProvider = {
    async getAccessToken(forceRefresh = false) {
      tokenCalls.push(forceRefresh);
      return forceRefresh ? 'fresh-token' : 'stale-token';
    },
  };
  const requests = [];
  let fetchCalls = 0;
  const client = new BailingHubAgentClient(connection(accessTokenProvider), {
    fetchImpl: async (_url, init) => {
      fetchCalls += 1;
      requests.push(init);
      return fetchCalls === 1
        ? jsonResponse({ error: 'invalid_request' }, 401)
        : new Response(null, { status: 304, headers: { ETag: '"workspace-2"' } });
    },
  });
  const result = await client.listWorkspaces({ ifNoneMatch: '"workspace-1"' });
  assert.equal(result.not_modified, true);
  assert.equal(result.etag, '"workspace-2"');
  assert.deepEqual(tokenCalls, [false, true]);
  assert.equal(requests[0].headers['If-None-Match'], '"workspace-1"');
  assert.equal(requests[1].headers.Authorization, 'Bearer fresh-token');

  assert.throws(() => new BailingHubAgentClient({
    ...connection(), baseUrl: 'http://hub.example.com',
  }), /Use HTTPS/);
  assert.doesNotThrow(() => new BailingHubAgentClient({
    ...connection(), baseUrl: 'http://hub.example.com',
  }, { allowInsecureHttp: true }));
  assert.doesNotThrow(() => new BailingHubAgentClient({
    ...connection(), baseUrl: 'http://127.0.0.1:8787',
  }));
});

test('Agent invocation errors retain only allowlisted codes and the stable invocation id', async () => {
  const capabilityChanged = new BailingHubAgentClient(connection(), {
    fetchImpl: async () => jsonResponse({
      error: 'capability_changed', message: 'private database trace access-secret',
    }, 409),
  });
  await assert.rejects(capabilityChanged.invoke({
    invocationId: INVOCATION_ID, capabilityRevision: CAPABILITY_REVISION,
    agentRunId: RUN_ID, tool: 'employee_search', arguments: {},
  }), (error) =>
    error instanceof BailingHubClientError &&
    error.publicCode === 'capability_changed' &&
    error.disposition === 'refresh_required' &&
    error.invocationId === INVOCATION_ID &&
    !error.message.includes('private database trace'));

  const uncertain = new BailingHubAgentClient(connection(), {
    fetchImpl: async () => { throw new TypeError('network token secret'); },
  });
  await assert.rejects(uncertain.invoke({
    invocationId: INVOCATION_ID, capabilityRevision: CAPABILITY_REVISION,
    agentRunId: RUN_ID, tool: 'employee_search', arguments: {},
  }), (error) =>
    error instanceof BailingHubClientError &&
    error.disposition === 'accepted_unknown' &&
    error.invocationId === INVOCATION_ID &&
    !error.message.includes('network token secret'));
});

test('Agent Client rejects more than 12 active tools and requires the search schema', async () => {
  const tooMany = new BailingHubAgentClient(connection(), {
    fetchImpl: async () => jsonResponse({
      schema_version: 'bailing.agent-turn-context.v1', run_id: RUN_ID,
      profile_revision: 'f'.repeat(64), capability_revision: CAPABILITY_REVISION,
      context: { instructions: '', memory: null, memory_refs: [], knowledge: [], knowledge_refs: [], governance: {} },
      active_tools: Array.from({ length: 13 }, (_, index) => activeTool(`tool_${index}`)),
    }),
  });
  await assert.rejects(tooMany.startTurn({
    clientConversationId: 'c', clientTurnId: 't', userMessageId: 'm', userInput: 'hello',
  }), /at most 12/);

  const missingSchema = new BailingHubAgentClient(connection(), {
    fetchImpl: async () => jsonResponse({ capability_revision: CAPABILITY_REVISION, tools: [] }),
  });
  await assert.rejects(missingSchema.searchCapabilities({ query: 'employee' }), /unsupported capability search/);
});

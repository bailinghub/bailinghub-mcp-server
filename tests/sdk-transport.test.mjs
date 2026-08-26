import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  AgentConnectionRegistry,
  AgentConnectionStore,
  createAgentClientTransport,
} from '../dist/sdk.js';

const RUN_ID = '22222222-2222-4222-8222-222222222222';
const CAPABILITY_REVISION = 'a'.repeat(64);
const INVOCATION_ID = 'b'.repeat(64);

function credentials(route = 'orders') {
  return {
    schema_version: 1,
    base_url: 'https://hub.example.com',
    client_app_id: 'digital-cloud-agent',
    route,
    session_id: 'session-1',
    access_token: 'access-secret',
    refresh_token: 'refresh-secret',
    access_expires_at: '2099-01-01T00:00:00.000Z',
    refresh_expires_at: '2099-02-01T00:00:00.000Z',
  };
}

function tool() {
  return {
    name: 'employee_search', description: 'Search employees.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
    scope: 'tenant.employee.read', risk: 'low', approval_required: false,
    readonly: true, idempotent: true,
  };
}

async function setup(t) {
  const directory = await mkdtemp(join(tmpdir(), 'bailinghub-sdk-host-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const registry = new AgentConnectionRegistry(join(directory, 'registry.json'));
  const connectionStore = new AgentConnectionStore({
    environment: {
      BAILINGHUB_ALLOW_FILE_CREDENTIAL_STORE: 'true',
      BAILINGHUB_CREDENTIAL_FILE: join(directory, 'legacy.json'),
    },
    platform: 'linux',
    registry,
    credentialPathFor: (key) => join(directory, 'credentials', `${key}.json`),
  });
  const calls = [];
  const fetchImpl = async (url, init) => {
    const path = new URL(String(url)).pathname;
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ path, method: init.method, body });
    if (path === '/agent-auth/v1/session') {
      return new Response(JSON.stringify({
        session_id: 'session-1', client_app_id: 'digital-cloud-agent',
        device_label: 'test', principal: { id: 'user-1' }, on_behalf_of: 'tenant:user-1',
        allowed_routes: ['orders', 'staff'], created_at: '2026-01-01T00:00:00.000Z',
        expires_at: '2099-01-01T00:00:00.000Z', refresh_expires_at: '2099-02-01T00:00:00.000Z',
      }), { status: 200 });
    }
    if (path === '/agent-auth/v1/revoke') return new Response('{}', { status: 200 });
    if (path === '/agent-api/v1/workspaces') {
      return new Response(JSON.stringify({
        schema_version: 'bailing.agent-workspaces.v1',
        workspaces: [{ route: 'orders', name: 'Orders' }, { route: 'staff', name: 'Staff' }],
      }), { status: 200 });
    }
    if (path.endsWith('/turns')) {
      return new Response(JSON.stringify({
        schema_version: 'bailing.agent-turn-context.v1', run_id: RUN_ID,
        profile_revision: 'f'.repeat(64), capability_revision: CAPABILITY_REVISION,
        context: {
          instructions: 'Plan locally.', page_context: {}, renderers: [], memory: null,
          memory_refs: [], knowledge: [], knowledge_refs: [], governance: {},
        },
        active_tools: [tool()],
      }), { status: 200 });
    }
    if (path.endsWith('/capabilities/search')) {
      return new Response(JSON.stringify({
        schema_version: 'bailing.agent-capability-search.v1',
        capability_revision: CAPABILITY_REVISION, tools: [tool()],
      }), { status: 200 });
    }
    if (path === '/agent-api/v1/tool-invocations') {
      return new Response(JSON.stringify({
        schema_version: 'bailing.agent-tool-invocation.v1', invocation_id: body.invocation_id,
        route: body.route, tool: body.tool, state: 'executed', ok: true,
        auto_retry_allowed: false, text: 'done',
      }), { status: 200 });
    }
    if (path.includes('/tool-invocations/') && path.endsWith('/resume')) {
      const invocationId = path.split('/').at(-2);
      return new Response(JSON.stringify({
        schema_version: 'bailing.agent-tool-invocation.v1', invocation_id: invocationId,
        route: 'orders', tool: 'employee_search', state: 'executed', ok: true,
        auto_retry_allowed: false, text: 'done',
      }), { status: 200 });
    }
    if (path.endsWith(`/runs/${RUN_ID}/complete`)) {
      return new Response(JSON.stringify({
        schema_version: 'bailing.agent-run-completion.v1', run_id: RUN_ID, status: body.status,
      }), { status: 200 });
    }
    throw new Error(`Unexpected path: ${path}`);
  };
  const transport = createAgentClientTransport({
    hubUrl: 'https://hub.example.com', clientAppId: 'digital-cloud-agent',
    workspace: 'orders', connectionName: 'development',
  }, {
    connectionStore,
    fetchImpl,
    loginImpl: async (config, dependencies) => {
      const value = credentials(config.route);
      await dependencies.store.save(value);
      return value;
    },
  });
  return { calls, connectionStore, registry, transport };
}

test('SDK subpath exports a dynamic-import factory with the DSH canonical method set', async () => {
  const module = await import('bailinghub-mcp-server/sdk');
  assert.equal(typeof module.createAgentClientTransport, 'function');
  const required = [
    'login', 'status', 'logout', 'workspaces', 'use', 'startTurn',
    'searchCapabilities', 'invoke', 'resume', 'completeRun',
  ];
  const transport = module.createAgentClientTransport({
    hubUrl: 'https://hub.example.com', clientAppId: 'digital-cloud-agent',
    workspace: 'orders', connectionName: 'uninitialized',
  }, {
    connectionStore: new AgentConnectionStore({
      environment: {
        BAILINGHUB_ALLOW_FILE_CREDENTIAL_STORE: 'true',
        BAILINGHUB_CREDENTIAL_FILE: join(tmpdir(), `unused-legacy-${process.pid}-${Date.now()}.json`),
      },
      platform: 'linux',
      registry: new AgentConnectionRegistry(join(tmpdir(), `unused-${process.pid}-${Date.now()}.json`)),
      credentialPathFor: (key) => join(tmpdir(), `unused-${key}.json`),
    }),
  });
  assert.deepEqual(required.filter((name) => typeof transport[name] !== 'function'), []);
});

test('factory login/status/workspaces never expose credentials and keep a readable alias', async (t) => {
  const { calls, registry, transport } = await setup(t);
  const loggedIn = await transport.login();
  assert.equal(loggedIn.state, 'authorized');
  assert.equal(loggedIn.connectionName, 'development');
  assert.equal(JSON.stringify(loggedIn).includes('access-secret'), false);
  assert.equal(JSON.stringify(loggedIn).includes('refresh-secret'), false);
  assert.equal((await registry.getByAlias('development')).workspace, 'orders');

  const status = await transport.status({ connectionName: 'development' });
  assert.equal(status.onBehalfOf, 'tenant:user-1');
  assert.deepEqual(status.allowedWorkspaces, ['orders', 'staff']);
  assert.equal(JSON.stringify(status).includes('secret'), false);
  const workspaces = await transport.workspaces({ connectionName: 'development' });
  assert.deepEqual(workspaces.workspaces.map((entry) => entry.route), ['orders', 'staff']);
  assert.deepEqual(calls.map((entry) => entry.path), [
    '/agent-auth/v1/session', '/agent-api/v1/workspaces',
  ]);
});

test('factory uses startTurn(input, options) and searchCapabilities(input, options) canonical signatures', async (t) => {
  const { calls, transport } = await setup(t);
  await transport.login();
  const started = await transport.startTurn({
    clientConversationId: 'conversation_1', clientTurnId: 'turn_1',
    userMessageId: 'message_1', userInput: 'Find Alice\nthen show team',
    pageContext: { page_key: 'staff' }, renderers: ['bailing-form.v1'],
  }, { workspace: 'orders', connectionName: 'development' });
  assert.equal(started.run_id, RUN_ID);
  const searched = await transport.searchCapabilities({
    query: 'employee', limit: 8, runId: RUN_ID,
  }, { workspace: 'orders', connectionName: 'development' });
  assert.equal(searched.schema, 'bailing.agent-capability-search.v1');

  const turnCall = calls.find((entry) => entry.path.endsWith('/turns'));
  assert.deepEqual(turnCall.body, {
    client_conversation_id: 'conversation_1', client_turn_id: 'turn_1',
    user_message_id: 'message_1', user_input: 'Find Alice\nthen show team',
    page_context: { page_key: 'staff' }, renderers: ['bailing-form.v1'],
  });
  const searchCall = calls.find((entry) => entry.path.endsWith('/capabilities/search'));
  assert.deepEqual(searchCall.body, { query: 'employee', limit: 8, run_id: RUN_ID });
});

test('factory preserves stable 64-hex invocation identity and maps only visible completion fields', async (t) => {
  const { calls, transport } = await setup(t);
  await transport.login();
  const invoked = await transport.invoke({
    invocationId: INVOCATION_ID, capabilityRevision: CAPABILITY_REVISION,
    agentRunId: RUN_ID, tool: 'employee_search', arguments: { query: 'Alice' },
  }, { workspace: 'orders', connectionName: 'development' });
  assert.equal(invoked.invocation_id, INVOCATION_ID);
  const resumed = await transport.resume(
    INVOCATION_ID,
    {},
    { workspace: 'orders', connectionName: 'development' },
  );
  assert.equal(resumed.invocation_id, INVOCATION_ID);
  await transport.completeRun(RUN_ID, {
    status: 'max_tokens',
    assistant: { message_id: 'assistant:1', visible_text: 'Visible final answer.' },
    model: { provider: 'openai', name: 'gpt-test' },
    runtime: { host: 'deepseek-harness', adapter: 'dsh-bailinghub' },
    usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14, provider_private: 99 },
    reasoning: 'private chain', hidden_reasoning: 'private chain',
  }, { workspace: 'orders', connectionName: 'development' });

  const invocationCall = calls.find((entry) => entry.path === '/agent-api/v1/tool-invocations');
  assert.equal(invocationCall.body.invocation_id, INVOCATION_ID);
  const completionCall = calls.find((entry) => entry.path.endsWith('/complete'));
  assert.deepEqual(completionCall.body, {
    assistant_message_id: 'assistant:1',
    content: 'Visible final answer.',
    status: 'failed',
    model: 'openai:gpt-test',
    runtime: 'deepseek-harness:dsh-bailinghub',
    usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 },
  });
  assert.equal(JSON.stringify(calls).includes('private chain'), false);
});

test('factory use moves the alias to an authorized workspace and keeps credentials isolated', async (t) => {
  const { connectionStore, registry, transport } = await setup(t);
  await transport.login();
  const old = await registry.getByAlias('development');
  const selected = await transport.use({ workspace: 'staff', connectionName: 'development' });
  assert.equal(selected.workspace, 'staff');
  const current = await registry.getByAlias('development');
  assert.equal(current.workspace, 'staff');
  assert.notEqual(current.connectionKey, old.connectionKey);
  assert.equal(await connectionStore.credentialStore(old.connectionKey).load(), undefined);
  assert.equal((await connectionStore.load(current.connectionKey)).credentials.route, 'staff');
});

test('factory refuses first login without an explicit or configured workspace', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'bailinghub-sdk-no-workspace-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const transport = createAgentClientTransport({
    hubUrl: 'https://hub.example.com', clientAppId: 'digital-cloud-agent',
    connectionName: 'new-connection',
  }, {
    connectionStore: new AgentConnectionStore({
      environment: {
        BAILINGHUB_ALLOW_FILE_CREDENTIAL_STORE: 'true',
        BAILINGHUB_CREDENTIAL_FILE: join(directory, 'legacy.json'),
      }, platform: 'linux',
      registry: new AgentConnectionRegistry(join(directory, 'registry.json')),
      credentialPathFor: (key) => join(directory, `${key}.json`),
    }),
  });
  await assert.rejects(transport.login(), /workspace is required for the first Agent authorization/);
});

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
    client_app_id: 'example-agent-client',
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
  let loginCount = 0;
  const fetchImpl = async (url, init) => {
    const path = new URL(String(url)).pathname;
    const body = init.body ? JSON.parse(init.body) : undefined;
    const authorization = new Headers(init.headers).get('authorization');
    calls.push({ url: String(url), path, method: init.method, body, authorization });
    if (path === '/agent-auth/v1/session') {
      const identity = authorization?.endsWith('-2') ? '2' : '1';
      return new Response(JSON.stringify({
        session_id: `session-${identity}`, client_app_id: 'example-agent-client',
        device_label: 'test', principal: { id: `user-${identity}` }, on_behalf_of: `tenant:user-${identity}`,
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
    hubUrl: 'https://hub.example.com', clientAppId: 'example-agent-client',
    workspace: 'orders', connectionName: 'development',
  }, {
    connectionStore,
    fetchImpl,
    loginImpl: async (config, dependencies) => {
      loginCount += 1;
      const value = {
        ...credentials(config.route), session_id: `session-${loginCount}`,
        access_token: `access-secret-${loginCount}`,
        refresh_token: `refresh-secret-${loginCount}`,
        base_url: config.baseUrl,
        client_app_id: config.clientAppId,
      };
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
    'connectionsList', 'connectionsAdd', 'connectionsUse', 'connectionsRemove',
    'login', 'status', 'logout', 'workspaces', 'use', 'startTurn',
    'searchCapabilities', 'invoke', 'resume', 'completeRun',
  ];
  const transport = module.createAgentClientTransport({
    hubUrl: 'https://hub.example.com', clientAppId: 'example-agent-client',
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

test('factory manages multiple public connections without exposing credentials', async (t) => {
  const { calls, connectionStore, registry, transport } = await setup(t);
  await transport.login();
  const added = await transport.connectionsAdd({
    connectionName: 'second hub', hubUrl: 'https://other.example.com',
    clientAppId: 'other-agent-client', workspace: 'staff',
  });
  assert.equal(added.state, 'registered');
  assert.equal(added.connection.connectionName, 'second hub');
  assert.equal(added.connection.state, 'logged_out');
  assert.equal(added.connection.current, true);

  const listed = await transport.connectionsList();
  assert.deepEqual(listed.connections.map((entry) => entry.connectionName).sort(), [
    'development', 'second hub',
  ]);
  assert.equal(JSON.stringify(listed).includes('access-secret'), false);
  assert.equal(JSON.stringify(listed).includes('refresh-secret'), false);

  const selected = await transport.connectionsUse('development');
  assert.equal(selected.connection.connectionName, 'development');
  assert.equal((await registry.current()).alias, 'development');

  await transport.connectionsUse('second hub');
  const secondStatus = await transport.status({ connectionName: 'second hub' });
  assert.equal(secondStatus.state, 'logged_out');
  assert.equal(secondStatus.workspace, 'staff');
  await transport.connectionsUse('development');

  const second = await registry.getByAlias('second hub');
  await connectionStore.credentialStore(second.connectionKey).save({
    ...credentials('staff'), base_url: 'https://other.example.com',
    client_app_id: 'other-agent-client', session_id: 'session-2',
  });
  const removed = await transport.connectionsRemove('second hub');
  assert.equal(removed.hadCredentials, true);
  assert.equal(removed.remoteRevoked, true);
  assert.equal(await registry.getByAlias('second hub'), undefined);
  assert.equal(calls.filter((entry) => entry.path === '/agent-auth/v1/revoke').length, 1);
});

test('factory authorizes, switches, rebinds, and revokes same-binding identities independently', async (t) => {
  const { calls, connectionStore, registry, transport } = await setup(t);
  const binding = {
    hubUrl: 'https://hub.example.com', clientAppId: 'example-agent-client', workspace: 'orders',
  };

  const firstAdded = await transport.connectionsAdd({ connectionName: 'identity one', ...binding });
  await transport.login({ connectionName: 'identity one' });
  const secondAdded = await transport.connectionsAdd({ connectionName: 'identity two', ...binding });
  await transport.login({ connectionName: 'identity two' });
  assert.notEqual(firstAdded.connection.connectionKey, secondAdded.connection.connectionKey);

  const first = await registry.getByAlias('identity one');
  const second = await registry.getByAlias('identity two');
  assert.equal(first.baseUrl, second.baseUrl);
  assert.equal(first.clientAppId, second.clientAppId);
  assert.equal(first.workspace, second.workspace);
  assert.notEqual(first.connectionInstanceId, second.connectionInstanceId);
  assert.equal((await connectionStore.load(first.connectionKey)).credentials.session_id, 'session-1');
  assert.equal((await connectionStore.load(second.connectionKey)).credentials.session_id, 'session-2');
  assert.equal((await transport.status({ connectionName: 'identity one' })).onBehalfOf, 'tenant:user-1');
  assert.equal((await transport.status({ connectionName: 'identity two' })).onBehalfOf, 'tenant:user-2');

  const repeated = await transport.connectionsAdd({ connectionName: 'identity one', ...binding });
  assert.equal(repeated.state, 'selected');
  assert.equal(repeated.connection.connectionKey, first.connectionKey);

  await transport.use({ connectionName: 'identity one', workspace: 'staff' });
  const rebound = await registry.getByAlias('identity one');
  assert.equal(rebound.connectionInstanceId, first.connectionInstanceId);
  assert.equal(rebound.workspace, 'staff');
  assert.equal((await registry.getByAlias('identity two')).workspace, 'orders');
  assert.equal((await connectionStore.load(rebound.connectionKey)).credentials.session_id, 'session-1');

  await transport.connectionsRemove('identity one');
  assert.equal(await registry.getByAlias('identity one'), undefined);
  assert.equal((await transport.status({ connectionName: 'identity two' })).onBehalfOf, 'tenant:user-2');
  assert.equal(calls.filter((entry) => entry.path === '/agent-auth/v1/revoke').length, 1);
});

test('factory keeps a connection and credentials when remote revoke fails during removal', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'bailinghub-sdk-remove-failure-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const registry = new AgentConnectionRegistry(join(directory, 'registry.json'));
  const connectionStore = new AgentConnectionStore({
    environment: { BAILINGHUB_ALLOW_FILE_CREDENTIAL_STORE: 'true' }, platform: 'linux', registry,
    credentialPathFor: (key) => join(directory, `${key}.json`),
  });
  const profile = await connectionStore.save(credentials(), { alias: 'protected', makeCurrent: true });
  const transport = createAgentClientTransport({
    hubUrl: 'https://hub.example.com', clientAppId: 'example-agent-client',
    workspace: 'orders', connectionName: 'protected',
  }, {
    connectionStore,
    fetchImpl: async () => new Response('{}', { status: 503 }),
  });
  await assert.rejects(transport.connectionsRemove('protected'), /could not be revoked/);
  assert.equal((await registry.get(profile.connectionKey)).alias, 'protected');
  assert.equal((await connectionStore.load(profile.connectionKey)).credentials.refresh_token, 'refresh-secret');
});

test('factory runs against an explicitly selected connection from a different Hub and client app', async (t) => {
  const { calls, transport } = await setup(t);
  await transport.connectionsAdd({
    connectionName: 'other', hubUrl: 'https://other.example.com',
    clientAppId: 'other-agent-client', workspace: 'staff',
  });
  await transport.login({ connectionName: 'other' });
  const turn = await transport.startTurn({
    clientConversationId: 'conversation_other', clientTurnId: 'turn_other',
    userMessageId: 'message_other', userInput: 'Read staff',
  }, { workspace: 'staff', connectionName: 'other' });
  assert.equal(turn.run_id, RUN_ID);
  const request = calls.find((entry) => entry.path === '/agent-api/v1/workspaces/staff/turns');
  assert.equal(new URL(request.url).origin, 'https://other.example.com');
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

test('factory removes remotely revoked credentials and converges status to logged_out', async (t) => {
  const { connectionStore, registry, transport } = await setup(t);
  await transport.login();
  const profile = await registry.getByAlias('development');
  const revoked = createAgentClientTransport({
    hubUrl: profile.baseUrl, clientAppId: profile.clientAppId,
    workspace: profile.workspace, connectionName: 'development',
  }, {
    connectionStore,
    fetchImpl: async () => new Response('{}', { status: 401 }),
  });

  await assert.rejects(
    revoked.workspaces({ connectionName: 'development' }),
    /login could not be refreshed/,
  );
  assert.equal(await connectionStore.credentialStore(profile.connectionKey).load(), undefined);
  assert.equal((await revoked.status({ connectionName: 'development' })).state, 'logged_out');

  await connectionStore.credentialStore(profile.connectionKey).save(credentials());
  const status = await revoked.status({ connectionName: 'development' });
  assert.equal(status.state, 'logged_out');
  assert.equal(await connectionStore.credentialStore(profile.connectionKey).load(), undefined);
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
    hubUrl: 'https://hub.example.com', clientAppId: 'example-agent-client',
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

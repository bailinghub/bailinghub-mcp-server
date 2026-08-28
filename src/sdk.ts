import { createHash } from 'node:crypto';

import {
  BailingHubAgentClient,
  type AgentCapabilitySearchResult,
  type AgentRunCompletion,
  type AgentTurnContext,
  type AgentWorkspaceList,
  type CompleteAgentRunInput,
  type InvokeAgentCapabilityInput,
  type SearchAgentCapabilitiesInput,
  type StartAgentTurnInput,
} from './agent-client.js';
import type { AgentToolInvocation } from './client.js';
import {
  AgentSessionManager,
  performAgentLogin,
} from './agent-auth.js';
import {
  AgentConnectionStore,
  type AgentConnectionProfile,
  type AgentConnectionStoreOptions,
} from './connections.js';
import { normalizeAgentRoute, normalizeBaseUrl, normalizeClientAppId } from './config.js';

export {
  AgentClientTransport,
  BailingHubAgentClient,
  AGENT_CLIENT_V1_PATHS,
  type AgentCapabilitySearchResult,
  type AgentClientConnection,
  type AgentRunCompletion,
  type AgentRuntimeProfile,
  type AgentTurnContext,
  type AgentWorkspace,
  type AgentWorkspaceList,
  type CompleteAgentRunInput,
  type InvokeAgentCapabilityInput,
  type SearchAgentCapabilitiesInput,
  type StartAgentTurnInput,
} from './agent-client.js';

export {
  AgentConnectionRegistry,
  AgentConnectionStore,
  agentConnectionKey,
  defaultConnectionCredentialPath,
  defaultConnectionRegistryPath,
  type AgentConnectionDescriptor,
  type AgentConnectionProfile,
  type AgentConnectionStoreOptions,
  type LegacyCredentialMigrationResult,
} from './connections.js';

export {
  AgentAuthHttpClient,
  AgentSessionManager,
  createLoopbackCallbackReceiver,
  openSystemBrowser,
  performAgentLogin,
  type AgentAccessTokenProvider,
  type AgentSessionView,
  type LoopbackCallbackReceiver,
} from './agent-auth.js';

export {
  FileCredentialStore,
  MacOsKeychainCredentialStore,
  MemoryCredentialStore,
  parseAgentCredentials,
  selectCredentialStore,
  type AgentCredentials,
  type CredentialStore,
} from './credential-store.js';

export { BailingHubClientError } from './client.js';

const CONNECTION_KEY_PATTERN = /^conn_[a-f0-9]{32}$/;
const INVOCATION_ID_PATTERN = /^[a-f0-9]{64}$/;
const MESSAGE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const USAGE_KEYS = new Set([
  'input_tokens',
  'cached_input_tokens',
  'output_tokens',
  'total_tokens',
  'tool_calls',
  'cost_usd',
]);

export type AgentClientHostConfig = {
  hubUrl?: string;
  baseUrl?: string;
  clientAppId: string;
  workspace?: string;
  route?: string;
  connectionName?: string;
  connectionKey?: string;
  allowInsecureHttp?: boolean;
  deviceLabel?: string;
};

export type AgentClientHostDependencies = {
  connectionStore?: AgentConnectionStore;
  connectionStoreOptions?: AgentConnectionStoreOptions;
  fetchImpl?: typeof fetch;
  now?: () => number;
  loginImpl?: typeof performAgentLogin;
  createLoopbackReceiver?: Parameters<typeof performAgentLogin>[1]['createLoopbackReceiver'];
  openBrowser?: Parameters<typeof performAgentLogin>[1]['openBrowser'];
  randomBytesImpl?: Parameters<typeof performAgentLogin>[1]['randomBytesImpl'];
};

export type AgentClientHostTransport = {
  connectionsList(input?: Record<string, unknown>): Promise<Record<string, unknown>>;
  connectionsAdd(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  connectionsUse(input: string | Record<string, unknown>): Promise<Record<string, unknown>>;
  connectionsRemove(input: string | Record<string, unknown>): Promise<Record<string, unknown>>;
  login(input?: Record<string, unknown>): Promise<Record<string, unknown>>;
  status(input?: Record<string, unknown>): Promise<Record<string, unknown>>;
  logout(input?: Record<string, unknown>): Promise<Record<string, unknown>>;
  workspaces(input?: Record<string, unknown>): Promise<AgentWorkspaceList>;
  use(input: string | Record<string, unknown>): Promise<Record<string, unknown>>;
  startTurn(input: Record<string, unknown>, options?: Record<string, unknown>): Promise<AgentTurnContext>;
  searchCapabilities(input: Record<string, unknown>, options?: Record<string, unknown>): Promise<AgentCapabilitySearchResult>;
  invoke(input: Record<string, unknown>, options?: Record<string, unknown>): Promise<AgentToolInvocation>;
  resume(invocationId: string, input?: unknown, options?: Record<string, unknown>): Promise<AgentToolInvocation>;
  completeRun(runId: string, input: Record<string, unknown>, options?: Record<string, unknown>): Promise<AgentRunCompletion>;
};

function hostRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function hostText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string') throw new TypeError(`${label} must be a string.`);
  const text = value.trim();
  if (!text || text.length > maximum || /[\u0000-\u001f\u007f]/.test(text)) {
    throw new TypeError(`${label} is invalid.`);
  }
  return text;
}

function optionalHostText(value: unknown, label: string, maximum: number): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return hostText(value, label, maximum);
}

function visibleContent(value: unknown, fallback?: string): string {
  if (typeof value === 'string' && value.trim() && value.length <= 64_000 &&
      !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
    return value;
  }
  if (fallback) return fallback;
  throw new TypeError('Visible assistant content is required.');
}

function stableDigest(...parts: string[]): string {
  const hash = createHash('sha256').update('bailinghub.agent-client-host.v1\0');
  for (const part of parts) hash.update(part).update('\0');
  return hash.digest('hex');
}

function normalizedConnectionName(value: unknown): string {
  return optionalHostText(value, 'connectionName', 128) ?? 'default';
}

function modelRuntimeText(value: unknown): string | undefined {
  if (typeof value === 'string') return optionalHostText(value, 'completion metadata', 191);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const parts = [record.provider, record.name, record.host, record.adapter]
    .filter((entry): entry is string => typeof entry === 'string' && Boolean(entry.trim()))
    .map((entry) => entry.trim().replace(/[\u0000-\u001f\u007f]/g, ' '));
  if (parts.length === 0) return undefined;
  return parts.join(':').slice(0, 191);
}

function completionStatus(value: unknown): CompleteAgentRunInput['status'] {
  if (value === 'completed') return 'completed';
  if (value === 'cancelled' || value === 'aborted' || value === 'interrupted') return 'cancelled';
  if (value === 'failed' || value === 'error' || value === 'blocked' || value === 'max_tokens' || value === 'unknown') {
    return 'failed';
  }
  throw new TypeError('completion status is invalid.');
}

function visibleUsage(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return undefined;
  const record = hostRecord(value, 'usage');
  const usage: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(record)) {
    if (!USAGE_KEYS.has(key)) continue;
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) {
      throw new TypeError(`usage.${key} must be a non-negative number.`);
    }
    usage[key] = raw;
  }
  return Object.keys(usage).length > 0 ? usage : undefined;
}

/**
 * Dynamic-import friendly host seam. Browser authorization, credential isolation, HTTP DTOs,
 * and refresh remain SDK concerns; DSH or another host only supplies visible turn data.
 */
export function createAgentClientTransport(
  configValue: AgentClientHostConfig,
  dependencies: AgentClientHostDependencies = {},
): AgentClientHostTransport {
  const allowInsecureHttp = configValue.allowInsecureHttp === true;
  const baseUrl = normalizeBaseUrl(
    hostText(configValue.hubUrl ?? configValue.baseUrl, 'hubUrl', 2_048),
    allowInsecureHttp,
  );
  const clientAppId = normalizeClientAppId(configValue.clientAppId);
  const configuredWorkspace = configValue.workspace ?? configValue.route;
  const defaultWorkspace = configuredWorkspace === undefined
    ? undefined
    : normalizeAgentRoute(configuredWorkspace);
  const defaultConnectionName = normalizedConnectionName(
    configValue.connectionKey ?? configValue.connectionName,
  );
  const connections = dependencies.connectionStore ??
    new AgentConnectionStore(dependencies.connectionStoreOptions);
  const fetchImpl = dependencies.fetchImpl ?? fetch;

  async function resolveProfile(
    selectorValue: unknown,
    workspaceValue?: unknown,
  ): Promise<AgentConnectionProfile> {
    const hasExplicitSelector = typeof selectorValue === 'string' && selectorValue.trim().length > 0;
    const selector = normalizedConnectionName(selectorValue ?? defaultConnectionName);
    let profile = CONNECTION_KEY_PATTERN.test(selector)
      ? await connections.registry.get(selector)
      : await connections.registry.getByAlias(selector);
    const workspace = workspaceValue === undefined
      ? (hasExplicitSelector ? undefined : defaultWorkspace)
      : normalizeAgentRoute(hostText(workspaceValue, 'workspace', 64));
    if (!profile && workspace && !CONNECTION_KEY_PATTERN.test(selector)) {
      profile = await connections.register(
        { baseUrl, clientAppId, workspace, allowInsecureHttp },
        { alias: selector, makeCurrent: true, migrateLegacy: true },
      );
    }
    if (!profile) {
      throw new Error('No Agent connection was found. Run BailingHub login with a workspace first.');
    }
    if (workspace && profile.workspace !== workspace) {
      throw new Error(`Workspace ${workspace} is not selected for this Agent connection. Run use() first.`);
    }
    return profile;
  }

  async function connectionBySelector(selectorValue: unknown): Promise<AgentConnectionProfile> {
    const selector = normalizedConnectionName(selectorValue);
    const profile = CONNECTION_KEY_PATTERN.test(selector)
      ? await connections.registry.get(selector)
      : await connections.registry.getByAlias(selector);
    if (!profile) throw new Error('The Agent connection is not registered.');
    return profile;
  }

  async function publicConnection(
    profile: AgentConnectionProfile,
    currentConnectionKey?: string,
  ): Promise<Record<string, unknown>> {
    const store = connections.credentialStore(profile.connectionKey);
    const stored = await store.load();
    if (stored) await connections.load(profile.connectionKey);
    const loggedIn = Boolean(stored);
    return {
      connectionKey: profile.connectionKey,
      ...(profile.alias ? { connectionName: profile.alias } : {}),
      hubUrl: profile.baseUrl,
      clientAppId: profile.clientAppId,
      workspace: profile.workspace,
      allowInsecureHttp: profile.allowInsecureHttp,
      current: profile.connectionKey === currentConnectionKey,
      state: loggedIn ? 'authorized' : 'logged_out',
      createdAt: profile.createdAt,
      updatedAt: profile.updatedAt,
    };
  }

  async function sessionFor(profile: AgentConnectionProfile): Promise<AgentSessionManager> {
    const store = connections.credentialStore(profile.connectionKey);
    if (!await store.load()) throw new Error('The selected Agent connection is not logged in.');
    return new AgentSessionManager(store, fetchImpl, dependencies.now);
  }

  async function clientFor(
    workspaceValue: unknown,
    options: Record<string, unknown> = {},
  ): Promise<BailingHubAgentClient> {
    const workspace = normalizeAgentRoute(hostText(workspaceValue, 'workspace', 64));
    const profile = await resolveProfile(options.connectionName ?? options.connectionKey, workspace);
    const session = await sessionFor(profile);
    const credentials = await session.loadRequired();
    return new BailingHubAgentClient({
      baseUrl: profile.baseUrl,
      clientAppId: profile.clientAppId,
      workspace,
      sessionId: credentials.session_id,
      accessTokenProvider: session,
    }, { fetchImpl, allowInsecureHttp: profile.allowInsecureHttp });
  }

  return {
    async connectionsList(inputValue = {}) {
      hostRecord(inputValue, 'connectionsList input');
      const [profiles, current] = await Promise.all([
        connections.registry.list(),
        connections.registry.current(),
      ]);
      return {
        currentConnectionKey: current?.connectionKey ?? null,
        connections: await Promise.all(
          profiles.map((profile) => publicConnection(profile, current?.connectionKey)),
        ),
      };
    },

    async connectionsAdd(inputValue) {
      const input = hostRecord(inputValue, 'connectionsAdd input');
      const connectionName = normalizedConnectionName(input.connectionName ?? input.alias);
      const connectionBaseUrl = normalizeBaseUrl(
        hostText(input.hubUrl ?? input.baseUrl, 'hubUrl', 2_048),
        input.allowInsecureHttp === true,
      );
      const connectionClientAppId = normalizeClientAppId(
        hostText(input.clientAppId, 'clientAppId', 64),
      );
      const workspace = normalizeAgentRoute(hostText(input.workspace ?? input.route, 'workspace', 64));
      const profile = await connections.register({
        baseUrl: connectionBaseUrl,
        clientAppId: connectionClientAppId,
        workspace,
        allowInsecureHttp: input.allowInsecureHttp === true,
      }, { alias: connectionName, makeCurrent: true, migrateLegacy: true });
      return {
        state: 'registered',
        connection: await publicConnection(profile, profile.connectionKey),
      };
    },

    async connectionsUse(inputValue) {
      const input = typeof inputValue === 'string'
        ? { connectionName: inputValue }
        : hostRecord(inputValue, 'connectionsUse input');
      const profile = await connectionBySelector(input.connectionName ?? input.connectionKey);
      await connections.registry.setCurrent(profile.connectionKey);
      return {
        state: 'selected',
        connection: await publicConnection(profile, profile.connectionKey),
      };
    },

    async connectionsRemove(inputValue) {
      const input = typeof inputValue === 'string'
        ? { connectionName: inputValue }
        : hostRecord(inputValue, 'connectionsRemove input');
      const profile = await connectionBySelector(input.connectionName ?? input.connectionKey);
      const store = connections.credentialStore(profile.connectionKey);
      if (await store.load()) await connections.load(profile.connectionKey);
      const result = await new AgentSessionManager(
        store,
        fetchImpl,
        dependencies.now,
      ).logout();
      await connections.registry.remove(profile.connectionKey);
      const current = await connections.registry.current();
      return {
        state: 'removed',
        connectionKey: profile.connectionKey,
        ...(profile.alias ? { connectionName: profile.alias } : {}),
        hadCredentials: result.hadCredentials,
        remoteRevoked: result.remoteRevoked,
        currentConnectionKey: current?.connectionKey ?? null,
      };
    },

    async login(inputValue = {}) {
      const input = hostRecord(inputValue, 'login input');
      const alias = normalizedConnectionName(
        input.connectionKey ?? input.connectionName ?? defaultConnectionName,
      );
      const existing = CONNECTION_KEY_PATTERN.test(alias)
        ? await connections.registry.get(alias)
        : await connections.registry.getByAlias(alias);
      const loginBaseUrl = normalizeBaseUrl(
        optionalHostText(input.hubUrl ?? input.baseUrl, 'hubUrl', 2_048) ?? existing?.baseUrl ?? baseUrl,
        input.allowInsecureHttp === true || existing?.allowInsecureHttp === true || allowInsecureHttp,
      );
      const loginClientAppId = normalizeClientAppId(
        optionalHostText(input.clientAppId, 'clientAppId', 64) ?? existing?.clientAppId ?? clientAppId,
      );
      const workspaceValue = input.workspace ?? input.route ?? existing?.workspace ?? defaultWorkspace;
      if (workspaceValue === undefined) {
        throw new Error('workspace is required for the first Agent authorization.');
      }
      const workspace = normalizeAgentRoute(hostText(workspaceValue, 'workspace', 64));
      let profile = await connections.register({
        baseUrl: loginBaseUrl,
        clientAppId: loginClientAppId,
        workspace,
        allowInsecureHttp: input.allowInsecureHttp === true || existing?.allowInsecureHttp === true || allowInsecureHttp,
      }, { makeCurrent: true });
      if (CONNECTION_KEY_PATTERN.test(alias) && profile.connectionKey !== alias) {
        throw new Error('The requested Agent connection key does not match this Hub-client-workspace binding.');
      }
      if (!CONNECTION_KEY_PATTERN.test(alias) && profile.alias && profile.alias !== alias) {
        throw new Error('This Hub-client-workspace binding already has a different connection alias.');
      }
      await connections.migrateLegacy(profile);
      const store = connections.credentialStore(profile.connectionKey);
      const credentials = await (dependencies.loginImpl ?? performAgentLogin)({
        baseUrl: profile.baseUrl,
        clientAppId: profile.clientAppId,
        route: profile.workspace,
        deviceLabel: optionalHostText(input.deviceLabel, 'deviceLabel', 128) ??
          configValue.deviceLabel ?? 'BailingHub Agent Client',
      }, {
        store,
        fetchImpl,
        ...(dependencies.createLoopbackReceiver ? { createLoopbackReceiver: dependencies.createLoopbackReceiver } : {}),
        ...(dependencies.openBrowser ? { openBrowser: dependencies.openBrowser } : {}),
        ...(dependencies.randomBytesImpl ? { randomBytesImpl: dependencies.randomBytesImpl } : {}),
        ...(dependencies.now ? { now: dependencies.now } : {}),
      });
      if (!CONNECTION_KEY_PATTERN.test(alias)) {
        profile = await connections.registry.assignAlias(profile.connectionKey, alias);
      }
      await connections.registry.setCurrent(profile.connectionKey);
      return {
        state: 'authorized',
        connectionKey: profile.connectionKey,
        ...(profile.alias ? { connectionName: profile.alias } : {}),
        workspace: profile.workspace,
        sessionId: credentials.session_id,
        expiresAt: credentials.access_expires_at,
        refreshExpiresAt: credentials.refresh_expires_at,
      };
    },

    async status(inputValue = {}) {
      const input = hostRecord(inputValue, 'status input');
      const profile = await resolveProfile(input.connectionName ?? input.connectionKey);
      const store = connections.credentialStore(profile.connectionKey);
      if (!await store.load()) {
        return {
          state: 'logged_out', connectionKey: profile.connectionKey,
          ...(profile.alias ? { connectionName: profile.alias } : {}), workspace: profile.workspace,
        };
      }
      let session;
      try {
        session = await new AgentSessionManager(store, fetchImpl, dependencies.now).getSession();
      } catch (error) {
        if (await store.load()) throw error;
        return {
          state: 'logged_out', connectionKey: profile.connectionKey,
          ...(profile.alias ? { connectionName: profile.alias } : {}), workspace: profile.workspace,
        };
      }
      return {
        state: 'authorized', connectionKey: profile.connectionKey,
        ...(profile.alias ? { connectionName: profile.alias } : {}),
        workspace: profile.workspace, sessionId: session.session_id,
        onBehalfOf: session.on_behalf_of, allowedWorkspaces: session.allowed_routes,
        expiresAt: session.expires_at, refreshExpiresAt: session.refresh_expires_at,
      };
    },

    async logout(inputValue = {}) {
      const input = hostRecord(inputValue, 'logout input');
      const profile = await resolveProfile(input.connectionName ?? input.connectionKey);
      const result = await new AgentSessionManager(
        connections.credentialStore(profile.connectionKey),
        fetchImpl,
        dependencies.now,
      ).logout();
      return {
        state: 'logged_out', connectionKey: profile.connectionKey,
        ...(profile.alias ? { connectionName: profile.alias } : {}),
        workspace: profile.workspace, hadCredentials: result.hadCredentials,
        remoteRevoked: result.remoteRevoked,
      };
    },

    async workspaces(inputValue = {}) {
      const input = hostRecord(inputValue, 'workspaces input');
      const profile = await resolveProfile(input.connectionName ?? input.connectionKey);
      return (await clientFor(profile.workspace, {
        connectionKey: profile.connectionKey,
      })).listWorkspaces();
    },

    async use(inputValue) {
      const input = typeof inputValue === 'string' ? { workspace: inputValue } : hostRecord(inputValue, 'use input');
      const workspace = normalizeAgentRoute(hostText(input.workspace ?? input.route, 'workspace', 64));
      const selector = input.connectionName ?? input.connectionKey ?? defaultConnectionName;
      const current = await resolveProfile(selector);
      if (current.workspace === workspace) {
        await connections.registry.setCurrent(current.connectionKey);
        return { state: 'selected', connectionKey: current.connectionKey, workspace };
      }
      const currentStore = connections.credentialStore(current.connectionKey);
      const manager = new AgentSessionManager(currentStore, fetchImpl, dependencies.now);
      const session = await manager.getSession();
      if (!session.allowed_routes.includes(workspace)) {
        throw new Error(`The current Agent authorization does not include workspace ${workspace}.`);
      }
      const credentials = await manager.loadRequired();
      let target = await connections.register({
        baseUrl: current.baseUrl,
        clientAppId: current.clientAppId,
        workspace,
        allowInsecureHttp: current.allowInsecureHttp,
      });
      const targetStore = connections.credentialStore(target.connectionKey);
      const alias = CONNECTION_KEY_PATTERN.test(String(selector))
        ? current.alias
        : normalizedConnectionName(selector);
      if (target.alias && alias && target.alias !== alias) {
        throw new Error('The target workspace is already bound to a different connection alias.');
      }
      const existingTarget = await targetStore.load();
      if (existingTarget && existingTarget.session_id !== credentials.session_id) {
        throw new Error('The target workspace already has a different Agent login. Select that connection instead.');
      }
      await targetStore.save({ ...credentials, route: workspace });
      if (alias) target = await connections.registry.assignAlias(target.connectionKey, alias);
      await connections.registry.setCurrent(target.connectionKey);
      await currentStore.delete();
      return {
        state: 'selected', connectionKey: target.connectionKey,
        ...(target.alias ? { connectionName: target.alias } : {}), workspace,
      };
    },

    async startTurn(inputValue, options = {}) {
      const input = hostRecord(inputValue, 'startTurn input');
      const workspace = options.workspace ?? defaultWorkspace;
      if (workspace === undefined) throw new TypeError('workspace is required.');
      const dto: StartAgentTurnInput = {
        clientConversationId: hostText(input.client_conversation_id ?? input.clientConversationId, 'client_conversation_id', 128),
        clientTurnId: hostText(input.client_turn_id ?? input.clientTurnId, 'client_turn_id', 128),
        userMessageId: hostText(input.user_message_id ?? input.userMessageId, 'user_message_id', 128),
        userInput: visibleContent(input.user_input ?? input.userInput),
      };
      if (input.page_context !== undefined || input.pageContext !== undefined) {
        const pageContext = hostRecord(input.page_context ?? input.pageContext, 'page_context');
        if (Buffer.byteLength(JSON.stringify(pageContext), 'utf8') > 16 * 1024) {
          throw new TypeError('page_context must not exceed 16 KiB.');
        }
        dto.pageContext = pageContext;
      }
      const renderers = input.renderers;
      if (renderers !== undefined) {
        if (!Array.isArray(renderers) || renderers.length > 20) {
          throw new TypeError('renderers must contain at most 20 strings.');
        }
        const normalized = renderers.map((item) => hostText(item, 'renderer', 64));
        if (new Set(normalized).size !== normalized.length) {
          throw new TypeError('renderers must be unique.');
        }
        dto.renderers = normalized;
      }
      return (await clientFor(workspace, options)).startTurn(dto);
    },

    async searchCapabilities(inputValue, options = {}) {
      const input = hostRecord(inputValue, 'searchCapabilities input');
      const workspace = options.workspace ?? defaultWorkspace;
      if (workspace === undefined) throw new TypeError('workspace is required.');
      const dto: SearchAgentCapabilitiesInput = {};
      if (input.query !== undefined) dto.query = typeof input.query === 'string' ? input.query : String(input.query);
      const runId = input.run_id ?? input.runId;
      if (runId !== undefined) dto.runId = hostText(runId, 'run_id', 36);
      if (input.limit !== undefined) dto.limit = Number(input.limit);
      return (await clientFor(workspace, options)).searchCapabilities(dto);
    },

    async invoke(inputValue, options = {}) {
      const input = hostRecord(inputValue, 'invoke input');
      const workspace = options.workspace ?? input.workspace ?? input.route ?? defaultWorkspace;
      if (workspace === undefined) throw new TypeError('workspace is required.');
      const runId = hostText(input.run_id ?? input.agent_run_id ?? input.agentRunId, 'run_id', 36);
      const tool = hostText(input.tool_name ?? input.tool ?? input.capability_id, 'tool_name', 64);
      const suppliedInvocation = optionalHostText(
        input.client_invocation_id ?? input.invocation_id ?? input.invocationId,
        'client_invocation_id',
        512,
      );
      const invocationId = suppliedInvocation && INVOCATION_ID_PATTERN.test(suppliedInvocation)
        ? suppliedInvocation
        : stableDigest(String(workspace), runId, tool, suppliedInvocation ?? JSON.stringify(input.arguments ?? {}));
      const dto: InvokeAgentCapabilityInput = {
        invocationId,
        capabilityRevision: hostText(input.capability_revision ?? input.capabilityRevision, 'capability_revision', 128),
        agentRunId: runId,
        tool,
        arguments: hostRecord(input.arguments, 'arguments'),
      };
      return (await clientFor(workspace, options)).invoke(dto);
    },

    async resume(invocationIdValue, _input = {}, options = {}) {
      const workspace = options.workspace ?? defaultWorkspace;
      if (workspace === undefined) throw new TypeError('workspace is required.');
      return (await clientFor(workspace, options)).resume(
        hostText(invocationIdValue, 'invocationId', 64),
      );
    },

    async completeRun(runIdValue, inputValue, options = {}) {
      const workspace = options.workspace ?? defaultWorkspace;
      if (workspace === undefined) throw new TypeError('workspace is required.');
      const input = hostRecord(inputValue, 'completeRun input');
      const assistant = input.assistant && typeof input.assistant === 'object' && !Array.isArray(input.assistant)
        ? input.assistant as Record<string, unknown>
        : undefined;
      const content = visibleContent(
        input.content ?? assistant?.visible_text ?? assistant?.content,
        '[No visible assistant response was produced.]',
      );
      const rawMessageId = input.assistant_message_id ?? input.assistantMessageId ?? assistant?.message_id;
      const assistantMessageId = typeof rawMessageId === 'string' && MESSAGE_ID_PATTERN.test(rawMessageId)
        ? rawMessageId
        : `agent_final_${stableDigest(runIdValue, content).slice(0, 48)}`;
      const dto: CompleteAgentRunInput = {
        assistantMessageId,
        content,
        status: completionStatus(input.status),
      };
      const model = modelRuntimeText(input.model);
      const runtime = modelRuntimeText(input.runtime);
      const usage = visibleUsage(input.usage);
      if (model) dto.model = model;
      if (runtime) dto.runtime = runtime;
      if (usage) dto.usage = usage;
      return (await clientFor(workspace, options)).completeRun(runIdValue, dto);
    },
  };
}

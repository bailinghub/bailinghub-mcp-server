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
  agentConnectionInstanceKey,
  agentConnectionKey,
  type AgentConnectionProfile,
  type AgentConnectionStoreOptions,
} from './connections.js';
import { normalizeAgentRoute, normalizeBaseUrl, normalizeClientAppId } from './config.js';
import {
  LocalAgentOperationLockTimeoutError,
  normalizeAgentStorageNamespace,
} from './credential-store.js';

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
  agentConnectionInstanceKey,
  agentConnectionKey,
  defaultConnectionCredentialPath,
  defaultConnectionKeychainAccount,
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
  AGENT_CLIENT_STORAGE_NAMESPACE_ENV,
  agentStorageNamespaceSegment,
  defaultFileCredentialPath,
  defaultKeychainCredentialAccount,
  normalizeAgentStorageNamespace,
  parseAgentCredentials,
  resolveAgentStorageNamespace,
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
  /**
   * Host-owned local storage namespace. This dependency setting is not a user connection field,
   * business identity, or secret and never enters a Core request.
   */
  storageNamespace?: string;
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

function profileMatches(
  profile: AgentConnectionProfile,
  descriptor: { baseUrl: string; clientAppId: string; workspace: string; allowInsecureHttp: boolean },
): boolean {
  return profile.baseUrl === descriptor.baseUrl &&
    profile.clientAppId === descriptor.clientAppId &&
    profile.workspace === descriptor.workspace &&
    profile.allowInsecureHttp === descriptor.allowInsecureHttp;
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
  let connections: AgentConnectionStore;
  if (dependencies.connectionStore) {
    if (dependencies.storageNamespace !== undefined) {
      const requestedNamespace = normalizeAgentStorageNamespace(dependencies.storageNamespace);
      if (requestedNamespace && requestedNamespace !== dependencies.connectionStore.storageNamespace) {
        throw new Error(
          'The supplied Agent connection store does not match the requested storage namespace.',
        );
      }
    }
    connections = dependencies.connectionStore;
  } else {
    const options = { ...(dependencies.connectionStoreOptions ?? {}) };
    if (dependencies.storageNamespace !== undefined) {
      const requestedNamespace = normalizeAgentStorageNamespace(dependencies.storageNamespace);
      const nestedNamespace = normalizeAgentStorageNamespace(options.storageNamespace);
      if (requestedNamespace && nestedNamespace && nestedNamespace !== requestedNamespace) {
        throw new Error(
          'The Agent Client dependency storage namespace is configured more than once with different values.',
        );
      }
      if (requestedNamespace) options.storageNamespace = requestedNamespace;
    }
    connections = new AgentConnectionStore(options);
  }
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

  function connectionReference(profile: AgentConnectionProfile): Record<string, unknown> {
    return {
      connectionKey: profile.connectionKey,
      ...(profile.alias ? { connectionName: profile.alias } : {}),
    };
  }

  async function reconcileSameIdentityConnections(
    profileValue: AgentConnectionProfile,
    options: { replacementConnectionKey?: string; replacementAlias?: string } = {},
  ): Promise<{
    profile: AgentConnectionProfile;
    identityReconciliation: 'not_needed' | 'distinct' | 'replaced' | 'deferred' | 'cleanup_required';
    cleanupRequired: boolean;
    replacedConnections: Record<string, unknown>[];
    cleanupConnections: Record<string, unknown>[];
    warning?: string;
  }> {
    return connections.withBindingLock(profileValue, async () => {
      let profile = await connections.registry.get(profileValue.connectionKey);
      if (!profile) {
        throw new Error('The newly authorized Agent connection is no longer registered.');
      }
      const profileStore = connections.credentialStore(profile.connectionKey);
      let currentSession;
      try {
        currentSession = await new AgentSessionManager(
          profileStore,
          fetchImpl,
          dependencies.now,
        ).getSession();
      } catch {
        if (!await profileStore.load()) {
          throw new Error('The newly authorized Agent Session became invalid and its local login was removed.');
        }
        try {
          profile = await connections.registry.reconcileToSurvivor(profile.connectionKey, {
            ...(options.replacementAlias
              ? { allocateAliasFrom: options.replacementAlias }
              : {}),
          });
        } catch {
          return {
            profile,
            identityReconciliation: 'cleanup_required',
            cleanupRequired: true,
            replacedConnections: [],
            cleanupConnections: [connectionReference(profile)],
            warning: 'Authorization succeeded, but identity inspection and local connection promotion both need retry. Do not authorize again.',
          };
        }
        return {
          profile,
          identityReconciliation: 'deferred',
          cleanupRequired: true,
          replacedConnections: [],
          cleanupConnections: [],
          warning: 'Authorization succeeded, but same-identity reconciliation was deferred. Do not authorize again; retry status or cleanup later.',
        };
      }

      const activeProfile = profile;
      const candidates = (await connections.registry.list()).filter((candidate) =>
        candidate.connectionKey !== activeProfile.connectionKey &&
        profileMatches(candidate, activeProfile),
      );
      let replacementTarget: AgentConnectionProfile | undefined;
      if (options.replacementAlias) {
        const aliasOwner = await connections.registry.getByAlias(options.replacementAlias);
        if (aliasOwner && aliasOwner.connectionKey !== activeProfile.connectionKey && profileMatches(aliasOwner, activeProfile)) {
          replacementTarget = aliasOwner;
        }
      } else if (options.replacementConnectionKey) {
        const selected = await connections.registry.get(options.replacementConnectionKey);
        if (selected && selected.connectionKey !== activeProfile.connectionKey && profileMatches(selected, activeProfile)) {
          replacementTarget = selected;
        }
      }

      const sameIdentity: AgentConnectionProfile[] = [];
      const deferred: AgentConnectionProfile[] = [];
      const inspectedConnectionKeys = new Set<string>();
      let invalidReplacementTarget: AgentConnectionProfile | undefined;
      let inspectedActiveConnection = false;
      const reconcileMissingReplacement = async (
        candidate: AgentConnectionProfile,
        store: ReturnType<AgentConnectionStore['credentialStore']>,
      ): Promise<'retired' | 'present' | 'deferred'> => {
        if (!store.withRefreshLock) return 'deferred';
        try {
          return await store.withRefreshLock(async () => {
            if (await store.load()) return 'present';
            try {
              profile = await connections.registry.reconcileToSurvivor(activeProfile.connectionKey, {
                retiredConnectionKeys: [candidate.connectionKey],
                ...(options.replacementAlias ? { alias: options.replacementAlias } : {}),
              });
            } catch {
              return 'deferred';
            }
            return 'retired';
          });
        } catch {
          return 'deferred';
        }
      };
      for (const candidate of candidates) {
        const store = connections.credentialStore(candidate.connectionKey);
        let storedCredentials;
        try {
          storedCredentials = await store.load();
        } catch {
          deferred.push(candidate);
          continue;
        }
        if (!storedCredentials) {
          if (candidate.connectionKey !== replacementTarget?.connectionKey) continue;
          const missingState = await reconcileMissingReplacement(candidate, store);
          if (missingState === 'retired') {
            invalidReplacementTarget = candidate;
            continue;
          }
          if (missingState === 'deferred') {
            deferred.push(candidate);
            continue;
          }
        }
        try {
          const session = await new AgentSessionManager(store, fetchImpl, dependencies.now).getSession();
          inspectedActiveConnection = true;
          inspectedConnectionKeys.add(candidate.connectionKey);
          if (session.on_behalf_of === currentSession.on_behalf_of) sameIdentity.push(candidate);
        } catch {
          // Definitively invalid Sessions delete their local credential and do not participate.
          // Transient failures keep the credential and defer all destructive reconciliation.
          let remainingCredentials;
          try {
            remainingCredentials = await store.load();
          } catch {
            deferred.push(candidate);
            continue;
          }
          if (remainingCredentials) {
            deferred.push(candidate);
          } else if (candidate.connectionKey === replacementTarget?.connectionKey) {
            const missingState = await reconcileMissingReplacement(candidate, store);
            if (missingState === 'retired') {
              invalidReplacementTarget = candidate;
            } else {
              deferred.push(candidate);
            }
          }
        }
      }

      if (deferred.length > 0) {
        try {
          profile = await connections.registry.reconcileToSurvivor(profile.connectionKey, {
            ...(invalidReplacementTarget
              ? { retiredConnectionKeys: [invalidReplacementTarget.connectionKey] }
              : {}),
            ...(invalidReplacementTarget && options.replacementAlias
              ? { alias: options.replacementAlias }
              : options.replacementAlias
              ? { allocateAliasFrom: options.replacementAlias }
              : {}),
          });
        } catch {
          return {
            profile,
            identityReconciliation: 'cleanup_required',
            cleanupRequired: true,
            replacedConnections: [],
            cleanupConnections: [
              ...deferred.map(connectionReference),
              ...(invalidReplacementTarget ? [connectionReference(invalidReplacementTarget)] : []),
              connectionReference(profile),
            ],
            warning: 'Authorization succeeded, but an existing login could not be inspected and local promotion needs retry. Do not authorize again.',
          };
        }
        return {
          profile,
          identityReconciliation: 'deferred',
          cleanupRequired: true,
          replacedConnections: invalidReplacementTarget
            ? [connectionReference(invalidReplacementTarget)]
            : [],
          cleanupConnections: deferred.map(connectionReference),
          warning: 'Authorization succeeded, but at least one existing login could not be inspected. No old Session was revoked; do not authorize again.',
        };
      }

      const duplicateByKey = new Map<string, AgentConnectionProfile>();
      for (const candidate of sameIdentity) duplicateByKey.set(candidate.connectionKey, candidate);
      const revoked: AgentConnectionProfile[] = [];
      const cleanup: AgentConnectionProfile[] = [];
      for (const duplicate of duplicateByKey.values()) {
        const manager = new AgentSessionManager(
          connections.credentialStore(duplicate.connectionKey),
          fetchImpl,
          dependencies.now,
        );
        try {
          await manager.logout();
          revoked.push(duplicate);
        } catch {
          cleanup.push(duplicate);
        }
      }

      const replacementWasRevoked = replacementTarget !== undefined &&
        revoked.some((item) => item.connectionKey === replacementTarget.connectionKey);
      const replacementWasInspected = replacementTarget !== undefined &&
        inspectedConnectionKeys.has(replacementTarget.connectionKey);
      const retired = [
        ...revoked,
        ...(invalidReplacementTarget ? [invalidReplacementTarget] : []),
      ];
      try {
        profile = await connections.registry.reconcileToSurvivor(profile.connectionKey, {
          retiredConnectionKeys: retired.map((item) => item.connectionKey),
          ...((replacementWasRevoked || invalidReplacementTarget) && options.replacementAlias
            ? { alias: options.replacementAlias }
            : replacementWasInspected && options.replacementAlias
              ? { allocateAliasFrom: options.replacementAlias }
            : {}),
        });
      } catch {
        const cleanupConnections = [...cleanup, ...retired].map(connectionReference);
        return {
          profile,
          identityReconciliation: 'cleanup_required',
          cleanupRequired: true,
          replacedConnections: [],
          cleanupConnections,
          warning: 'Authorization succeeded and some old Sessions may already be revoked, but local connection cleanup needs retry. Do not authorize again.',
        };
      }

      if (cleanup.length > 0) {
        return {
          profile,
          identityReconciliation: 'cleanup_required',
          cleanupRequired: true,
          replacedConnections: retired.map(connectionReference),
          cleanupConnections: cleanup.map(connectionReference),
          warning: 'Authorization succeeded, but at least one earlier Session could not be revoked. Use connection removal to retry cleanup; do not authorize again.',
        };
      }
      if (retired.length > 0) {
        return {
          profile,
          identityReconciliation: 'replaced',
          cleanupRequired: false,
          replacedConnections: retired.map(connectionReference),
          cleanupConnections: [],
        };
      }
      return {
        profile,
        identityReconciliation: inspectedActiveConnection ? 'distinct' : 'not_needed',
        cleanupRequired: false,
        replacedConnections: [],
        cleanupConnections: [],
      };
    });
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
      const descriptor = {
        baseUrl: connectionBaseUrl,
        clientAppId: connectionClientAppId,
        workspace,
        allowInsecureHttp: input.allowInsecureHttp === true,
      };
      const existing = await connections.registry.getByAlias(connectionName);
      if (existing && !profileMatches(existing, descriptor)) {
        throw new Error('The Agent connection alias is already bound to different public metadata.');
      }
      const profile = existing ?? await connections.registerInstance(
        descriptor,
        { alias: connectionName, makeCurrent: true },
      );
      if (existing) await connections.registry.setCurrent(existing.connectionKey);
      return {
        state: existing ? 'selected' : 'registered',
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
      const descriptor = {
        baseUrl: loginBaseUrl,
        clientAppId: loginClientAppId,
        workspace,
        allowInsecureHttp: input.allowInsecureHttp === true || existing?.allowInsecureHttp === true || allowInsecureHttp,
      };
      if (existing && !profileMatches(existing, descriptor)) {
        throw new Error('The selected Agent connection does not match the requested Hub-client-workspace binding.');
      }
      if (!existing && CONNECTION_KEY_PATTERN.test(alias)) {
        throw new Error('The requested Agent connection key is not registered.');
      }
      let profile = existing ?? (alias === defaultConnectionName
        ? await connections.register(descriptor, { makeCurrent: true })
        : await connections.registerInstance(descriptor, { alias, makeCurrent: true }));
      if (!profile.connectionInstanceId) await connections.migrateLegacy(profile);
      let replacementConnectionKey: string | undefined;
      let replacementAlias: string | undefined;
      if (await connections.credentialStore(profile.connectionKey).load()) {
        // Reauthorization is staged in a fresh credential slot. Cancelling the browser flow can
        // therefore never destroy the selected working Session.
        replacementConnectionKey = profile.connectionKey;
        replacementAlias = profile.alias ?? (!CONNECTION_KEY_PATTERN.test(alias) ? alias : undefined);
        profile = await connections.registerStagingInstance(descriptor);
      }
      const store = connections.credentialStore(profile.connectionKey);
      let credentials;
      try {
        credentials = await (dependencies.loginImpl ?? performAgentLogin)({
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
      } catch (error) {
        if (replacementConnectionKey && !await store.load()) {
          await connections.registry.remove(profile.connectionKey).catch(() => undefined);
        }
        throw error;
      }
      if (!CONNECTION_KEY_PATTERN.test(alias) && !profile.alias) {
        if (!replacementConnectionKey) {
          profile = await connections.registry.assignAlias(profile.connectionKey, alias);
        }
      }
      if (replacementConnectionKey && replacementAlias && !profile.alias) {
        try {
          // Give a safely persisted staged Session a readable selector before network-bound
          // reconciliation. This never steals the selected connection's existing alias.
          profile = await connections.registry.reconcileToSurvivor(profile.connectionKey, {
            allocateAliasFrom: replacementAlias,
          });
        } catch {
          // This promotion is best-effort. The binding-locked reconciliation below retries the
          // same atomic registry write and reports cleanup_required if persistence still fails.
        }
      }
      let reconciliation;
      try {
        reconciliation = await reconcileSameIdentityConnections(profile, {
          ...(replacementConnectionKey ? { replacementConnectionKey } : {}),
          ...(replacementAlias ? { replacementAlias } : {}),
        });
      } catch (error) {
        if (!(error instanceof LocalAgentOperationLockTimeoutError)) throw error;
        const persisted = await store.load();
        const registered = await connections.registry.get(profile.connectionKey);
        if (!persisted || !registered) throw error;
        profile = registered;
        reconciliation = {
          profile,
          identityReconciliation: 'cleanup_required' as const,
          cleanupRequired: true,
          replacedConnections: [],
          cleanupConnections: [],
          warning: 'Authorization succeeded, but same-binding reconciliation is still running in another local process. Do not authorize again; retry status or cleanup later.',
        };
      }
      profile = reconciliation.profile;
      const replacedConnectionNames = reconciliation.replacedConnections
        .flatMap((item) => typeof item.connectionName === 'string' ? [item.connectionName] : []);
      return {
        state: 'authorized',
        connectionKey: profile.connectionKey,
        ...(profile.alias ? { connectionName: profile.alias } : {}),
        workspace: profile.workspace,
        sessionId: credentials.session_id,
        expiresAt: credentials.access_expires_at,
        refreshExpiresAt: credentials.refresh_expires_at,
        identityReconciliation: reconciliation.identityReconciliation,
        cleanupRequired: reconciliation.cleanupRequired,
        replacedConnections: reconciliation.replacedConnections,
        cleanupConnections: reconciliation.cleanupConnections,
        ...(reconciliation.warning ? { warning: reconciliation.warning } : {}),
        ...(replacedConnectionNames.length > 0 ? { replacedConnectionNames } : {}),
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
      const descriptor = {
        baseUrl: current.baseUrl,
        clientAppId: current.clientAppId,
        workspace,
        allowInsecureHttp: current.allowInsecureHttp,
      };
      const targetKey = current.connectionInstanceId
        ? agentConnectionInstanceKey(descriptor, current.connectionInstanceId)
        : agentConnectionKey(descriptor);
      const conflicting = await connections.registry.get(targetKey);
      if (conflicting && conflicting.connectionKey !== current.connectionKey) {
        throw new Error('The target workspace already belongs to another Agent connection instance.');
      }
      const targetStore = connections.credentialStore(targetKey);
      const existingTarget = await targetStore.load();
      if (existingTarget && existingTarget.session_id !== credentials.session_id) {
        throw new Error('The target workspace already has a different Agent login. Select that connection instead.');
      }
      await targetStore.save({ ...credentials, route: workspace });
      let target;
      try {
        target = await connections.registry.rebind(current.connectionKey, descriptor);
      } catch (error) {
        if (!existingTarget) await targetStore.delete().catch(() => undefined);
        throw error;
      }
      await connections.registry.setCurrent(target.connectionKey);
      if (target.connectionKey !== current.connectionKey) await currentStore.delete();
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

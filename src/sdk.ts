import { createHash } from 'node:crypto';
import {
  auditEvents, auditId, auditUuid, CONVERSATION_BATCH_BYTES,
  type ConversationAuditAck, type ConversationAuditEvent, type ConversationAuditCapabilities,
} from './conversation-audit.js';

export type { ConversationAudit, ConversationAuditAck, ConversationAuditEvent, ConversationAuditCapabilities,
  ConversationAuditMemberBinding, CreateConversationAuditInput } from './conversation-audit.js';

import {
  BailingHubAgentClient,
  type AgentCapabilitySearchResult,
  type AgentRunCompletion,
  type AgentTurnContext,
  type AgentWorkspaceList,
  type AgentSystemInfo,
  type CompleteAgentRunInput,
  type InvokeAgentCapabilityInput,
  type SearchAgentCapabilitiesInput,
  type StartAgentTurnInput,
} from './agent-client.js';
import { BailingHubClientError, type AgentToolInvocation } from './client.js';
import {
  AgentSessionManager,
  performAgentLogin,
  type AgentSessionView,
} from './agent-auth.js';
import type { AgentSubjectDisplayBinding } from './subject-display.js';
export type { AgentSubjectDisplay, AgentSubjectDisplayStatus, AgentSubjectDisplayView } from './subject-display.js';
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
  type AgentSystemInfo,
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
  WindowsDpapiCredentialStore,
  AGENT_CLIENT_STORAGE_NAMESPACE_ENV,
  agentStorageNamespaceSegment,
  defaultFileCredentialPath,
  defaultKeychainCredentialAccount,
  defaultWindowsAgentStorageRoot,
  defaultWindowsDpapiCredentialPath,
  defaultWindowsPowerShellPath,
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

/** Host-captured authorization identity; never a model-controlled connection selector. */
export type ExpectedAgentBinding = {
  hubUrl: string;
  clientAppId: string;
  workspace: string;
  sessionId: string;
};

function expectedAgentBinding(value: unknown): ExpectedAgentBinding {
  const input = hostRecord(value, 'expectedBinding');
  return {
    hubUrl: normalizeBaseUrl(hostText(input.hubUrl, 'hubUrl', 2048), true),
    clientAppId: normalizeClientAppId(hostText(input.clientAppId, 'clientAppId', 64)),
    workspace: normalizeAgentRoute(hostText(input.workspace, 'workspace', 64)),
    sessionId: auditUuid(input.sessionId),
  };
}

function callerSignal(value: unknown): AbortSignal | undefined {
  if (value !== undefined && !(value instanceof AbortSignal)) throw new TypeError('signal must be an AbortSignal.');
  return value;
}

function assertRequestActive(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new BailingHubClientError('The Agent request was cancelled before dispatch.',
    499, false, 'agent_request_cancelled', 'definitive_rejection');
}

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
  /** Host-only visible transcript synchronization; never expose this method as a model tool. */
  syncConversationArchive(input: Record<string, unknown>, options: Record<string, unknown>): Promise<ConversationAuditAck>;
  /** Read protocol support without creating an archive or uploading conversation text. */
  getConversationArchiveCapabilities(options: Record<string, unknown>): Promise<ConversationAuditCapabilities>;
  /** Optional product positioning for one explicit selected connection; no tool discovery or run. */
  getSystemInfo(options: Record<string, unknown>): Promise<AgentSystemInfo>;
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

  function signalFetch(signal: AbortSignal | undefined): typeof fetch {
    if (!signal) return fetchImpl;
    return async (url, init) => {
      assertRequestActive(signal);
      const combined = init?.signal ? AbortSignal.any([init.signal, signal]) : signal;
      try {
        return await fetchImpl(url, { ...init, signal: combined });
      } catch (error) {
        if (signal.aborted) throw new BailingHubClientError('The Agent request was cancelled after dispatch.',
          499, false, 'agent_request_cancelled', init?.method === 'POST' ? 'accepted_unknown' : 'definitive_rejection');
        throw error;
      }
    };
  }

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
    const loaded = stored ? await connections.load(profile.connectionKey) : undefined;
    if (loaded && !profileMatches(loaded.profile, profile)) {
      throw new Error('The selected Agent connection binding changed during listing. Retry connectionsList.');
    }
    let display = await cachedSubjectDisplay(profile, loaded?.credentials.session_id);
    const currentCredentials = await store.load();
    if (currentCredentials && (currentCredentials.base_url !== profile.baseUrl ||
        currentCredentials.client_app_id !== profile.clientAppId || currentCredentials.route !== profile.workspace)) {
      throw new Error('The selected Agent credentials do not match their connection binding.');
    }
    if (currentCredentials?.session_id !== loaded?.credentials.session_id) {
      display = await cachedSubjectDisplay(profile);
    }
    const loggedIn = Boolean(currentCredentials);
    return {
      connectionKey: profile.connectionKey,
      ...(profile.alias ? { connectionName: profile.alias } : {}),
      hubUrl: profile.baseUrl,
      clientAppId: profile.clientAppId,
      workspace: profile.workspace,
      allowInsecureHttp: profile.allowInsecureHttp,
      current: profile.connectionKey === currentConnectionKey,
      state: loggedIn ? 'authorized' : 'logged_out',
      ...display,
      createdAt: profile.createdAt,
      updatedAt: profile.updatedAt,
    };
  }

  // Sidecar metadata never participates in registry identity, alias allocation, or credential IO.
  const subjectDisplayCache = connections.registry.subjectDisplayCache;
  const verifiedSubjectDisplays = new Map<string, { sessionId: string; view: Record<string, unknown> }>();
  function displayBinding(profile: AgentConnectionProfile, sessionId: string): AgentSubjectDisplayBinding {
    return { connectionKey: profile.connectionKey, baseUrl: profile.baseUrl, clientAppId: profile.clientAppId,
      workspace: profile.workspace, sessionId };
  }
  async function cachedSubjectDisplay(profile: AgentConnectionProfile, sessionId?: string): Promise<Record<string, unknown>> {
    const empty = { subjectDisplay: null, subjectDisplayStatus: 'unavailable',
      subjectDisplaySource: 'none', subjectDisplayCacheStatus: 'not_cached' };
    if (!sessionId) return empty;
    try {
      const cached = await subjectDisplayCache.load(displayBinding(profile, sessionId));
      return cached ? { ...cached, subjectDisplaySource: 'cache', subjectDisplayCacheStatus: 'saved' } : empty;
    } catch {
      return { ...empty, subjectDisplayCacheStatus: 'storage_error' };
    }
  }
  async function rememberSubjectDisplay(profile: AgentConnectionProfile, session: AgentSessionView): Promise<Record<string, unknown>> {
    const bound = await connections.load(profile.connectionKey);
    if (!profileMatches(bound.profile, profile) || bound.credentials.session_id !== session.session_id ||
        session.client_app_id !== profile.clientAppId || !session.allowed_routes.includes(profile.workspace)) {
      throw new BailingHubClientError('The original Agent connection binding changed.', 403, false, 'agent_binding_changed');
    }
    const display = { subjectDisplay: session.subject_display, subjectDisplayStatus: session.subject_display_status };
    const now = (dependencies.now ?? Date.now)();
    let cacheStatus = display.subjectDisplayStatus === 'unavailable' ? 'not_cached' : 'saved';
    if (cacheStatus === 'saved') {
      try { await subjectDisplayCache.save(displayBinding(profile, session.session_id), display, now); }
      catch { cacheStatus = 'storage_error'; }
    }
    const view = { ...display, subjectDisplaySource: display.subjectDisplayStatus === 'unavailable' ? 'none' : 'verified',
      subjectDisplayCacheStatus: cacheStatus,
      ...(cacheStatus === 'saved' ? { subjectDisplayCachedAt: new Date(now).toISOString() } : {}),
    };
    verifiedSubjectDisplays.set(profile.connectionKey, { sessionId: session.session_id, view });
    return view;
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
        await rememberSubjectDisplay(profile, currentSession);
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

  async function boundSession(connectionKeyValue: unknown, expected: ExpectedAgentBinding, beforeRequest?: () => Promise<void>, signal?: AbortSignal) {
    assertRequestActive(signal);
    const connectionKey = hostText(connectionKeyValue, 'connectionKey', 37);
    if (!CONNECTION_KEY_PATTERN.test(connectionKey)) throw new TypeError('Expected bindings require an exact connection key.');
    const profile = await connections.registry.get(connectionKey);
    assertRequestActive(signal);
    const bindingError = () => new BailingHubClientError(
      'The original Agent connection binding is no longer available.', 403, false, 'agent_binding_changed',
    );
    const matches = (value: AgentConnectionProfile | null | undefined) => value &&
      value.baseUrl === expected.hubUrl && value.clientAppId === expected.clientAppId && value.workspace === expected.workspace;
    if (!matches(profile)) throw bindingError();
    const store = connections.credentialStore(connectionKey);
    const assertBinding = async () => {
      assertRequestActive(signal);
      const current = await connections.registry.get(connectionKey);
      assertRequestActive(signal);
      // Credential identity is the final observation: registry IO must not leave an earlier
      // Session snapshot usable for a refresh or business request after local replacement.
      const credentials = await store.load();
      assertRequestActive(signal);
      if (!matches(current) || !credentials || credentials.session_id !== expected.sessionId ||
          credentials.base_url !== expected.hubUrl || credentials.client_app_id !== expected.clientAppId ||
          credentials.route !== expected.workspace) throw bindingError();
    };
    await assertBinding();
    const checkedFetch: typeof fetch = async (url, init) => {
      // Protect auth refresh/status as well as business requests, immediately before dispatch.
      if (beforeRequest) await beforeRequest();
      await assertBinding();
      if (!String(url).startsWith(`${expected.hubUrl}/`)) throw bindingError();
      assertRequestActive(signal);
      return signalFetch(signal)(url, init);
    };
    const manager = new AgentSessionManager(store, checkedFetch, dependencies.now);
    const client = new BailingHubAgentClient({
      baseUrl: expected.hubUrl, clientAppId: expected.clientAppId, workspace: expected.workspace,
      sessionId: expected.sessionId,
      accessTokenProvider: { getAccessToken: async (forceRefresh) => {
        await assertBinding();
        const token = await manager.getAccessToken(forceRefresh);
        await assertBinding();
        return token;
      } },
    }, { fetchImpl: checkedFetch, allowInsecureHttp: profile!.allowInsecureHttp, ...(signal ? { signal } : {}) });
    return { profile: profile!, manager, client, assertBinding };
  }

  async function prepareArchiveMembers(optionsValue: unknown) {
    const options = hostRecord(optionsValue, 'conversation archive options');
    if (!Array.isArray(options.members) || options.members.length < 1 || options.members.length > 64) {
      throw new TypeError('Conversation archive requires an explicit frozen member set.');
    }
    // Snapshot every primitive before any asynchronous registry/credential read.
    const members = options.members.map((value) => {
      const member = hostRecord(value, 'conversation member');
      const connectionKey = hostText(member.connectionKey, 'connectionKey', 37);
      if (!CONNECTION_KEY_PATTERN.test(connectionKey)) throw new TypeError('Conversation members require exact connection keys.');
      const explicitBinding = member.hubUrl !== undefined || member.clientAppId !== undefined;
      return {
        connectionKey,
        workspace: normalizeAgentRoute(hostText(member.workspace, 'workspace', 64)),
        expectedSessionId: auditUuid(member.expectedSessionId),
        label: optionalHostText(member.label, 'member label', 128),
        expected: explicitBinding ? expectedAgentBinding({ hubUrl: member.hubUrl, clientAppId: member.clientAppId,
          workspace: member.workspace, sessionId: member.expectedSessionId }) : undefined,
      };
    });
    if (new Set(members.map((member) => member.connectionKey)).size !== members.length ||
        new Set(members.map((member) => member.expectedSessionId)).size !== members.length) {
      throw new TypeError('Conversation archive members must be unique.');
    }
    const prepared: Awaited<ReturnType<typeof boundSession>>[] = [];
    const assertAll = async () => { for (const member of prepared) await member.assertBinding(); };
    for (const member of members) {
      const profile = await connections.registry.get(member.connectionKey);
      if (!profile || profile.workspace !== member.workspace) {
        throw new BailingHubClientError('A frozen conversation connection is unavailable.', 403, false, 'agent_binding_changed');
      }
      const expected = member.expected ?? {
        hubUrl: profile.baseUrl, clientAppId: profile.clientAppId, workspace: member.workspace, sessionId: member.expectedSessionId,
      };
      const bound = await boundSession(member.connectionKey, expected, assertAll);
      if (prepared[0] && prepared[0].profile.baseUrl !== profile.baseUrl) throw new TypeError('Conversation archive members must share one Hub.');
      prepared.push(bound);
    }
    const crossBinding = prepared.some((member) => member.profile.clientAppId !== prepared[0]!.profile.clientAppId ||
      member.profile.workspace !== prepared[0]!.profile.workspace);
    if (crossBinding && members.some((member) => !member.expected)) {
      throw new TypeError('Cross-system conversation members require frozen hubUrl and clientAppId.');
    }
    await assertAll();
    return { members, prepared, assertAll, crossBinding };
  }

  async function clientFor(
    workspaceValue: unknown,
    options: Record<string, unknown> = {},
  ): Promise<BailingHubAgentClient> {
    const workspace = normalizeAgentRoute(hostText(workspaceValue, 'workspace', 64));
    const signal = callerSignal(options.signal);
    assertRequestActive(signal);
    if (options.expectedBinding !== undefined) {
      // Copy primitive values before the first await; callers cannot retarget an in-flight request.
      const expected = expectedAgentBinding(options.expectedBinding);
      if (expected.workspace !== workspace || options.connectionName !== undefined) {
        throw new TypeError('Expected binding does not match the explicit target.');
      }
      return (await boundSession(options.connectionKey, expected, undefined, signal)).client;
    }
    const profile = await resolveProfile(options.connectionName ?? options.connectionKey, workspace);
    assertRequestActive(signal);
    const requestFetch = signalFetch(signal);
    const session = signal ? new AgentSessionManager(connections.credentialStore(profile.connectionKey), requestFetch, dependencies.now) : await sessionFor(profile);
    const credentials = await session.loadRequired();
    assertRequestActive(signal);
    return new BailingHubAgentClient({
      baseUrl: profile.baseUrl,
      clientAppId: profile.clientAppId,
      workspace,
      sessionId: credentials.session_id,
      accessTokenProvider: session,
    }, { fetchImpl: requestFetch, allowInsecureHttp: profile.allowInsecureHttp, ...(signal ? { signal } : {}) });
  }

  return {
    async getSystemInfo(optionsValue) {
      const options = hostRecord(optionsValue, 'system information options');
      const connectionKey = hostText(options.connectionKey, 'connectionKey', 37);
      const workspace = normalizeAgentRoute(hostText(options.workspace, 'workspace', 64));
      if (!CONNECTION_KEY_PATTERN.test(connectionKey) || options.connectionName !== undefined) {
        throw new TypeError('System information requires an exact connection key.');
      }
      const signal = callerSignal(options.signal);
      // Snapshot caller-owned primitives before asynchronous registry reads.
      let expected = options.expectedBinding === undefined ? undefined : expectedAgentBinding(options.expectedBinding);
      if (expected && expected.workspace !== workspace) throw new TypeError('Expected binding does not match the explicit target.');
      assertRequestActive(signal);
      if (!expected) {
        const profile = await connections.registry.get(connectionKey);
        const credentials = await connections.credentialStore(connectionKey).load();
        assertRequestActive(signal);
        if (!profile || profile.workspace !== workspace || !credentials) {
          throw new BailingHubClientError('The original Agent connection binding is no longer available.',
            403, false, 'agent_binding_changed');
        }
        expected = { hubUrl: profile.baseUrl, clientAppId: profile.clientAppId, workspace, sessionId: credentials.session_id };
      }
      const bound = await boundSession(connectionKey, expected, undefined, signal);
      try {
        return await bound.client.getSystemInfo();
      } finally {
        // Also reject a replacement that races a failed response: metadata fallback must not hide it.
        await bound.assertBinding();
      }
    },
    async getConversationArchiveCapabilities(optionsValue) {
      const { prepared, assertAll } = await prepareArchiveMembers(optionsValue);
      const capabilities = await prepared[0]!.client.getConversationArchiveCapabilities();
      await assertAll();
      return capabilities;
    },
    async syncConversationArchive(inputValue, optionsValue) {
      const input = hostRecord(inputValue, 'conversation archive');
      const clientArchiveId = auditUuid(input.clientArchiveId);
      const clientConversationId = auditId(input.clientConversationId);
      const events = auditEvents(input.events);
      const { members, prepared, assertAll, crossBinding } = await prepareArchiveMembers(optionsValue);
      for (const event of events) {
        if (event.kind === 'run_link' && !members.some((member) => member.expectedSessionId === event.member_session_id)) {
          throw new TypeError('Conversation run link is outside the frozen member set.');
        }
      }
      const writer = prepared[0]!.client;
      const memberLabels = Object.fromEntries(members.flatMap((member) => member.label ? [[member.expectedSessionId, member.label]] : []));
      let registration = await writer.createConversationAudit({
        clientArchiveId, clientConversationId,
        ...(crossBinding ? { members: members.map((member, index) => ({
          sessionId: member.expectedSessionId, clientAppId: prepared[index]!.profile.clientAppId, workspace: member.workspace,
          ...(member.label ? { label: member.label } : {}),
        })) } : { memberSessionIds: members.map((member) => member.expectedSessionId), memberLabels }),
      });
      for (const member of prepared.slice(1)) {
        registration = await member.client.confirmConversationAudit(registration.conversation_id);
      }
      await assertAll();
      if (registration.state !== 'ready' || registration.member_count !== members.length || registration.confirmed_count !== members.length) {
        throw new Error('The complete conversation membership has not been confirmed.');
      }
      let receipt: ConversationAuditAck = {
        schema: 'bailing.agent-conversation-audit-ack.v1',
        conversation_id: registration.conversation_id, last_sequence: registration.last_sequence,
      };
      let batch: ConversationAuditEvent[] = [];
      const flush = async () => {
        if (!batch.length) return;
        // A local replacement of any member blocks combined-text upload, including after enrollment.
        await assertAll();
        receipt = await writer.appendConversationAuditEvents(registration.conversation_id, batch);
        batch = [];
      };
      for (const event of events) {
        if (batch.length === 50 || Buffer.byteLength(JSON.stringify({ events: [...batch, event] })) > CONVERSATION_BATCH_BYTES) await flush();
        batch.push(event);
      }
      await flush();
      await assertAll();
      return receipt;
    },

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
          onSessionValidated: async (session) => { await rememberSubjectDisplay(profile, session); },
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
        ...(verifiedSubjectDisplays.get(profile.connectionKey)?.sessionId === credentials.session_id
          ? verifiedSubjectDisplays.get(profile.connectionKey)!.view
          : await cachedSubjectDisplay(profile, credentials.session_id)),
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
      const signal = callerSignal(input.signal);
      assertRequestActive(signal);
      if (input.expectedBinding !== undefined) {
        const expected = expectedAgentBinding(input.expectedBinding);
        if (input.connectionName !== undefined || (input.workspace !== undefined && input.workspace !== expected.workspace)) {
          throw new TypeError('Expected binding does not match the explicit target.');
        }
        const bound = await boundSession(input.connectionKey, expected, undefined, signal);
        const session = await bound.manager.getSession();
        await bound.assertBinding();
        if (session.session_id !== expected.sessionId || session.client_app_id !== expected.clientAppId ||
            !session.allowed_routes.includes(expected.workspace)) {
          throw new BailingHubClientError('The original Agent authorization is no longer available.', 403, false, 'agent_binding_changed');
        }
        const display = await rememberSubjectDisplay(bound.profile, session);
        await bound.assertBinding();
        return {
          state: 'authorized', connectionKey: bound.profile.connectionKey,
          ...display,
          ...(bound.profile.alias ? { connectionName: bound.profile.alias } : {}),
          workspace: expected.workspace, sessionId: session.session_id,
          onBehalfOf: session.on_behalf_of, allowedWorkspaces: session.allowed_routes,
          expiresAt: session.expires_at, refreshExpiresAt: session.refresh_expires_at,
        };
      }
      const profile = await resolveProfile(input.connectionName ?? input.connectionKey);
      assertRequestActive(signal);
      const store = connections.credentialStore(profile.connectionKey);
      if (!await store.load()) {
        return {
          state: 'logged_out', connectionKey: profile.connectionKey,
          ...await cachedSubjectDisplay(profile),
          ...(profile.alias ? { connectionName: profile.alias } : {}), workspace: profile.workspace,
        };
      }
      let session;
      try {
        session = await new AgentSessionManager(store, signalFetch(signal), dependencies.now).getSession();
        assertRequestActive(signal);
      } catch (error) {
        if (await store.load()) throw error;
        return {
          state: 'logged_out', connectionKey: profile.connectionKey,
          ...await cachedSubjectDisplay(profile),
          ...(profile.alias ? { connectionName: profile.alias } : {}), workspace: profile.workspace,
        };
      }
      const display = await rememberSubjectDisplay(profile, session);
      assertRequestActive(signal);
      return {
        state: 'authorized', connectionKey: profile.connectionKey,
        ...display,
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

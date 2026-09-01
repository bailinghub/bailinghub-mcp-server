import { createHash, randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve, win32 as windowsPath } from 'node:path';

import { normalizeAgentRoute, normalizeBaseUrl, normalizeClientAppId } from './config.js';
import {
  agentStorageNamespaceSegment,
  defaultWindowsAgentStorageRoot,
  FileCredentialStore,
  LocalAgentOperationLock,
  MacOsKeychainCredentialStore,
  parseAgentCredentials,
  resolveAgentStorageNamespace,
  runCommand,
  selectCredentialStore,
  WindowsDpapiCredentialStore,
  type AgentCredentials,
  type CommandRunner,
  type CredentialStore,
} from './credential-store.js';

const CONNECTION_KEY_PATTERN = /^conn_[a-f0-9]{32}$/;
const CONNECTION_INSTANCE_PATTERN = /^instance_[a-f0-9]{32}$/;
const MAX_CONNECTIONS = 256;
const MAX_METADATA_BYTES = 256 * 1024;

export type AgentConnectionDescriptor = {
  baseUrl: string;
  clientAppId: string;
  workspace: string;
  allowInsecureHttp?: boolean;
};

export type AgentConnectionProfile = Omit<AgentConnectionDescriptor, 'allowInsecureHttp'> & {
  connectionKey: string;
  connectionInstanceId?: string;
  alias?: string;
  allowInsecureHttp: boolean;
  createdAt: string;
  updatedAt: string;
};

type StoredConnection = {
  connection_key: string;
  connection_instance_id?: string;
  base_url: string;
  client_app_id: string;
  workspace: string;
  alias?: string;
  allow_insecure_http?: boolean;
  created_at: string;
  updated_at: string;
};

type ConnectionRegistryDocument = {
  schema_version: 1 | 2;
  current_connection_key?: string;
  connections: StoredConnection[];
};

export type LegacyCredentialMigrationResult =
  | 'migrated'
  | 'no_legacy_credentials'
  | 'legacy_connection_mismatch'
  | 'target_already_exists';

function normalizedDescriptor(value: AgentConnectionDescriptor): AgentConnectionDescriptor {
  const allowInsecureHttp = value.allowInsecureHttp === true;
  return {
    baseUrl: normalizeBaseUrl(value.baseUrl, allowInsecureHttp),
    clientAppId: normalizeClientAppId(value.clientAppId),
    workspace: normalizeAgentRoute(value.workspace),
    allowInsecureHttp,
  };
}

function connectionAlias(value: unknown): string {
  if (typeof value !== 'string') throw new Error('The Agent connection alias must be a string.');
  const alias = value.trim();
  if (!alias || alias.length > 128 || /[\u0000-\u001f\u007f]/.test(alias)) {
    throw new Error('The Agent connection alias is invalid.');
  }
  return alias;
}

export function agentConnectionKey(value: AgentConnectionDescriptor): string {
  return agentConnectionKeyFor(value);
}

/** Derives the isolated credential key for one named instance of a public connection binding. */
export function agentConnectionInstanceKey(
  value: AgentConnectionDescriptor,
  connectionInstanceId: string,
): string {
  return agentConnectionKeyFor(value, connectionInstanceId);
}

function agentConnectionKeyFor(
  value: AgentConnectionDescriptor,
  connectionInstanceId?: string,
): string {
  const descriptor = normalizedDescriptor(value);
  if (connectionInstanceId !== undefined && !CONNECTION_INSTANCE_PATTERN.test(connectionInstanceId)) {
    throw new Error('The Agent connection instance id is invalid.');
  }
  return `conn_${createHash('sha256')
    .update(connectionInstanceId === undefined
      ? 'bailinghub.agent-connection.v1\0'
      : 'bailinghub.agent-connection.v2\0')
    .update(descriptor.baseUrl)
    .update('\0')
    .update(descriptor.clientAppId)
    .update('\0')
    .update(descriptor.workspace)
    .update(connectionInstanceId === undefined ? '' : `\0${connectionInstanceId}`)
    .digest('hex')
    .slice(0, 32)}`;
}

function newConnectionInstanceId(): string {
  return `instance_${randomBytes(16).toString('hex')}`;
}

function timestamp(value: unknown, label: string): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new Error(`Stored Agent connection ${label} is invalid.`);
  }
  return value;
}

function parseStoredConnection(value: unknown, schemaVersion: 1 | 2): AgentConnectionProfile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Stored Agent connection metadata is invalid.');
  }
  const item = value as Record<string, unknown>;
  const allowedFields = new Set([
    'connection_key', 'connection_instance_id', 'base_url', 'client_app_id', 'workspace', 'alias',
    'allow_insecure_http', 'created_at', 'updated_at',
  ]);
  if (
    Object.keys(item).some((key) => !allowedFields.has(key)) ||
    typeof item.connection_key !== 'string' ||
    !CONNECTION_KEY_PATTERN.test(item.connection_key) ||
    (item.connection_instance_id !== undefined &&
      (schemaVersion !== 2 || typeof item.connection_instance_id !== 'string' ||
        !CONNECTION_INSTANCE_PATTERN.test(item.connection_instance_id))) ||
    typeof item.base_url !== 'string' ||
    typeof item.client_app_id !== 'string' ||
    typeof item.workspace !== 'string' ||
    (item.allow_insecure_http !== undefined && typeof item.allow_insecure_http !== 'boolean')
  ) {
    throw new Error('Stored Agent connection metadata is invalid.');
  }
  const descriptor = normalizedDescriptor({
    baseUrl: item.base_url,
    clientAppId: item.client_app_id,
    workspace: item.workspace,
    allowInsecureHttp: item.allow_insecure_http === true,
  });
  const connectionInstanceId = typeof item.connection_instance_id === 'string'
    ? item.connection_instance_id
    : undefined;
  if (agentConnectionKeyFor(descriptor, connectionInstanceId) !== item.connection_key) {
    throw new Error('Stored Agent connection metadata has an invalid binding.');
  }
  return {
    ...descriptor,
    connectionKey: item.connection_key,
    ...(connectionInstanceId ? { connectionInstanceId } : {}),
    ...(item.alias !== undefined ? { alias: connectionAlias(item.alias) } : {}),
    allowInsecureHttp: descriptor.allowInsecureHttp === true,
    createdAt: timestamp(item.created_at, 'created_at'),
    updatedAt: timestamp(item.updated_at, 'updated_at'),
  };
}

function serializeProfile(profile: AgentConnectionProfile): StoredConnection {
  return {
    connection_key: profile.connectionKey,
    ...(profile.connectionInstanceId ? { connection_instance_id: profile.connectionInstanceId } : {}),
    base_url: profile.baseUrl,
    client_app_id: profile.clientAppId,
    workspace: profile.workspace,
    ...(profile.alias ? { alias: profile.alias } : {}),
    ...(profile.allowInsecureHttp ? { allow_insecure_http: true } : {}),
    created_at: profile.createdAt,
    updated_at: profile.updatedAt,
  };
}

function registrySchemaVersion(connections: AgentConnectionProfile[]): 1 | 2 {
  return connections.some((profile) => profile.connectionInstanceId !== undefined) ? 2 : 1;
}

function parseRegistry(value: unknown): {
  currentConnectionKey?: string;
  connections: AgentConnectionProfile[];
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Stored Agent connection registry is invalid.');
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).some((key) => !['schema_version', 'current_connection_key', 'connections'].includes(key)) ||
    (record.schema_version !== 1 && record.schema_version !== 2) ||
    !Array.isArray(record.connections) ||
    record.connections.length > MAX_CONNECTIONS
  ) {
    throw new Error('Stored Agent connection registry is invalid.');
  }
  const schemaVersion = record.schema_version as 1 | 2;
  const connections = record.connections.map((item) => parseStoredConnection(item, schemaVersion));
  if (new Set(connections.map((item) => item.connectionKey)).size !== connections.length) {
    throw new Error('Stored Agent connection registry contains duplicates.');
  }
  const instanceIds = connections.flatMap((item) => item.connectionInstanceId ? [item.connectionInstanceId] : []);
  if (new Set(instanceIds).size !== instanceIds.length) {
    throw new Error('Stored Agent connection registry contains duplicate instances.');
  }
  const aliases = connections.flatMap((item) => item.alias ? [item.alias] : []);
  if (new Set(aliases).size !== aliases.length) {
    throw new Error('Stored Agent connection registry contains duplicate aliases.');
  }
  const current = record.current_connection_key;
  if (current !== undefined) {
    if (typeof current !== 'string' || !CONNECTION_KEY_PATTERN.test(current) || !connections.some((item) => item.connectionKey === current)) {
      throw new Error('Stored current Agent connection is invalid.');
    }
  }
  return {
    ...(typeof current === 'string' ? { currentConnectionKey: current } : {}),
    connections,
  };
}

function defaultConnectionStorageRoot(
  storageNamespace?: string,
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  if (platform === 'win32') {
    return defaultWindowsAgentStorageRoot(storageNamespace, environment);
  }
  const segment = agentStorageNamespaceSegment(storageNamespace);
  return segment
    ? join(homedir(), '.config', 'bailinghub', 'hosts', segment)
    : join(homedir(), '.config', 'bailinghub');
}

export function defaultConnectionRegistryPath(
  storageNamespace?: string,
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const root = defaultConnectionStorageRoot(storageNamespace, platform, environment);
  return platform === 'win32'
    ? windowsPath.join(root, 'agent-connections.json')
    : join(root, 'agent-connections.json');
}

export function defaultConnectionCredentialPath(
  connectionKey: string,
  storageNamespace?: string,
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  if (!CONNECTION_KEY_PATTERN.test(connectionKey)) throw new Error('The Agent connection key is invalid.');
  const root = defaultConnectionStorageRoot(storageNamespace, platform, environment);
  return platform === 'win32'
    ? windowsPath.join(root, 'agent-connections', `${connectionKey}.dpapi`)
    : join(root, 'agent-connections', `${connectionKey}.json`);
}

export function defaultConnectionKeychainAccount(
  connectionKey: string,
  storageNamespace?: string,
): string {
  if (!CONNECTION_KEY_PATTERN.test(connectionKey)) throw new Error('The Agent connection key is invalid.');
  const segment = agentStorageNamespaceSegment(storageNamespace);
  return segment
    ? `${segment}-connection-${connectionKey}`
    : `connection-${connectionKey}`;
}

/** Public connection metadata only. Tokens are always stored by a separate CredentialStore. */
export class AgentConnectionRegistry {
  private readonly path: string;
  private readonly mutationLock: LocalAgentOperationLock;
  readonly operationScope: string;

  constructor(
    path = defaultConnectionRegistryPath(),
    private readonly platform: NodeJS.Platform = process.platform,
  ) {
    this.path = resolve(path);
    this.operationScope = `registry:${this.path}`;
    this.mutationLock = new LocalAgentOperationLock(this.operationScope);
  }

  async list(): Promise<AgentConnectionProfile[]> {
    return (await this.read()).connections;
  }

  async current(): Promise<AgentConnectionProfile | undefined> {
    const registry = await this.read();
    return registry.currentConnectionKey
      ? registry.connections.find((item) => item.connectionKey === registry.currentConnectionKey)
      : undefined;
  }

  async get(connectionKey: string): Promise<AgentConnectionProfile | undefined> {
    if (!CONNECTION_KEY_PATTERN.test(connectionKey)) throw new Error('The Agent connection key is invalid.');
    return (await this.read()).connections.find((item) => item.connectionKey === connectionKey);
  }

  async getByAlias(aliasValue: string): Promise<AgentConnectionProfile | undefined> {
    const alias = connectionAlias(aliasValue);
    return (await this.read()).connections.find((item) => item.alias === alias);
  }

  async upsert(
    descriptorValue: AgentConnectionDescriptor,
    options: { alias?: string; makeCurrent?: boolean; now?: () => Date } = {},
  ): Promise<AgentConnectionProfile> {
    return this.mutationLock.withLock(async () => {
      const descriptor = normalizedDescriptor(descriptorValue);
      const connectionKey = agentConnectionKey(descriptor);
      const registry = await this.read();
      const old = registry.connections.find((item) => item.connectionKey === connectionKey);
      const alias = options.alias !== undefined ? connectionAlias(options.alias) : old?.alias;
      if (alias && registry.connections.some((item) => item.alias === alias && item.connectionKey !== connectionKey)) {
        throw new Error('The Agent connection alias is already in use.');
      }
      const now = (options.now ?? (() => new Date()))().toISOString();
      const profile: AgentConnectionProfile = {
        ...descriptor,
        connectionKey,
        ...(alias ? { alias } : {}),
        allowInsecureHttp: descriptor.allowInsecureHttp === true,
        createdAt: old?.createdAt ?? now,
        updatedAt: now,
      };
      const connections = [
        ...registry.connections.filter((item) => item.connectionKey !== connectionKey),
        profile,
      ].sort((left, right) => left.connectionKey.localeCompare(right.connectionKey));
      if (connections.length > MAX_CONNECTIONS) throw new Error('The Agent connection registry is full.');
      await this.write({
        schema_version: registrySchemaVersion(connections),
        ...((options.makeCurrent || registry.currentConnectionKey === connectionKey)
          ? { current_connection_key: connectionKey }
          : registry.currentConnectionKey
            ? { current_connection_key: registry.currentConnectionKey }
            : {}),
        connections: connections.map(serializeProfile),
      });
      return profile;
    });
  }

  async createInstance(
    descriptorValue: AgentConnectionDescriptor,
    options: { alias?: string; makeCurrent?: boolean; now?: () => Date; instanceId?: string } = {},
  ): Promise<AgentConnectionProfile> {
    return this.mutationLock.withLock(async () => {
      const descriptor = normalizedDescriptor(descriptorValue);
      const alias = options.alias === undefined ? undefined : connectionAlias(options.alias);
      const registry = await this.read();
      if (alias && registry.connections.some((item) => item.alias === alias)) {
        throw new Error('The Agent connection alias is already in use.');
      }
      let connectionInstanceId = options.instanceId ?? newConnectionInstanceId();
      let connectionKey = agentConnectionKeyFor(descriptor, connectionInstanceId);
      if (options.instanceId !== undefined && !CONNECTION_INSTANCE_PATTERN.test(options.instanceId)) {
        throw new Error('The Agent connection instance id is invalid.');
      }
      for (let attempt = 0; registry.connections.some((item) =>
        item.connectionKey === connectionKey || item.connectionInstanceId === connectionInstanceId
      ); attempt += 1) {
        if (options.instanceId !== undefined || attempt >= 3) {
          throw new Error('Could not allocate a unique Agent connection instance.');
        }
        connectionInstanceId = newConnectionInstanceId();
        connectionKey = agentConnectionKeyFor(descriptor, connectionInstanceId);
      }
      const now = (options.now ?? (() => new Date()))().toISOString();
      const profile: AgentConnectionProfile = {
        ...descriptor,
        connectionKey,
        connectionInstanceId,
        ...(alias ? { alias } : {}),
        allowInsecureHttp: descriptor.allowInsecureHttp === true,
        createdAt: now,
        updatedAt: now,
      };
      const connections = [...registry.connections, profile]
        .sort((left, right) => left.connectionKey.localeCompare(right.connectionKey));
      if (connections.length > MAX_CONNECTIONS) throw new Error('The Agent connection registry is full.');
      await this.write({
        schema_version: registrySchemaVersion(connections),
        ...((options.makeCurrent || !registry.currentConnectionKey)
          ? { current_connection_key: connectionKey }
          : { current_connection_key: registry.currentConnectionKey }),
        connections: connections.map(serializeProfile),
      });
      return profile;
    });
  }

  async rebind(
    connectionKey: string,
    descriptorValue: AgentConnectionDescriptor,
    options: { now?: () => Date } = {},
  ): Promise<AgentConnectionProfile> {
    return this.mutationLock.withLock(async () => {
      if (!CONNECTION_KEY_PATTERN.test(connectionKey)) throw new Error('The Agent connection key is invalid.');
      const registry = await this.read();
      const current = registry.connections.find((item) => item.connectionKey === connectionKey);
      if (!current) throw new Error('The Agent connection is not registered.');
      const descriptor = normalizedDescriptor(descriptorValue);
      const nextConnectionKey = agentConnectionKeyFor(descriptor, current.connectionInstanceId);
      if (registry.connections.some((item) => item.connectionKey === nextConnectionKey && item.connectionKey !== connectionKey)) {
        throw new Error('The target Agent connection binding already exists.');
      }
      const profile: AgentConnectionProfile = {
        ...descriptor,
        connectionKey: nextConnectionKey,
        ...(current.connectionInstanceId ? { connectionInstanceId: current.connectionInstanceId } : {}),
        ...(current.alias ? { alias: current.alias } : {}),
        allowInsecureHttp: descriptor.allowInsecureHttp === true,
        createdAt: current.createdAt,
        updatedAt: (options.now ?? (() => new Date()))().toISOString(),
      };
      const connections = registry.connections
        .map((item) => item.connectionKey === connectionKey ? profile : item)
        .sort((left, right) => left.connectionKey.localeCompare(right.connectionKey));
      await this.write({
        schema_version: registrySchemaVersion(connections),
        ...(registry.currentConnectionKey
          ? { current_connection_key: registry.currentConnectionKey === connectionKey
              ? nextConnectionKey
              : registry.currentConnectionKey }
          : {}),
        connections: connections.map(serializeProfile),
      });
      return profile;
    });
  }

  async setCurrent(connectionKey: string): Promise<void> {
    await this.mutationLock.withLock(async () => {
      if (!CONNECTION_KEY_PATTERN.test(connectionKey)) throw new Error('The Agent connection key is invalid.');
      const registry = await this.read();
      if (!registry.connections.some((item) => item.connectionKey === connectionKey)) {
        throw new Error('The Agent connection is not registered.');
      }
      await this.write({
        schema_version: registrySchemaVersion(registry.connections),
        current_connection_key: connectionKey,
        connections: registry.connections.map(serializeProfile),
      });
    });
  }

  async assignAlias(connectionKey: string, aliasValue: string): Promise<AgentConnectionProfile> {
    return this.mutationLock.withLock(async () => {
      if (!CONNECTION_KEY_PATTERN.test(connectionKey)) throw new Error('The Agent connection key is invalid.');
      const alias = connectionAlias(aliasValue);
      const registry = await this.read();
      const target = registry.connections.find((item) => item.connectionKey === connectionKey);
      if (!target) throw new Error('The Agent connection is not registered.');
      const now = new Date().toISOString();
      const connections: AgentConnectionProfile[] = registry.connections.map((item) => {
        if (item.connectionKey === connectionKey) return { ...item, alias, updatedAt: now };
        if (item.alias === alias) {
          const { alias: _removed, ...withoutAlias } = item;
          return withoutAlias;
        }
        return item;
      });
      await this.write({
        schema_version: registrySchemaVersion(connections),
        ...(registry.currentConnectionKey ? { current_connection_key: registry.currentConnectionKey } : {}),
        connections: connections.map(serializeProfile),
      });
      return connections.find((item) => item.connectionKey === connectionKey)!;
    });
  }

  async remove(connectionKey: string): Promise<void> {
    await this.mutationLock.withLock(async () => {
      if (!CONNECTION_KEY_PATTERN.test(connectionKey)) throw new Error('The Agent connection key is invalid.');
      const registry = await this.read();
      const connections = registry.connections
        .filter((item) => item.connectionKey !== connectionKey)
        .sort((left, right) => left.connectionKey.localeCompare(right.connectionKey));
      if (connections.length === registry.connections.length) return;
      const nextCurrent = registry.currentConnectionKey === connectionKey
        ? connections[0]?.connectionKey
        : registry.currentConnectionKey;
      await this.write({
        schema_version: registrySchemaVersion(connections),
        ...(nextCurrent ? { current_connection_key: nextCurrent } : {}),
        connections: connections.map(serializeProfile),
      });
    });
  }

  /**
   * Atomically promotes one already-authorized candidate and retires metadata for Sessions that
   * were successfully revoked. Alias ownership may move only within the same public binding.
   */
  async reconcileToSurvivor(
    survivorConnectionKey: string,
    options: {
      retiredConnectionKeys?: string[];
      alias?: string;
      allocateAliasFrom?: string;
      makeCurrent?: boolean;
    } = {},
  ): Promise<AgentConnectionProfile> {
    return this.mutationLock.withLock(async () => {
      if (!CONNECTION_KEY_PATTERN.test(survivorConnectionKey)) {
        throw new Error('The Agent connection key is invalid.');
      }
      const retiredConnectionKeys = [...new Set(options.retiredConnectionKeys ?? [])];
      if (retiredConnectionKeys.some((key) =>
        !CONNECTION_KEY_PATTERN.test(key) || key === survivorConnectionKey
      )) {
        throw new Error('The retired Agent connection keys are invalid.');
      }
      if (options.alias !== undefined && options.allocateAliasFrom !== undefined) {
        throw new Error('The Agent connection alias options are mutually exclusive.');
      }
      let alias = options.alias === undefined ? undefined : connectionAlias(options.alias);
      const aliasBase = options.allocateAliasFrom === undefined
        ? undefined
        : connectionAlias(options.allocateAliasFrom);
      const registry = await this.read();
      const survivor = registry.connections.find((item) => item.connectionKey === survivorConnectionKey);
      if (!survivor) throw new Error('The surviving Agent connection is not registered.');
      const sameBinding = (profile: AgentConnectionProfile) =>
        profile.baseUrl === survivor.baseUrl &&
        profile.clientAppId === survivor.clientAppId &&
        profile.workspace === survivor.workspace &&
        profile.allowInsecureHttp === survivor.allowInsecureHttp;
      const retired = registry.connections.filter((item) =>
        retiredConnectionKeys.includes(item.connectionKey)
      );
      if (retired.some((item) => !sameBinding(item))) {
        throw new Error('A retired Agent connection belongs to a different public binding.');
      }
      if (aliasBase && !survivor.alias) {
        for (let index = 2; index <= MAX_CONNECTIONS + 1; index += 1) {
          const suffix = `-${index}`;
          const candidate = `${aliasBase.slice(0, 128 - suffix.length)}${suffix}`;
          if (!registry.connections.some((item) => item.alias === candidate)) {
            alias = candidate;
            break;
          }
        }
        if (!alias) throw new Error('Could not allocate a unique Agent connection alias.');
      }
      if (alias) {
        const aliasOwner = registry.connections.find((item) => item.alias === alias);
        if (aliasOwner && aliasOwner.connectionKey !== survivorConnectionKey &&
            !retiredConnectionKeys.includes(aliasOwner.connectionKey)) {
          throw new Error('The Agent connection alias is already in use.');
        }
      }
      const now = new Date().toISOString();
      const connections = registry.connections
        .filter((item) => !retiredConnectionKeys.includes(item.connectionKey))
        .map((item): AgentConnectionProfile => {
          if (item.connectionKey === survivorConnectionKey) {
            return {
              ...item,
              ...(alias ? { alias } : {}),
              updatedAt: now,
            };
          }
          return item;
        })
        .sort((left, right) => left.connectionKey.localeCompare(right.connectionKey));
      const nextSurvivor = connections.find((item) => item.connectionKey === survivorConnectionKey);
      if (!nextSurvivor) throw new Error('The surviving Agent connection was removed unexpectedly.');
      const currentConnectionKey = options.makeCurrent === false &&
        registry.currentConnectionKey &&
        connections.some((item) => item.connectionKey === registry.currentConnectionKey)
        ? registry.currentConnectionKey
        : survivorConnectionKey;
      await this.write({
        schema_version: registrySchemaVersion(connections),
        current_connection_key: currentConnectionKey,
        connections: connections.map(serializeProfile),
      });
      return nextSurvivor;
    });
  }

  private async read(): Promise<{
    currentConnectionKey?: string;
    connections: AgentConnectionProfile[];
  }> {
    let metadata;
    try {
      metadata = await lstat(this.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { connections: [] };
      throw new Error('Could not inspect the Agent connection registry.');
    }
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      (this.platform !== 'win32' && (metadata.mode & 0o777) !== 0o600)
    ) {
      throw new Error(
        this.platform === 'win32'
          ? 'The Agent connection registry must be a regular file.'
          : 'The Agent connection registry must be a regular mode-0600 file.',
      );
    }
    if (process.getuid !== undefined && metadata.uid !== process.getuid()) {
      throw new Error('The Agent connection registry must be owned by the current user.');
    }
    if (metadata.size > MAX_METADATA_BYTES) throw new Error('The Agent connection registry exceeds the safety limit.');
    try {
      return parseRegistry(JSON.parse(await readFile(this.path, 'utf8')));
    } catch (error) {
      if (error instanceof SyntaxError) throw new Error('Stored Agent connection registry is invalid.');
      throw error;
    }
  }

  private async write(document: ConnectionRegistryDocument): Promise<void> {
    // Parsing our own output catches accidental secret-bearing or malformed structures before disk.
    parseRegistry(document);
    const serialized = JSON.stringify(document);
    if (Buffer.byteLength(serialized) > MAX_METADATA_BYTES) {
      throw new Error('The Agent connection registry exceeds the safety limit.');
    }
    const directory = dirname(this.path);
    await mkdir(directory, {
      recursive: true,
      ...(this.platform === 'win32' ? {} : { mode: 0o700 }),
    });
    const directoryMetadata = await lstat(directory);
    if (!directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink() ||
        (process.getuid !== undefined && directoryMetadata.uid !== process.getuid())) {
      throw new Error('The Agent connection registry directory is not secure.');
    }
    if (this.platform !== 'win32') await chmod(directory, 0o700);
    const temporaryPath = join(directory, `.agent-connections-${randomBytes(12).toString('hex')}.tmp`);
    try {
      await writeFile(temporaryPath, serialized, {
        encoding: 'utf8',
        ...(this.platform === 'win32' ? {} : { mode: 0o600 }),
        flag: 'wx',
      });
      await rename(temporaryPath, this.path);
      if (this.platform !== 'win32') await chmod(this.path, 0o600);
    } finally {
      await unlink(temporaryPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
  }
}

export type AgentConnectionStoreOptions = {
  environment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  commandRunner?: CommandRunner;
  /** Host-owned local state namespace; not a user connection field or identity claim. */
  storageNamespace?: string;
  registry?: AgentConnectionRegistry;
  credentialPathFor?: (connectionKey: string) => string;
};

/**
 * Selects isolated credential storage for each connection and tracks only public current-profile
 * metadata. A host may keep many Hub/business/workspace bindings without sharing refresh tokens.
 */
export class AgentConnectionStore {
  readonly registry: AgentConnectionRegistry;
  readonly storageNamespace: string | undefined;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly platform: NodeJS.Platform;
  private readonly commandRunner: CommandRunner;
  private readonly credentialPathFor: (connectionKey: string) => string;

  constructor(options: AgentConnectionStoreOptions = {}) {
    this.environment = options.environment ?? process.env;
    this.platform = options.platform ?? process.platform;
    this.commandRunner = options.commandRunner ?? runCommand;
    this.storageNamespace = resolveAgentStorageNamespace(
      options.storageNamespace,
      this.environment,
    );
    this.registry = options.registry ?? new AgentConnectionRegistry(
      defaultConnectionRegistryPath(
        this.storageNamespace,
        this.platform,
        this.environment,
      ),
      this.platform,
    );
    this.credentialPathFor = options.credentialPathFor ?? ((connectionKey) =>
      defaultConnectionCredentialPath(
        connectionKey,
        this.storageNamespace,
        this.platform,
        this.environment,
      ));
  }

  credentialStore(connectionKey: string): CredentialStore {
    if (!CONNECTION_KEY_PATTERN.test(connectionKey)) throw new Error('The Agent connection key is invalid.');
    if (this.platform === 'darwin') {
      return new MacOsKeychainCredentialStore(
        this.commandRunner,
        defaultConnectionKeychainAccount(connectionKey, this.storageNamespace),
      );
    }
    if (this.platform === 'win32') {
      return new WindowsDpapiCredentialStore(
        this.credentialPathFor(connectionKey),
        this.commandRunner,
        defaultConnectionKeychainAccount(connectionKey, this.storageNamespace),
        this.environment,
      );
    }
    if (String(this.environment.BAILINGHUB_ALLOW_FILE_CREDENTIAL_STORE ?? '').trim().toLowerCase() !== 'true') {
      throw new Error('Set BAILINGHUB_ALLOW_FILE_CREDENTIAL_STORE=true to use isolated mode-0600 connection files.');
    }
    return new FileCredentialStore(this.credentialPathFor(connectionKey));
  }

  async register(
    descriptor: AgentConnectionDescriptor,
    options: { alias?: string; makeCurrent?: boolean; migrateLegacy?: boolean } = {},
  ): Promise<AgentConnectionProfile> {
    const profile = await this.registry.upsert(descriptor, {
      ...(options.alias !== undefined ? { alias: options.alias } : {}),
      ...(options.makeCurrent !== undefined ? { makeCurrent: options.makeCurrent } : {}),
    });
    if (options.migrateLegacy) await this.migrateLegacy(profile);
    return profile;
  }

  async registerInstance(
    descriptor: AgentConnectionDescriptor,
    options: { alias: string; makeCurrent?: boolean },
  ): Promise<AgentConnectionProfile> {
    return this.registry.createInstance(descriptor, options);
  }

  async registerStagingInstance(
    descriptor: AgentConnectionDescriptor,
  ): Promise<AgentConnectionProfile> {
    return this.registry.createInstance(descriptor, { makeCurrent: false });
  }

  withBindingLock<T>(
    descriptorValue: AgentConnectionDescriptor,
    work: () => Promise<T>,
  ): Promise<T> {
    const descriptor = normalizedDescriptor(descriptorValue);
    const hash = createHash('sha256')
      .update('bailinghub.agent-binding-operation.v1\0')
      .update(this.registry.operationScope)
      .update('\0');
    const namespaceSegment = agentStorageNamespaceSegment(this.storageNamespace);
    if (namespaceSegment) hash.update(namespaceSegment).update('\0');
    const digest = hash
      .update(descriptor.baseUrl)
      .update('\0')
      .update(descriptor.clientAppId)
      .update('\0')
      .update(descriptor.workspace)
      .update('\0')
      .update(descriptor.allowInsecureHttp === true ? '1' : '0')
      .digest('hex');
    return new LocalAgentOperationLock(`binding:${digest}`).withLock(work);
  }

  async save(
    credentialsValue: AgentCredentials,
    options: { alias?: string; allowInsecureHttp?: boolean; makeCurrent?: boolean } = {},
  ): Promise<AgentConnectionProfile> {
    const credentials = parseAgentCredentials(credentialsValue);
    const descriptor = {
      baseUrl: credentials.base_url,
      clientAppId: credentials.client_app_id,
      workspace: credentials.route,
      allowInsecureHttp: options.allowInsecureHttp === true,
    };
    const profile = await this.registry.upsert(descriptor, {
      ...(options.alias !== undefined ? { alias: options.alias } : {}),
      ...(options.makeCurrent !== undefined ? { makeCurrent: options.makeCurrent } : {}),
    });
    await this.credentialStore(profile.connectionKey).save(credentials);
    return profile;
  }

  async load(connectionKey?: string): Promise<{
    profile: AgentConnectionProfile;
    credentials: AgentCredentials;
    store: CredentialStore;
  }> {
    const profile = connectionKey
      ? await this.registry.get(connectionKey)
      : await this.registry.current();
    if (!profile) throw new Error(connectionKey ? 'The Agent connection is not registered.' : 'No current Agent connection is selected.');
    const store = this.credentialStore(profile.connectionKey);
    const credentials = await store.load();
    if (!credentials) throw new Error('The selected Agent connection has no login.');
    const expected = agentConnectionKeyFor({
      baseUrl: credentials.base_url,
      clientAppId: credentials.client_app_id,
      workspace: credentials.route,
      allowInsecureHttp: profile.allowInsecureHttp,
    }, profile.connectionInstanceId);
    if (expected !== profile.connectionKey) {
      throw new Error('The selected Agent credentials do not match their connection binding.');
    }
    return { profile, credentials, store };
  }

  async migrateLegacy(profile: AgentConnectionProfile): Promise<LegacyCredentialMigrationResult> {
    const target = this.credentialStore(profile.connectionKey);
    if (await target.load()) return 'target_already_exists';
    const legacy = selectCredentialStore(
      this.environment,
      this.platform,
      this.commandRunner,
      this.storageNamespace,
    );
    const credentials = await legacy.load();
    if (!credentials) return 'no_legacy_credentials';
    const legacyKey = agentConnectionKey({
      baseUrl: credentials.base_url,
      clientAppId: credentials.client_app_id,
      workspace: credentials.route,
      allowInsecureHttp: profile.allowInsecureHttp,
    });
    if (profile.connectionInstanceId || legacyKey !== profile.connectionKey) return 'legacy_connection_mismatch';
    await target.save(credentials);
    const persisted = await target.load();
    if (!persisted || JSON.stringify(persisted) !== JSON.stringify(credentials)) {
      await target.delete().catch(() => undefined);
      throw new Error('The legacy Agent login could not be verified after migration.');
    }
    try {
      await legacy.delete();
    } catch {
      await target.delete().catch(() => undefined);
      throw new Error('The legacy Agent login was preserved because migration cleanup failed.');
    }
    return 'migrated';
  }
}

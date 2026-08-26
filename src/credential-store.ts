import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createServer, type Server as NetServer } from 'node:net';

import {
  booleanFlag,
  normalizeAgentRoute,
  normalizeBaseUrl,
  normalizeClientAppId,
} from './config.js';

const KEYCHAIN_SERVICE = 'io.github.bailinghub.bailinghub-mcp-server.agent-session';
const KEYCHAIN_ACCOUNT = 'default';
const MAX_CREDENTIAL_BYTES = 64 * 1024;
const REFRESH_LOCK_WAIT_MILLISECONDS = 20_000;
const REFRESH_LOCK_POLL_MILLISECONDS = 50;
const CREDENTIAL_COMMAND_TIMEOUT_MILLISECONDS = 15_000;
const CREDENTIAL_COMMAND_KILL_GRACE_MILLISECONDS = 1_000;

export type AgentCredentials = {
  schema_version: 1;
  base_url: string;
  client_app_id: string;
  route: string;
  session_id: string;
  access_token: string;
  refresh_token: string;
  access_expires_at: string;
  refresh_expires_at: string;
};

export interface CredentialStore {
  load(): Promise<AgentCredentials | undefined>;
  save(credentials: AgentCredentials): Promise<void>;
  delete(): Promise<void>;
  withRefreshLock?<T>(work: () => Promise<T>): Promise<T>;
  readonly description: string;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function closeNetServer(server: NetServer): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

/**
 * A loopback listen socket is an OS-released, crash-safe cross-process mutex. The lock key is
 * hashed to a stable local port and never contains credentials. A rare unrelated port
 * collision fails closed after a bounded wait.
 */
class LoopbackRefreshLock {
  private readonly port: number;

  constructor(key: string) {
    const value = createHash('sha256').update(key).digest().readUInt32BE(0);
    this.port = 40_000 + (value % 10_000);
  }

  async withLock<T>(work: () => Promise<T>): Promise<T> {
    const deadline = Date.now() + REFRESH_LOCK_WAIT_MILLISECONDS;
    let server: NetServer | undefined;
    while (!server) {
      server = await this.tryAcquire();
      if (server) break;
      if (Date.now() >= deadline) {
        throw new Error(
          'Timed out waiting for another BailingHub process to finish a credential operation.',
        );
      }
      await sleep(REFRESH_LOCK_POLL_MILLISECONDS);
    }
    try {
      return await work();
    } finally {
      await closeNetServer(server);
    }
  }

  private tryAcquire(): Promise<NetServer | undefined> {
    return new Promise((resolve, reject) => {
      const server = createServer((socket) => socket.destroy());
      server.once('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'EADDRINUSE') {
          resolve(undefined);
          return;
        }
        reject(new Error('Could not acquire the local Agent refresh lock.'));
      });
      server.listen(
        { host: '127.0.0.1', port: this.port, exclusive: true },
        () => resolve(server),
      );
    });
  }
}

type CommandResult = {
  exitCode: number;
  stdout: string;
};

export type CommandRunner = (
  executable: string,
  args: string[],
  input?: string,
) => Promise<CommandResult>;

function requiredStoredText(
  value: unknown,
  field: keyof AgentCredentials,
  maximumLength: number,
): string {
  if (typeof value !== 'string') throw new Error('Stored Agent credentials are invalid.');
  const text = value.trim();
  if (!text || text.length > maximumLength) {
    throw new Error('Stored Agent credentials are invalid.');
  }
  return text;
}

function requiredTimestamp(value: unknown): string {
  const text = requiredStoredText(value, 'access_expires_at', 100);
  if (!Number.isFinite(Date.parse(text))) {
    throw new Error('Stored Agent credentials are invalid.');
  }
  return text;
}

export function parseAgentCredentials(value: unknown): AgentCredentials {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Stored Agent credentials are invalid.');
  }
  const record = value as Record<string, unknown>;
  if (record.schema_version !== 1) {
    throw new Error('Stored Agent credentials use an unsupported format.');
  }

  const baseUrl = requiredStoredText(record.base_url, 'base_url', 2048);
  const clientAppId = requiredStoredText(record.client_app_id, 'client_app_id', 64);
  const route = requiredStoredText(record.route, 'route', 64);
  const accessExpiresAt = requiredTimestamp(record.access_expires_at);
  const refreshExpiresAt = requiredTimestamp(record.refresh_expires_at);
  try {
    if (
      normalizeBaseUrl(baseUrl, true) !== baseUrl ||
      normalizeClientAppId(clientAppId) !== clientAppId ||
      normalizeAgentRoute(route) !== route
    ) {
      throw new Error('Stored Agent credentials are invalid.');
    }
  } catch {
    throw new Error('Stored Agent credentials are invalid.');
  }
  if (Date.parse(refreshExpiresAt) <= Date.parse(accessExpiresAt)) {
    throw new Error('Stored Agent credentials are invalid.');
  }

  return {
    schema_version: 1,
    base_url: baseUrl,
    client_app_id: clientAppId,
    route,
    session_id: requiredStoredText(record.session_id, 'session_id', 128),
    access_token: requiredStoredText(record.access_token, 'access_token', 8192),
    refresh_token: requiredStoredText(record.refresh_token, 'refresh_token', 8192),
    access_expires_at: accessExpiresAt,
    refresh_expires_at: refreshExpiresAt,
  };
}

function serializeCredentials(credentials: AgentCredentials): string {
  const serialized = JSON.stringify(parseAgentCredentials(credentials));
  if (Buffer.byteLength(serialized) > MAX_CREDENTIAL_BYTES) {
    throw new Error('Agent credentials exceed the local storage limit.');
  }
  return serialized;
}

export function createCommandRunner(
  timeoutMilliseconds = CREDENTIAL_COMMAND_TIMEOUT_MILLISECONDS,
): CommandRunner {
  if (!Number.isInteger(timeoutMilliseconds) || timeoutMilliseconds < 1) {
    throw new Error('The credential command timeout must be a positive integer.');
  }
  return (executable, args, input) =>
    new Promise<CommandResult>((resolve, reject) => {
      const child = spawn(executable, args, {
        stdio: ['pipe', 'pipe', 'ignore'],
        windowsHide: true,
      });
      const chunks: Buffer[] = [];
      let total = 0;
      let settled = false;
      let failure: Error | undefined;
      let killTimer: NodeJS.Timeout | undefined;

      const timeout = setTimeout(() => {
        failure = new Error('The system credential store command timed out.');
        child.kill('SIGTERM');
        killTimer = setTimeout(() => {
          if (!settled) child.kill('SIGKILL');
        }, CREDENTIAL_COMMAND_KILL_GRACE_MILLISECONDS);
      }, timeoutMilliseconds);

      const finish = (error?: Error, result?: CommandResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (killTimer) clearTimeout(killTimer);
        if (error) reject(error);
        else resolve(result!);
      };

      child.stdout.on('data', (chunk: Buffer) => {
        total += chunk.byteLength;
        if (total <= MAX_CREDENTIAL_BYTES) chunks.push(chunk);
        else if (!failure) {
          failure = new Error('The system credential store returned too much data.');
          child.kill('SIGTERM');
        }
      });
      child.stdin.once('error', () => {
        if (!failure) {
          failure = new Error('The system credential store could not receive credential data.');
          child.kill('SIGTERM');
        }
      });
      child.once('error', () =>
        finish(new Error('The system credential store is unavailable.')),
      );
      child.once('close', (code) => {
        if (failure) {
          finish(failure);
          return;
        }
        finish(undefined, {
          exitCode: code ?? 1,
          stdout: Buffer.concat(chunks).toString('utf8'),
        });
      });
      if (input !== undefined) child.stdin.end(input);
      else child.stdin.end();
    });
}

export const runCommand = createCommandRunner();

export class MacOsKeychainCredentialStore implements CredentialStore {
  readonly description = 'macOS Keychain';
  private readonly refreshLock: LoopbackRefreshLock;

  constructor(
    private readonly commandRunner: CommandRunner = runCommand,
    private readonly account: string = KEYCHAIN_ACCOUNT,
  ) {
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(account)) {
      throw new Error('The Keychain credential account is invalid.');
    }
    this.refreshLock = new LoopbackRefreshLock(
      `keychain:${process.getuid?.() ?? 'user'}:${KEYCHAIN_SERVICE}:${account}`,
    );
  }

  async load(): Promise<AgentCredentials | undefined> {
    const result = await this.commandRunner('/usr/bin/security', [
      'find-generic-password',
      '-a',
      this.account,
      '-s',
      KEYCHAIN_SERVICE,
      '-w',
    ]);
    if (result.exitCode === 44) return undefined;
    if (result.exitCode !== 0) {
      throw new Error('Could not read Agent credentials from macOS Keychain.');
    }
    try {
      return parseAgentCredentials(JSON.parse(result.stdout));
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new Error('Stored Agent credentials are invalid.');
      }
      throw error;
    }
  }

  async save(credentials: AgentCredentials): Promise<void> {
    const serialized = serializeCredentials(credentials);
    const passwordHex = Buffer.from(serialized, 'utf8').toString('hex');
    const result = await this.commandRunner(
      '/usr/bin/security',
      ['-i'],
      `add-generic-password -a ${this.account} -s ${KEYCHAIN_SERVICE} -U -X ${passwordHex}\n`,
    );
    if (result.exitCode !== 0) {
      throw new Error('Could not save Agent credentials in macOS Keychain.');
    }
    try {
      const persisted = await this.load();
      if (!persisted || serializeCredentials(persisted) !== serialized) {
        throw new Error('Keychain credential verification failed.');
      }
    } catch {
      const cleanup = await this.commandRunner('/usr/bin/security', [
        'delete-generic-password',
        '-a',
        this.account,
        '-s',
        KEYCHAIN_SERVICE,
      ]);
      if (cleanup.exitCode !== 0 && cleanup.exitCode !== 44) {
        throw new Error(
          'Could not verify or remove Agent credentials from macOS Keychain.',
        );
      }
      throw new Error('Could not verify Agent credentials in macOS Keychain.');
    }
  }

  async delete(): Promise<void> {
    const result = await this.commandRunner('/usr/bin/security', [
      'delete-generic-password',
      '-a',
      this.account,
      '-s',
      KEYCHAIN_SERVICE,
    ]);
    if (result.exitCode !== 0 && result.exitCode !== 44) {
      throw new Error('Could not remove Agent credentials from macOS Keychain.');
    }
  }

  withRefreshLock<T>(work: () => Promise<T>): Promise<T> {
    return this.refreshLock.withLock(work);
  }
}

export class FileCredentialStore implements CredentialStore {
  readonly description: string;
  private readonly refreshLock: LoopbackRefreshLock;

  constructor(private readonly path: string) {
    this.description = 'explicit mode-0600 file store';
    this.refreshLock = new LoopbackRefreshLock(`file:${path}`);
  }

  async load(): Promise<AgentCredentials | undefined> {
    let metadata;
    try {
      metadata = await lstat(this.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw new Error('Could not inspect the Agent credential file.');
    }
    if (!metadata.isFile() || (metadata.mode & 0o777) !== 0o600) {
      throw new Error('The Agent credential file must be a regular file with mode 0600.');
    }
    if (process.getuid !== undefined && metadata.uid !== process.getuid()) {
      throw new Error('The Agent credential file must be owned by the current user.');
    }
    if (metadata.size > MAX_CREDENTIAL_BYTES) {
      throw new Error('The Agent credential file exceeds the local storage limit.');
    }
    try {
      return parseAgentCredentials(JSON.parse(await readFile(this.path, 'utf8')));
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new Error('Stored Agent credentials are invalid.');
      }
      throw error;
    }
  }

  async save(credentials: AgentCredentials): Promise<void> {
    const directory = dirname(this.path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const directoryMetadata = await lstat(directory);
    if (
      !directoryMetadata.isDirectory() ||
      directoryMetadata.isSymbolicLink() ||
      (process.getuid !== undefined && directoryMetadata.uid !== process.getuid())
    ) {
      throw new Error('The Agent credential directory is not secure.');
    }
    await chmod(directory, 0o700);
    const temporaryPath = join(
      directory,
      `.agent-credentials-${randomBytes(12).toString('hex')}.tmp`,
    );
    try {
      await writeFile(temporaryPath, serializeCredentials(credentials), {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx',
      });
      await rename(temporaryPath, this.path);
      await chmod(this.path, 0o600);
    } finally {
      await unlink(temporaryPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
  }

  async delete(): Promise<void> {
    await unlink(this.path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') {
        throw new Error('Could not remove the Agent credential file.');
      }
    });
  }

  withRefreshLock<T>(work: () => Promise<T>): Promise<T> {
    return this.refreshLock.withLock(work);
  }
}

export class MemoryCredentialStore implements CredentialStore {
  readonly description = 'memory';
  private credentials: AgentCredentials | undefined;
  private lockTail: Promise<void> = Promise.resolve();

  constructor(initial?: AgentCredentials) {
    this.credentials = initial === undefined ? undefined : parseAgentCredentials(initial);
  }

  async load(): Promise<AgentCredentials | undefined> {
    return this.credentials === undefined
      ? undefined
      : parseAgentCredentials(structuredClone(this.credentials));
  }

  async save(credentials: AgentCredentials): Promise<void> {
    this.credentials = parseAgentCredentials(structuredClone(credentials));
  }

  async delete(): Promise<void> {
    this.credentials = undefined;
  }

  async withRefreshLock<T>(work: () => Promise<T>): Promise<T> {
    const previous = this.lockTail;
    let release!: () => void;
    this.lockTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  }
}

export function defaultFileCredentialPath(): string {
  return join(homedir(), '.config', 'bailinghub', 'agent-credentials.json');
}

export function selectCredentialStore(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  commandRunner: CommandRunner = runCommand,
): CredentialStore {
  if (platform === 'darwin') return new MacOsKeychainCredentialStore(commandRunner);
  if (platform === 'win32') {
    throw new Error(
      'Agent Session credential storage is not supported on Windows yet. ' +
        'Use Client Token mode (BAILINGHUB_CLIENT_TOKEN) instead.',
    );
  }

  const optedIn = booleanFlag(
    environment.BAILINGHUB_ALLOW_FILE_CREDENTIAL_STORE,
    'BAILINGHUB_ALLOW_FILE_CREDENTIAL_STORE',
  );
  if (!optedIn) {
    throw new Error(
      'No supported system credential store is available. Set ' +
        'BAILINGHUB_ALLOW_FILE_CREDENTIAL_STORE=true to explicitly opt in to a mode-0600 ' +
        'credential file.',
    );
  }
  const path = String(environment.BAILINGHUB_CREDENTIAL_FILE ?? '').trim();
  return new FileCredentialStore(path || defaultFileCredentialPath());
}

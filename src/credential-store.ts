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
import { dirname, join, resolve, win32 as windowsPath } from 'node:path';
import { createServer, type Server as NetServer } from 'node:net';

import {
  booleanFlag,
  normalizeAgentRoute,
  normalizeBaseUrl,
  normalizeClientAppId,
} from './config.js';

const KEYCHAIN_SERVICE = 'io.github.bailinghub.bailinghub-mcp-server.agent-session';
const KEYCHAIN_ACCOUNT = 'default';
export const AGENT_CLIENT_STORAGE_NAMESPACE_ENV =
  'BAILINGHUB_AGENT_CLIENT_STORAGE_NAMESPACE';
const STORAGE_NAMESPACE_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const MAX_CREDENTIAL_BYTES = 64 * 1024;
const REFRESH_LOCK_WAIT_MILLISECONDS = 20_000;
const REFRESH_LOCK_POLL_MILLISECONDS = 50;
const CREDENTIAL_COMMAND_TIMEOUT_MILLISECONDS = 15_000;
const CREDENTIAL_COMMAND_KILL_GRACE_MILLISECONDS = 1_000;
const MAX_DPAPI_CIPHERTEXT_BYTES = 128 * 1024;
const WINDOWS_DPAPI_ENTROPY_PREFIX =
  'io.github.bailinghub.bailinghub-mcp-server.agent-session.dpapi.v1';
const WINDOWS_DPAPI_ACCOUNT_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

const WINDOWS_DPAPI_PROTECT_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
try {
  Add-Type -AssemblyName System.Security
  $request = [System.Console]::In.ReadToEnd() | ConvertFrom-Json
  $path = [System.Text.Encoding]::UTF8.GetString(
    [System.Convert]::FromBase64String([string]$request.path_b64)
  )
  $plaintext = [System.Convert]::FromBase64String([string]$request.payload_b64)
  if ($plaintext.Length -gt 65536) { throw 'Credential payload is too large.' }
  $entropy = [System.Convert]::FromBase64String([string]$request.entropy)
  $ciphertext = [System.Security.Cryptography.ProtectedData]::Protect(
    $plaintext,
    $entropy,
    [System.Security.Cryptography.DataProtectionScope]::CurrentUser
  )
  $verified = [System.Security.Cryptography.ProtectedData]::Unprotect(
    $ciphertext,
    $entropy,
    [System.Security.Cryptography.DataProtectionScope]::CurrentUser
  )
  if ($verified.Length -ne $plaintext.Length) { throw 'DPAPI verification failed.' }
  for ($index = 0; $index -lt $plaintext.Length; $index += 1) {
    if ($verified[$index] -ne $plaintext[$index]) { throw 'DPAPI verification failed.' }
  }
  [System.IO.File]::WriteAllBytes($path, $ciphertext)
  [System.Console]::Out.Write('ok')
} catch {
  exit 1
}
`;

const WINDOWS_DPAPI_UNPROTECT_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
try {
  Add-Type -AssemblyName System.Security
  $request = [System.Console]::In.ReadToEnd() | ConvertFrom-Json
  $path = [System.Text.Encoding]::UTF8.GetString(
    [System.Convert]::FromBase64String([string]$request.path_b64)
  )
  $ciphertext = [System.IO.File]::ReadAllBytes($path)
  $entropy = [System.Convert]::FromBase64String([string]$request.entropy)
  $plaintext = [System.Security.Cryptography.ProtectedData]::Unprotect(
    $ciphertext,
    $entropy,
    [System.Security.Cryptography.DataProtectionScope]::CurrentUser
  )
  if ($plaintext.Length -gt 65536) { throw 'Credential payload is too large.' }
  $output = [System.Console]::OpenStandardOutput()
  $output.Write($plaintext, 0, $plaintext.Length)
  $output.Flush()
} catch {
  exit 1
}
`;

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

/**
 * Validates an optional host-owned local-storage namespace.
 *
 * This value is not a connection field or a business identity. It is deliberately constrained
 * to a short lowercase identifier and is hashed before it reaches a path, Keychain account, or
 * lock key. Empty input preserves the historical unnamespaced storage locations exactly.
 */
export function normalizeAgentStorageNamespace(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || value !== value.trim() ||
      !STORAGE_NAMESPACE_PATTERN.test(value)) {
    throw new Error(
      'The Agent Client storage namespace must be a lowercase identifier of 1 to 64 characters.',
    );
  }
  return value;
}

export function resolveAgentStorageNamespace(
  explicitValue: unknown,
  environment: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const explicit = normalizeAgentStorageNamespace(explicitValue);
  const environmentValue = normalizeAgentStorageNamespace(
    environment[AGENT_CLIENT_STORAGE_NAMESPACE_ENV],
  );
  if (explicit && environmentValue && explicit !== environmentValue) {
    throw new Error(
      'The Agent Client storage namespace conflicts with the host environment.',
    );
  }
  return explicit ?? environmentValue;
}

/** Opaque filesystem/Keychain-safe segment; never contains the host's raw namespace. */
export function agentStorageNamespaceSegment(value: unknown): string | undefined {
  const namespace = normalizeAgentStorageNamespace(value);
  if (!namespace) return undefined;
  return `host-${createHash('sha256')
    .update('bailinghub.agent-client-storage.v1\0')
    .update(namespace, 'utf8')
    .digest('hex')
    .slice(0, 32)}`;
}

export function defaultKeychainCredentialAccount(storageNamespace?: string): string {
  const segment = agentStorageNamespaceSegment(storageNamespace);
  return segment ? `${segment}-default` : KEYCHAIN_ACCOUNT;
}

function requiredAbsoluteWindowsPath(value: string, label: string): string {
  if (
    !value ||
    /[\u0000\r\n]/.test(value) ||
    !windowsPath.isAbsolute(value)
  ) {
    throw new Error(`${label} is invalid.`);
  }
  return windowsPath.normalize(value);
}

/** Current-user application data root used only for public metadata and DPAPI ciphertext. */
export function defaultWindowsAgentStorageRoot(
  storageNamespace?: string,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const configuredRoot = String(
    environment.LOCALAPPDATA ?? process.env.LOCALAPPDATA ?? '',
  ).trim();
  const localApplicationData = requiredAbsoluteWindowsPath(
    configuredRoot || windowsPath.join(homedir(), 'AppData', 'Local'),
    'The Windows local application data path',
  );
  const root = windowsPath.join(localApplicationData, 'BailingHub', 'AgentClient');
  const segment = agentStorageNamespaceSegment(storageNamespace);
  return segment ? windowsPath.join(root, 'hosts', segment) : root;
}

export function defaultWindowsDpapiCredentialPath(
  storageNamespace?: string,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  return windowsPath.join(
    defaultWindowsAgentStorageRoot(storageNamespace, environment),
    'agent-credentials.dpapi',
  );
}

export function defaultWindowsPowerShellPath(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const configuredRoot = String(
    environment.SystemRoot ??
      environment.SYSTEMROOT ??
      process.env.SystemRoot ??
      process.env.SYSTEMROOT ??
      '',
  ).trim();
  const systemRoot = requiredAbsoluteWindowsPath(
    configuredRoot || 'C:\\Windows',
    'The Windows system root',
  );
  return windowsPath.join(
    systemRoot,
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
}

function encodedPowerShellCommand(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

const WINDOWS_DPAPI_PROTECT_ARGUMENTS = [
  '-NoLogo',
  '-NoProfile',
  '-NonInteractive',
  '-EncodedCommand',
  encodedPowerShellCommand(WINDOWS_DPAPI_PROTECT_SCRIPT),
];
const WINDOWS_DPAPI_UNPROTECT_ARGUMENTS = [
  '-NoLogo',
  '-NoProfile',
  '-NonInteractive',
  '-EncodedCommand',
  encodedPowerShellCommand(WINDOWS_DPAPI_UNPROTECT_SCRIPT),
];

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
 * Crash-safe, cross-process mutex for short local Agent state transitions.
 * The key is hashed before it is mapped to a loopback TCP port and must never contain credentials.
 * The OS releases the listener after a crash; a rare unrelated hash/port collision only serializes
 * the operation or fails closed after the bounded wait.
 */
export class LocalAgentOperationLock {
  private readonly port: number;

  constructor(key: string) {
    const digest = createHash('sha256').update(key).digest();
    this.port = 10_000 + (digest.readUInt32BE(0) % 30_000);
  }

  async withLock<T>(work: () => Promise<T>): Promise<T> {
    const deadline = Date.now() + REFRESH_LOCK_WAIT_MILLISECONDS;
    let server: NetServer | undefined;
    while (!server) {
      server = await this.tryAcquire();
      if (server) break;
      if (Date.now() >= deadline) {
        throw new LocalAgentOperationLockTimeoutError();
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
        reject(new Error('Could not acquire the local Agent operation lock.'));
      });
      server.listen({ host: '127.0.0.1', port: this.port, exclusive: true }, () => resolve(server));
    });
  }
}

export class LocalAgentOperationLockTimeoutError extends Error {
  constructor() {
    super('Timed out waiting for another BailingHub process to finish a local Agent operation.');
    this.name = 'LocalAgentOperationLockTimeoutError';
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
  private readonly refreshLock: LocalAgentOperationLock;

  constructor(
    private readonly commandRunner: CommandRunner = runCommand,
    private readonly account: string = KEYCHAIN_ACCOUNT,
  ) {
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(account)) {
      throw new Error('The Keychain credential account is invalid.');
    }
    this.refreshLock = new LocalAgentOperationLock(
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

/**
 * Stores one Agent Session as a CurrentUser DPAPI-protected binary file.
 *
 * The fixed PowerShell programs are passed through -EncodedCommand. Credential JSON, file paths,
 * and the non-secret entropy value travel only through stdin, never process arguments or logs.
 * DPAPI provides the confidentiality and integrity boundary; the file is only ciphertext.
 */
export class WindowsDpapiCredentialStore implements CredentialStore {
  readonly description = 'Windows DPAPI (CurrentUser)';
  private readonly path: string;
  private readonly entropy: string;
  private readonly powerShellPath: string;
  private readonly refreshLock: LocalAgentOperationLock;

  constructor(
    path: string,
    private readonly commandRunner: CommandRunner = runCommand,
    account: string = KEYCHAIN_ACCOUNT,
    environment: NodeJS.ProcessEnv = process.env,
  ) {
    if (!WINDOWS_DPAPI_ACCOUNT_PATTERN.test(account)) {
      throw new Error('The Windows DPAPI credential account is invalid.');
    }
    this.path = resolve(path);
    this.entropy = Buffer.from(
      `${WINDOWS_DPAPI_ENTROPY_PREFIX}\0${account}`,
      'utf8',
    ).toString('base64');
    this.powerShellPath = defaultWindowsPowerShellPath(environment);
    this.refreshLock = new LocalAgentOperationLock(`windows-dpapi:${this.path}`);
  }

  async load(): Promise<AgentCredentials | undefined> {
    let metadata;
    try {
      metadata = await lstat(this.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw new Error('Could not inspect the Windows DPAPI credential file.');
    }
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.size < 1 ||
      metadata.size > MAX_DPAPI_CIPHERTEXT_BYTES
    ) {
      throw new Error('The Windows DPAPI credential file is invalid.');
    }

    let result: CommandResult;
    try {
      result = await this.commandRunner(
        this.powerShellPath,
        [...WINDOWS_DPAPI_UNPROTECT_ARGUMENTS],
        JSON.stringify({
          path_b64: Buffer.from(this.path, 'utf8').toString('base64'),
          entropy: this.entropy,
        }),
      );
    } catch {
      throw new Error('The Windows DPAPI credential store is unavailable.');
    }
    if (result.exitCode !== 0) {
      throw new Error('Could not decrypt Agent credentials with Windows DPAPI.');
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
    const directory = dirname(this.path);
    await mkdir(directory, { recursive: true });
    const directoryMetadata = await lstat(directory);
    if (!directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink()) {
      throw new Error('The Windows DPAPI credential directory is not secure.');
    }
    let previousCiphertext: Buffer | undefined;
    try {
      const destinationMetadata = await lstat(this.path);
      if (
        !destinationMetadata.isFile() ||
        destinationMetadata.isSymbolicLink() ||
        destinationMetadata.size < 1 ||
        destinationMetadata.size > MAX_DPAPI_CIPHERTEXT_BYTES
      ) {
        throw new Error('The Windows DPAPI credential file is invalid.');
      }
      previousCiphertext = await readFile(this.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }

    const temporaryPath = join(
      directory,
      `.agent-credentials-${randomBytes(12).toString('hex')}.dpapi.tmp`,
    );
    let destinationReplaced = false;
    try {
      let result: CommandResult;
      try {
        result = await this.commandRunner(
          this.powerShellPath,
          [...WINDOWS_DPAPI_PROTECT_ARGUMENTS],
          JSON.stringify({
            path_b64: Buffer.from(temporaryPath, 'utf8').toString('base64'),
            entropy: this.entropy,
            payload_b64: Buffer.from(serialized, 'utf8').toString('base64'),
          }),
        );
      } catch {
        throw new Error('The Windows DPAPI credential store is unavailable.');
      }
      if (result.exitCode !== 0 || result.stdout !== 'ok') {
        throw new Error('Could not encrypt Agent credentials with Windows DPAPI.');
      }
      const temporaryMetadata = await lstat(temporaryPath);
      if (
        !temporaryMetadata.isFile() ||
        temporaryMetadata.isSymbolicLink() ||
        temporaryMetadata.size < 1 ||
        temporaryMetadata.size > MAX_DPAPI_CIPHERTEXT_BYTES
      ) {
        throw new Error('Windows DPAPI returned an invalid credential file.');
      }
      await rename(temporaryPath, this.path);
      destinationReplaced = true;
      const persisted = await this.load();
      if (!persisted || serializeCredentials(persisted) !== serialized) {
        throw new Error('Windows DPAPI credential verification failed.');
      }
    } catch (error) {
      if (destinationReplaced) {
        if (previousCiphertext) {
          try {
            await writeFile(this.path, previousCiphertext);
          } catch {
            throw new Error('Could not restore previous Windows DPAPI credentials.');
          }
        } else {
          await unlink(this.path).catch((cleanupError: NodeJS.ErrnoException) => {
            if (cleanupError.code !== 'ENOENT') {
              throw new Error('Could not verify or remove Windows DPAPI credentials.');
            }
          });
        }
      }
      if (error instanceof Error && error.message.includes('unavailable')) throw error;
      throw new Error('Could not verify Agent credentials with Windows DPAPI.');
    } finally {
      await unlink(temporaryPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
  }

  async delete(): Promise<void> {
    await unlink(this.path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') {
        throw new Error('Could not remove the Windows DPAPI credential file.');
      }
    });
  }

  withRefreshLock<T>(work: () => Promise<T>): Promise<T> {
    return this.refreshLock.withLock(work);
  }
}

export class FileCredentialStore implements CredentialStore {
  readonly description: string;
  private readonly refreshLock: LocalAgentOperationLock;

  constructor(private readonly path: string) {
    this.description = 'explicit mode-0600 file store';
    this.refreshLock = new LocalAgentOperationLock(`file:${path}`);
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

export function defaultFileCredentialPath(storageNamespace?: string): string {
  const segment = agentStorageNamespaceSegment(storageNamespace);
  return segment
    ? join(homedir(), '.config', 'bailinghub', 'hosts', segment, 'agent-credentials.json')
    : join(homedir(), '.config', 'bailinghub', 'agent-credentials.json');
}

export function selectCredentialStore(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  commandRunner: CommandRunner = runCommand,
  storageNamespace?: string,
): CredentialStore {
  const namespace = resolveAgentStorageNamespace(storageNamespace, environment);
  if (platform === 'darwin') {
    return new MacOsKeychainCredentialStore(
      commandRunner,
      defaultKeychainCredentialAccount(namespace),
    );
  }
  if (platform === 'win32') {
    return new WindowsDpapiCredentialStore(
      defaultWindowsDpapiCredentialPath(namespace, environment),
      commandRunner,
      defaultKeychainCredentialAccount(namespace),
      environment,
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
  return new FileCredentialStore(path || defaultFileCredentialPath(namespace));
}

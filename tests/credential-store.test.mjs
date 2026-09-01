import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  AGENT_CLIENT_STORAGE_NAMESPACE_ENV,
  agentStorageNamespaceSegment,
  createCommandRunner,
  defaultFileCredentialPath,
  defaultKeychainCredentialAccount,
  defaultWindowsAgentStorageRoot,
  defaultWindowsDpapiCredentialPath,
  defaultWindowsPowerShellPath,
  FileCredentialStore,
  MacOsKeychainCredentialStore,
  normalizeAgentStorageNamespace,
  parseAgentCredentials,
  resolveAgentStorageNamespace,
  selectCredentialStore,
  WindowsDpapiCredentialStore,
} from '../dist/credential-store.js';

const CREDENTIALS = {
  schema_version: 1,
  base_url: 'https://hub.example.com',
  client_app_id: 'example-agent-client',
  route: 'orders',
  session_id: 'session-1',
  access_token: 'access-secret',
  refresh_token: 'refresh-secret',
  access_expires_at: '2026-08-25T10:00:00.000Z',
  refresh_expires_at: '2026-09-25T10:00:00.000Z',
};

test('credential parser fails closed without exposing malformed secret fields', () => {
  assert.deepEqual(parseAgentCredentials(CREDENTIALS), CREDENTIALS);
  assert.throws(
    () => parseAgentCredentials({ ...CREDENTIALS, schema_version: 2 }),
    /unsupported format/,
  );
  assert.throws(
    () => parseAgentCredentials({ ...CREDENTIALS, access_token: '' }),
    (error) => !error.message.includes('refresh-secret'),
  );
});

test('host storage namespace is strict, opaque, and preserves legacy defaults when unset', () => {
  assert.equal(normalizeAgentStorageNamespace(undefined), undefined);
  assert.equal(normalizeAgentStorageNamespace(''), undefined);
  assert.equal(normalizeAgentStorageNamespace('product-desktop'), 'product-desktop');
  for (const value of [
    '../product', 'product/desktop', 'product\\desktop', 'Product', ' product',
    'product ', '.', 'a'.repeat(65),
  ]) {
    assert.throws(
      () => normalizeAgentStorageNamespace(value),
      /storage namespace must be a lowercase identifier/u,
    );
  }

  assert.equal(
    defaultFileCredentialPath(),
    join(homedir(), '.config', 'bailinghub', 'agent-credentials.json'),
  );
  assert.equal(defaultKeychainCredentialAccount(), 'default');

  const segment = agentStorageNamespaceSegment('product-desktop');
  assert.match(segment, /^host-[a-f0-9]{32}$/u);
  assert.equal(segment.includes('product-desktop'), false);
  assert.equal(defaultFileCredentialPath('product-desktop').includes(segment), true);
  assert.equal(defaultKeychainCredentialAccount('product-desktop'), `${segment}-default`);
});

test('Windows defaults use LocalAppData and keep a raw host namespace out of paths', () => {
  const environment = {
    LOCALAPPDATA: 'C:\\Users\\Example\\AppData\\Local',
    SystemRoot: 'D:\\Windows',
  };
  const namespace = 'product-desktop';
  const segment = agentStorageNamespaceSegment(namespace);
  const root = defaultWindowsAgentStorageRoot(namespace, environment);
  assert.equal(
    root,
    `C:\\Users\\Example\\AppData\\Local\\BailingHub\\AgentClient\\hosts\\${segment}`,
  );
  assert.equal(root.includes(namespace), false);
  assert.equal(
    defaultWindowsDpapiCredentialPath(namespace, environment),
    `${root}\\agent-credentials.dpapi`,
  );
  assert.equal(
    defaultWindowsPowerShellPath(environment),
    'D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  );
});

test('host environment namespaces Keychain account without placing raw input in arguments', async () => {
  const calls = [];
  const runner = async (_executable, args) => {
    calls.push(args);
    return { exitCode: 44, stdout: '' };
  };
  const namespace = 'product-desktop';
  const store = selectCredentialStore({
    [AGENT_CLIENT_STORAGE_NAMESPACE_ENV]: namespace,
  }, 'darwin', runner);

  assert.equal(await store.load(), undefined);
  assert.equal(store.description.includes(namespace), false);
  assert.equal(JSON.stringify(calls).includes(namespace), false);
  assert.equal(
    calls[0][calls[0].indexOf('-a') + 1],
    defaultKeychainCredentialAccount(namespace),
  );
});

test('conflicting host environment and SDK namespace fail closed', () => {
  assert.throws(
    () => resolveAgentStorageNamespace('product-one', {
      [AGENT_CLIENT_STORAGE_NAMESPACE_ENV]: 'product-two',
    }),
    /conflicts with the host environment/u,
  );
});

test('macOS Keychain save sends the secret through stdin, never command arguments', async () => {
  const calls = [];
  const runner = async (_executable, args, input) => {
    calls.push({ args, input });
    if (args[0] === 'find-generic-password') {
      return { exitCode: 0, stdout: JSON.stringify(CREDENTIALS) };
    }
    return { exitCode: 0, stdout: '' };
  };
  const store = new MacOsKeychainCredentialStore(runner);
  await store.save(CREDENTIALS);
  assert.equal(JSON.stringify(calls[0].args).includes('access-secret'), false);
  assert.deepEqual(calls[0].args, ['-i']);
  assert.equal(calls[0].input.includes('access-secret'), false);
  const passwordHex = calls[0].input.match(/ -X ([0-9a-f]+)\n$/)?.[1];
  assert.ok(passwordHex);
  assert.equal(Buffer.from(passwordHex, 'hex').toString('utf8').includes('access-secret'), true);
  assert.deepEqual(await store.load(), CREDENTIALS);
  await store.delete();
});

test('macOS Keychain save verifies the persisted record and removes an invalid write', async () => {
  const calls = [];
  const runner = async (_executable, args, input) => {
    calls.push({ args, input });
    if (args[0] === 'find-generic-password') {
      return { exitCode: 0, stdout: '\n' };
    }
    return { exitCode: 0, stdout: '' };
  };
  const store = new MacOsKeychainCredentialStore(runner);
  await assert.rejects(store.save(CREDENTIALS), /Could not verify Agent credentials/);
  assert.equal(
    calls.some(({ args }) => args[0] === 'delete-generic-password'),
    true,
  );
});

test('file credential store is only selected by opt-in and enforces mode 0600', async (t) => {
  assert.throws(
    () => selectCredentialStore({}, 'linux'),
    /explicitly opt in/,
  );

  const directory = await mkdtemp(join(tmpdir(), 'bailinghub-credentials-'));
  const path = join(directory, 'credentials.json');
  const store = new FileCredentialStore(path);
  t.after(() => store.delete());
  await store.save(CREDENTIALS);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.deepEqual(await store.load(), CREDENTIALS);
  await chmod(path, 0o644);
  await assert.rejects(store.load(), /mode 0600/);
  await chmod(path, 0o600);
  await store.delete();
  assert.equal(await store.load(), undefined);
});

test('credential command runner terminates a hung system command', async () => {
  const runner = createCommandRunner(50);
  await assert.rejects(
    runner(process.execPath, ['-e', 'setInterval(() => {}, 1000)']),
    /timed out/,
  );
});

test('file credential stores with the same path share one cross-process operation lock', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'bailinghub-lock-'));
  const path = join(directory, 'credentials.json');
  const moduleUrl = new URL('../dist/credential-store.js', import.meta.url).href;
  const child = spawn(process.execPath, [
    '--input-type=module',
    '--eval',
    `import { FileCredentialStore } from ${JSON.stringify(moduleUrl)};
const store = new FileCredentialStore(process.argv[1]);
await store.withRefreshLock(async () => {
  process.stdout.write('locked\\n');
  await new Promise((resolve) => process.stdin.once('data', resolve));
});`,
    path,
  ], { stdio: ['pipe', 'pipe', 'inherit'] });
  t.after(() => child.kill('SIGKILL'));
  const [chunk] = await once(child.stdout, 'data');
  assert.equal(String(chunk), 'locked\n');

  const second = new FileCredentialStore(path);
  let secondEntered = false;
  const waiting = second.withRefreshLock(async () => {
    secondEntered = true;
    return 'second';
  });
  await new Promise((resolve) => setTimeout(resolve, 75));
  assert.equal(secondEntered, false);
  child.stdin.end('release\n');
  const [exitCode] = await once(child, 'exit');
  assert.equal(exitCode, 0);
  assert.equal(await waiting, 'second');
});

function fakeDpapiRunner(calls) {
  return async (executable, args, input) => {
    const request = JSON.parse(input);
    const path = Buffer.from(request.path_b64, 'base64').toString('utf8');
    calls.push({ executable, args, input, request, path });
    if (Object.hasOwn(request, 'payload_b64')) {
      const ciphertext = JSON.stringify({
        entropy: request.entropy,
        payload: request.payload_b64,
      });
      await writeFile(path, ciphertext);
      return { exitCode: 0, stdout: 'ok' };
    }
    const ciphertext = JSON.parse(await readFile(path, 'utf8'));
    if (ciphertext.entropy !== request.entropy) return { exitCode: 1, stdout: '' };
    return {
      exitCode: 0,
      stdout: Buffer.from(ciphertext.payload, 'base64').toString('utf8'),
    };
  };
}

test('Windows DPAPI store keeps secrets out of process arguments and isolates entropy scopes', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'bailinghub-dpapi-unit-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'credentials.dpapi');
  const calls = [];
  const environment = { SystemRoot: 'C:\\Windows' };
  const fakeRunner = fakeDpapiRunner(calls);
  let failNextLoad = false;
  const runner = async (executable, args, input) => {
    const request = JSON.parse(input);
    if (!Object.hasOwn(request, 'payload_b64') && failNextLoad) {
      failNextLoad = false;
      return { exitCode: 1, stdout: '' };
    }
    return fakeRunner(executable, args, input);
  };
  const store = new WindowsDpapiCredentialStore(
    path,
    runner,
    'connection-one',
    environment,
  );

  assert.equal(await store.load(), undefined);
  await store.save(CREDENTIALS);
  assert.deepEqual(await store.load(), CREDENTIALS);
  assert.equal((await readFile(path, 'utf8')).includes('access-secret'), false);
  assert.equal(calls.length >= 3, true);
  for (const call of calls) {
    assert.equal(call.executable, defaultWindowsPowerShellPath(environment));
    assert.deepEqual(call.args.slice(0, 4), [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand',
    ]);
    assert.equal(JSON.stringify(call.args).includes('access-secret'), false);
    assert.equal(JSON.stringify(call.args).includes(path), false);
    assert.equal(JSON.stringify(call.args).includes('connection-one'), false);
    assert.equal(call.input.includes('access-secret'), false);
    assert.equal(call.input.includes(path), false);
    assert.match(call.input, /^[\x20-\x7e]+$/u);
  }

  const otherScope = new WindowsDpapiCredentialStore(
    path,
    fakeDpapiRunner([]),
    'connection-two',
    environment,
  );
  await assert.rejects(
    otherScope.load(),
    /Could not decrypt Agent credentials with Windows DPAPI/,
  );

  failNextLoad = true;
  await assert.rejects(
    store.save({
      ...CREDENTIALS,
      access_token: 'access-secret-replacement',
      refresh_token: 'refresh-secret-replacement',
    }),
    /Could not verify Agent credentials with Windows DPAPI/,
  );
  assert.deepEqual(await store.load(), CREDENTIALS);
  await store.delete();
  assert.equal(await store.load(), undefined);
});

test('Windows DPAPI store fails closed on unavailable protection and oversized ciphertext', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'bailinghub-dpapi-failure-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const unavailablePath = join(directory, 'unavailable.dpapi');
  const unavailable = new WindowsDpapiCredentialStore(
    unavailablePath,
    async () => { throw new Error('raw system detail'); },
    'default',
    { SystemRoot: 'C:\\Windows' },
  );
  await assert.rejects(
    unavailable.save(CREDENTIALS),
    (error) =>
      /credential store is unavailable/.test(error.message) &&
      !error.message.includes('access-secret') &&
      !error.message.includes('raw system detail'),
  );
  await assert.rejects(readFile(unavailablePath), /ENOENT/);

  const oversizedPath = join(directory, 'oversized.dpapi');
  await writeFile(oversizedPath, Buffer.alloc((128 * 1024) + 1));
  const oversized = new WindowsDpapiCredentialStore(
    oversizedPath,
    async () => { throw new Error('runner must not execute'); },
    'default',
    { SystemRoot: 'C:\\Windows' },
  );
  await assert.rejects(oversized.load(), /credential file is invalid/);
});

test('Windows selects CurrentUser DPAPI without a POSIX plaintext opt-in', () => {
  const store = selectCredentialStore(
    {
      LOCALAPPDATA: 'C:\\Users\\Example\\AppData\\Local',
      SystemRoot: 'C:\\Windows',
    },
    'win32',
    async () => ({ exitCode: 1, stdout: '' }),
    'product-desktop',
  );
  assert.equal(store instanceof WindowsDpapiCredentialStore, true);
  assert.equal(store.description, 'Windows DPAPI (CurrentUser)');
});

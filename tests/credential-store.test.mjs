import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmod, mkdtemp, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  AGENT_CLIENT_STORAGE_NAMESPACE_ENV,
  agentStorageNamespaceSegment,
  createCommandRunner,
  defaultFileCredentialPath,
  defaultKeychainCredentialAccount,
  FileCredentialStore,
  MacOsKeychainCredentialStore,
  normalizeAgentStorageNamespace,
  parseAgentCredentials,
  resolveAgentStorageNamespace,
  selectCredentialStore,
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

test('Windows Agent Session credentials fail closed instead of using POSIX file modes', () => {
  assert.throws(
    () =>
      selectCredentialStore(
        { BAILINGHUB_ALLOW_FILE_CREDENTIAL_STORE: 'true' },
        'win32',
      ),
    /not supported on Windows.*Client Token/,
  );
});

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, stat } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  createCommandRunner,
  FileCredentialStore,
  MacOsKeychainCredentialStore,
  parseAgentCredentials,
  selectCredentialStore,
} from '../dist/credential-store.js';

const CREDENTIALS = {
  schema_version: 1,
  base_url: 'https://hub.example.com',
  client_app_id: 'digital-cloud-agent',
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

test('file credential refresh lock destroys unexpected loopback clients', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'bailinghub-lock-'));
  const path = join(directory, 'credentials.json');
  const store = new FileCredentialStore(path);
  const value = createHash('sha256').update(`file:${path}`).digest().readUInt32BE(0);
  const port = 40_000 + (value % 10_000);
  let releaseWork;
  let enteredWork;
  const entered = new Promise((resolve) => {
    enteredWork = resolve;
  });
  const gate = new Promise((resolve) => {
    releaseWork = resolve;
  });
  const locked = store.withRefreshLock(async () => {
    enteredWork();
    await gate;
    return 'released';
  });
  await entered;
  const socket = createConnection({ host: '127.0.0.1', port });
  t.after(() => socket.destroy());
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  releaseWork();
  assert.equal(
    await Promise.race([
      locked,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('refresh lock did not close')), 500),
      ),
    ]),
    'released',
  );
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

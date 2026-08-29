import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  copyFile,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  AgentConnectionRegistry,
  AgentConnectionStore,
} from '../dist/connections.js';
import { WindowsDpapiCredentialStore } from '../dist/credential-store.js';

const WINDOWS_ONLY = { skip: process.platform !== 'win32' };

function credentials(overrides = {}) {
  return {
    schema_version: 1,
    base_url: 'https://hub.example.com',
    client_app_id: 'example-agent-client',
    route: 'orders',
    session_id: 'session-1',
    access_token: 'access-secret-one',
    refresh_token: 'refresh-secret-one',
    access_expires_at: '2099-01-01T00:00:00.000Z',
    refresh_expires_at: '2099-02-01T00:00:00.000Z',
    ...overrides,
  };
}

test('Windows DPAPI persists only ciphertext and survives a process-style restart', WINDOWS_ONLY, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), '百灵-windows-dpapi-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'credentials.dpapi');
  const original = credentials({ session_id: '会话-一' });
  const first = new WindowsDpapiCredentialStore(path, undefined, 'connection-one');
  await first.save(original);

  const ciphertext = await readFile(path);
  assert.equal(ciphertext.includes(Buffer.from('access-secret-one')), false);
  assert.equal(ciphertext.includes(Buffer.from('refresh-secret-one')), false);

  const restarted = new WindowsDpapiCredentialStore(path, undefined, 'connection-one');
  assert.deepEqual(await restarted.load(), original);
  const rotated = credentials({
    access_token: 'access-secret-rotated',
    refresh_token: 'refresh-secret-rotated',
  });
  await restarted.save(rotated);
  assert.deepEqual(await restarted.load(), rotated);
  await restarted.delete();
  assert.equal(await restarted.load(), undefined);
});

test('Windows DPAPI rejects tampering and ciphertext copied across connection scopes', WINDOWS_ONLY, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'bailinghub-windows-dpapi-isolation-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const firstPath = join(directory, 'first.dpapi');
  const secondPath = join(directory, 'second.dpapi');
  const first = new WindowsDpapiCredentialStore(firstPath, undefined, 'connection-one');
  const second = new WindowsDpapiCredentialStore(secondPath, undefined, 'connection-two');
  await first.save(credentials());

  await copyFile(firstPath, secondPath);
  await assert.rejects(
    second.load(),
    /Could not decrypt Agent credentials with Windows DPAPI/,
  );

  const tampered = await readFile(firstPath);
  tampered[Math.floor(tampered.length / 2)] ^= 0xff;
  await writeFile(firstPath, tampered);
  await assert.rejects(
    first.load(),
    /Could not decrypt Agent credentials with Windows DPAPI/,
  );
});

test('Windows Agent connection registry and two DPAPI slots survive restart independently', WINDOWS_ONLY, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'bailinghub-windows-connections-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const registryPath = join(directory, 'agent-connections.json');
  const options = {
    platform: 'win32',
    registry: new AgentConnectionRegistry(registryPath, 'win32'),
    credentialPathFor: (key) => join(directory, `${key}.dpapi`),
  };
  const store = new AgentConnectionStore(options);
  const orders = await store.save(credentials(), { alias: 'orders', makeCurrent: true });
  const staff = await store.save(credentials({
    route: 'staff',
    session_id: 'session-2',
    access_token: 'access-secret-two',
    refresh_token: 'refresh-secret-two',
  }), { alias: 'staff' });

  const restarted = new AgentConnectionStore({
    ...options,
    registry: new AgentConnectionRegistry(registryPath, 'win32'),
  });
  assert.equal((await restarted.registry.current()).connectionKey, orders.connectionKey);
  assert.equal((await restarted.load(orders.connectionKey)).credentials.access_token, 'access-secret-one');
  assert.equal((await restarted.load(staff.connectionKey)).credentials.access_token, 'access-secret-two');
});

test('Windows DPAPI credential slots share the cross-process refresh lock', WINDOWS_ONLY, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'bailinghub-windows-lock-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'credentials.dpapi');
  const moduleUrl = new URL('../dist/credential-store.js', import.meta.url).href;
  const child = spawn(process.execPath, [
    '--input-type=module',
    '--eval',
    `import { WindowsDpapiCredentialStore } from ${JSON.stringify(moduleUrl)};
const store = new WindowsDpapiCredentialStore(process.argv[1], undefined, 'connection-one');
await store.withRefreshLock(async () => {
  process.stdout.write('locked\\n');
  await new Promise((resolve) => process.stdin.once('data', resolve));
});`,
    path,
  ], { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
  t.after(() => child.kill('SIGKILL'));
  const [chunk] = await once(child.stdout, 'data');
  assert.equal(String(chunk), 'locked\n');

  const second = new WindowsDpapiCredentialStore(path, undefined, 'connection-one');
  let entered = false;
  const waiting = second.withRefreshLock(async () => {
    entered = true;
    return 'second';
  });
  await new Promise((resolve) => setTimeout(resolve, 75));
  assert.equal(entered, false);
  child.stdin.end('release\n');
  const [exitCode] = await once(child, 'exit');
  assert.equal(exitCode, 0);
  assert.equal(await waiting, 'second');
});

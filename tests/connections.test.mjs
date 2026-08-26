import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  AgentConnectionRegistry,
  AgentConnectionStore,
  agentConnectionKey,
} from '../dist/connections.js';
import { FileCredentialStore } from '../dist/credential-store.js';

function credentials(overrides = {}) {
  return {
    schema_version: 1,
    base_url: 'https://hub.example.com',
    client_app_id: 'digital-cloud-agent',
    route: 'orders',
    session_id: 'session-1',
    access_token: 'access-secret-one',
    refresh_token: 'refresh-secret-one',
    access_expires_at: '2099-01-01T00:00:00.000Z',
    refresh_expires_at: '2099-02-01T00:00:00.000Z',
    ...overrides,
  };
}

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'bailinghub-connections-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const registry = new AgentConnectionRegistry(join(directory, 'registry.json'));
  const environment = { BAILINGHUB_ALLOW_FILE_CREDENTIAL_STORE: 'true' };
  const store = new AgentConnectionStore({
    environment,
    platform: 'linux',
    registry,
    credentialPathFor: (key) => join(directory, 'credentials', `${key}.json`),
  });
  return { directory, registry, store, environment };
}

test('connection keys bind Hub, client_app_id, and workspace deterministically', () => {
  const base = {
    baseUrl: 'https://hub.example.com/', clientAppId: 'digital-cloud-agent', workspace: 'orders',
  };
  assert.equal(agentConnectionKey(base), agentConnectionKey({ ...base, baseUrl: 'https://hub.example.com' }));
  assert.notEqual(agentConnectionKey(base), agentConnectionKey({ ...base, workspace: 'staff' }));
  assert.notEqual(agentConnectionKey(base), agentConnectionKey({ ...base, clientAppId: 'other-agent' }));
  assert.notEqual(agentConnectionKey(base), agentConnectionKey({ ...base, baseUrl: 'https://other.example.com' }));
  assert.match(agentConnectionKey(base), /^conn_[a-f0-9]{32}$/);
});

test('aliases select isolated credentials while registry metadata never contains tokens', async (t) => {
  const { directory, registry, store } = await fixture(t);
  const orders = await store.save(credentials(), { alias: 'main shop', makeCurrent: true });
  const staff = await store.save(credentials({
    route: 'staff', session_id: 'session-2', access_token: 'access-secret-two',
    refresh_token: 'refresh-secret-two',
  }), { alias: 'staff admin' });

  assert.notEqual(orders.connectionKey, staff.connectionKey);
  assert.equal((await registry.current()).connectionKey, orders.connectionKey);
  assert.equal((await registry.getByAlias('main shop')).connectionKey, orders.connectionKey);
  assert.equal((await registry.getByAlias('staff admin')).connectionKey, staff.connectionKey);
  assert.equal((await store.load(orders.connectionKey)).credentials.access_token, 'access-secret-one');
  assert.equal((await store.load(staff.connectionKey)).credentials.access_token, 'access-secret-two');

  const registryText = await readFile(join(directory, 'registry.json'), 'utf8');
  assert.equal(registryText.includes('access-secret'), false);
  assert.equal(registryText.includes('refresh-secret'), false);
  assert.equal((await stat(join(directory, 'registry.json'))).mode & 0o777, 0o600);
  assert.equal((await stat(join(directory, 'credentials', `${orders.connectionKey}.json`))).mode & 0o777, 0o600);

  const moved = await registry.assignAlias(staff.connectionKey, 'main shop');
  assert.equal(moved.alias, 'main shop');
  assert.equal((await registry.get(orders.connectionKey)).alias, undefined);
  assert.equal((await registry.getByAlias('main shop')).connectionKey, staff.connectionKey);
});

test('legacy default file credentials migrate once into their bound isolated connection', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'bailinghub-migration-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const legacyPath = join(directory, 'legacy.json');
  const legacy = new FileCredentialStore(legacyPath);
  await legacy.save(credentials());
  const registry = new AgentConnectionRegistry(join(directory, 'registry.json'));
  const store = new AgentConnectionStore({
    environment: {
      BAILINGHUB_ALLOW_FILE_CREDENTIAL_STORE: 'true',
      BAILINGHUB_CREDENTIAL_FILE: legacyPath,
    },
    platform: 'linux',
    registry,
    credentialPathFor: (key) => join(directory, 'isolated', `${key}.json`),
  });
  const profile = await store.register({
    baseUrl: 'https://hub.example.com', clientAppId: 'digital-cloud-agent', workspace: 'orders',
  }, { alias: 'default', makeCurrent: true });

  assert.equal(await store.migrateLegacy(profile), 'migrated');
  const loaded = await store.load(profile.connectionKey);
  assert.equal(loaded.credentials.refresh_token, 'refresh-secret-one');
  assert.equal(await legacy.load(), undefined);
  assert.equal(await store.migrateLegacy(profile), 'target_already_exists');
  const registryText = await readFile(join(directory, 'registry.json'), 'utf8');
  assert.equal(registryText.includes('refresh-secret-one'), false);
});

test('legacy migration fails closed on a different Hub-client-workspace binding', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'bailinghub-mismatch-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const legacyPath = join(directory, 'legacy.json');
  const legacy = new FileCredentialStore(legacyPath);
  await legacy.save(credentials({ route: 'staff' }));
  const store = new AgentConnectionStore({
    environment: {
      BAILINGHUB_ALLOW_FILE_CREDENTIAL_STORE: 'true',
      BAILINGHUB_CREDENTIAL_FILE: legacyPath,
    },
    platform: 'linux',
    registry: new AgentConnectionRegistry(join(directory, 'registry.json')),
    credentialPathFor: (key) => join(directory, 'isolated', `${key}.json`),
  });
  const profile = await store.register({
    baseUrl: 'https://hub.example.com', clientAppId: 'digital-cloud-agent', workspace: 'orders',
  }, { alias: 'default' });
  assert.equal(await store.migrateLegacy(profile), 'legacy_connection_mismatch');
  assert.equal((await legacy.load()).route, 'staff');
  assert.equal(await store.credentialStore(profile.connectionKey).load(), undefined);
});

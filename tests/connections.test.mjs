import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  AgentConnectionRegistry,
  AgentConnectionStore,
  agentConnectionInstanceKey,
  agentConnectionKey,
} from '../dist/connections.js';
import { FileCredentialStore } from '../dist/credential-store.js';

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
    baseUrl: 'https://hub.example.com/', clientAppId: 'example-agent-client', workspace: 'orders',
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

test('named instances isolate multiple identities under the same public binding', async (t) => {
  const { directory, registry, store } = await fixture(t);
  const descriptor = {
    baseUrl: 'https://hub.example.com', clientAppId: 'example-agent-client', workspace: 'orders',
  };
  const legacy = await store.register(descriptor, { alias: 'legacy', makeCurrent: true });
  assert.equal(JSON.parse(await readFile(join(directory, 'registry.json'), 'utf8')).schema_version, 1);

  const first = await store.registerInstance(descriptor, { alias: 'identity one' });
  const second = await store.registerInstance(descriptor, { alias: 'identity two' });
  assert.notEqual(first.connectionInstanceId, second.connectionInstanceId);
  assert.notEqual(first.connectionKey, second.connectionKey);
  assert.equal(first.connectionKey, agentConnectionInstanceKey(descriptor, first.connectionInstanceId));
  assert.equal(second.connectionKey, agentConnectionInstanceKey(descriptor, second.connectionInstanceId));
  assert.notEqual(first.connectionKey, legacy.connectionKey);
  await assert.rejects(registry.createInstance(
    { ...descriptor, workspace: 'staff' },
    { alias: 'duplicate instance', instanceId: first.connectionInstanceId },
  ), /unique Agent connection instance/);

  await store.credentialStore(first.connectionKey).save(credentials({
    session_id: 'session-identity-one', access_token: 'access-identity-one',
    refresh_token: 'refresh-identity-one',
  }));
  await store.credentialStore(second.connectionKey).save(credentials({
    session_id: 'session-identity-two', access_token: 'access-identity-two',
    refresh_token: 'refresh-identity-two',
  }));
  assert.equal((await store.load(first.connectionKey)).credentials.session_id, 'session-identity-one');
  assert.equal((await store.load(second.connectionKey)).credentials.session_id, 'session-identity-two');

  const registryText = await readFile(join(directory, 'registry.json'), 'utf8');
  assert.equal(JSON.parse(registryText).schema_version, 2);
  assert.equal(registryText.includes('access-identity'), false);
  assert.equal(registryText.includes('refresh-identity'), false);

  await registry.remove(first.connectionKey);
  assert.equal((await registry.getByAlias('identity two')).connectionKey, second.connectionKey);
  await registry.remove(second.connectionKey);
  assert.equal(JSON.parse(await readFile(join(directory, 'registry.json'), 'utf8')).schema_version, 1);
});

test('registry mutation lock prevents lost updates across instances sharing one metadata file', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'bailinghub-registry-lock-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'registry.json');
  const first = new AgentConnectionRegistry(path);
  const second = new AgentConnectionRegistry(path);
  const descriptor = {
    baseUrl: 'https://hub.example.com', clientAppId: 'example-agent-client', workspace: 'orders',
  };

  await Promise.all(Array.from({ length: 12 }, (_unused, index) =>
    (index % 2 === 0 ? first : second).createInstance(descriptor, { alias: `identity-${index}` })
  ));

  const profiles = await first.list();
  assert.equal(profiles.length, 12);
  assert.equal(new Set(profiles.map((item) => item.alias)).size, 12);
  assert.equal(JSON.parse(await readFile(path, 'utf8')).schema_version, 2);
});

test('registry reconciliation atomically promotes a survivor and retires only the same binding', async (t) => {
  const { registry, store } = await fixture(t);
  const descriptor = {
    baseUrl: 'https://hub.example.com', clientAppId: 'example-agent-client', workspace: 'orders',
  };
  const old = await store.registerInstance(descriptor, { alias: 'selected', makeCurrent: true });
  const survivor = await registry.createInstance(descriptor);
  const unrelated = await store.registerInstance(
    { ...descriptor, workspace: 'staff' },
    { alias: 'unrelated' },
  );

  const promoted = await registry.reconcileToSurvivor(survivor.connectionKey, {
    retiredConnectionKeys: [old.connectionKey],
    alias: 'selected',
  });

  assert.equal(promoted.alias, 'selected');
  assert.equal((await registry.current()).connectionKey, survivor.connectionKey);
  assert.equal(await registry.get(old.connectionKey), undefined);
  assert.equal((await registry.get(unrelated.connectionKey)).alias, 'unrelated');
  await assert.rejects(
    registry.reconcileToSurvivor(survivor.connectionKey, {
      retiredConnectionKeys: [unrelated.connectionKey],
    }),
    /different public binding/u,
  );
});

test('registry reconciliation allocates a readable alias without stealing an existing selector', async (t) => {
  const { registry, store } = await fixture(t);
  const descriptor = {
    baseUrl: 'https://hub.example.com', clientAppId: 'example-agent-client', workspace: 'orders',
  };
  const original = await store.registerInstance(descriptor, { alias: 'selected', makeCurrent: true });
  await store.registerInstance(descriptor, { alias: 'selected-2' });
  const survivor = await registry.createInstance(descriptor);

  const promoted = await registry.reconcileToSurvivor(survivor.connectionKey, {
    allocateAliasFrom: 'selected',
  });

  assert.equal(promoted.alias, 'selected-3');
  assert.equal((await registry.getByAlias('selected')).connectionKey, original.connectionKey);
  assert.equal((await registry.current()).connectionKey, survivor.connectionKey);
  await assert.rejects(
    registry.reconcileToSurvivor(survivor.connectionKey, { alias: 'selected' }),
    /alias is already in use/u,
  );
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
    baseUrl: 'https://hub.example.com', clientAppId: 'example-agent-client', workspace: 'orders',
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
    baseUrl: 'https://hub.example.com', clientAppId: 'example-agent-client', workspace: 'orders',
  }, { alias: 'default' });
  assert.equal(await store.migrateLegacy(profile), 'legacy_connection_mismatch');
  assert.equal((await legacy.load()).route, 'staff');
  assert.equal(await store.credentialStore(profile.connectionKey).load(), undefined);
});

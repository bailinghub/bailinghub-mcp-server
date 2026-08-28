import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  AgentAuthHttpClient,
  AgentSessionManager,
  createLoopbackCallbackReceiver,
  performAgentLogin,
  systemBrowserCommand,
} from '../dist/agent-auth.js';
import {
  FileCredentialStore,
  MemoryCredentialStore,
} from '../dist/credential-store.js';

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const SESSION_RESPONSE = {
  session_id: 'session-1',
  client_app_id: 'example-agent-client',
  device_label: 'My Mac',
  principal: { id: 'admin-1', tenant: 'tenant-1' },
  on_behalf_of: 'example-business:tenant-1:admin-1',
  allowed_routes: ['orders'],
  created_at: '2026-08-25T00:00:00.000Z',
  expires_at: '2026-08-25T01:00:00.000Z',
  refresh_expires_at: '2026-09-25T00:00:00.000Z',
};

const OLD_CREDENTIALS = {
  schema_version: 1,
  base_url: 'https://old-hub.example.com',
  client_app_id: 'example-agent-client',
  route: 'orders',
  session_id: 'old-session',
  access_token: 'old-access-secret',
  refresh_token: 'old-refresh-secret',
  access_expires_at: '2099-08-25T01:00:00.000Z',
  refresh_expires_at: '2099-09-25T00:00:00.000Z',
};

test('authorization page permits HTTPS or explicit nonzero IP loopback, never localhost HTTP', async () => {
  const responseFor = (authorizationUrl) =>
    new AgentAuthHttpClient('https://hub.example.com', async () =>
      jsonResponse(
        {
          authorization_id: 'authorization-1',
          authorization_url: authorizationUrl,
          expires_in: 300,
        },
        201,
      ),
    ).createAuthorization({
      clientAppId: 'example-agent-client',
      redirectUri: 'http://127.0.0.1:43210/callback',
      state: 'state',
      codeChallenge: 'challenge',
      route: 'orders',
      deviceLabel: 'My Mac',
    });

  assert.equal(
    (await responseFor('https://business.example.com/authorize')).authorizationUrl,
    'https://business.example.com/authorize',
  );
  assert.equal(
    (await responseFor('http://127.0.0.1:43211/authorize')).authorizationUrl,
    'http://127.0.0.1:43211/authorize',
  );
  await assert.rejects(responseFor('http://localhost:43211/authorize'), /unsafe/);
  await assert.rejects(responseFor('http://127.0.0.1/authorize'), /unsafe/);
});

test('login uses loopback state and PKCE, validates the session, then persists credentials', async () => {
  const calls = [];
  const browserUrls = [];
  let expectedCallbackState;
  let receiverClosed = false;
  const store = new MemoryCredentialStore(OLD_CREDENTIALS);
  const now = Date.parse('2026-08-25T00:00:00.000Z');
  const fetchImpl = async (url, init) => {
    assert.equal(init.redirect, 'error');
    calls.push({ url: String(url), init, body: init.body ? JSON.parse(init.body) : undefined });
    if (String(url).endsWith('/agent-auth/v1/revoke')) {
      return jsonResponse({ revoked: true });
    }
    if (String(url).endsWith('/agent-auth/v1/authorizations')) {
      return jsonResponse(
        {
          authorization_id: 'authorization-1',
          authorization_url: 'https://business.example.com/agent-authorize?id=authorization-1',
          expires_in: 300,
        },
        201,
      );
    }
    if (String(url).endsWith('/agent-auth/v1/token')) {
      return jsonResponse({
        token_type: 'Bearer',
        access_token: 'new-access-secret',
        expires_in: 3600,
        refresh_token: 'new-refresh-secret',
        refresh_expires_in: 86400,
        session_id: 'session-1',
        client_app_id: 'example-agent-client',
      });
    }
    if (String(url).endsWith('/agent-auth/v1/session')) {
      assert.equal(init.headers.Authorization, 'Bearer new-access-secret');
      return jsonResponse(SESSION_RESPONSE);
    }
    throw new Error('unexpected endpoint');
  };

  const credentials = await performAgentLogin(
    {
      baseUrl: 'https://hub.example.com',
      clientAppId: 'example-agent-client',
      route: 'orders',
      deviceLabel: 'My Mac',
    },
    {
      store,
      fetchImpl,
      now: () => now,
      randomBytesImpl: (length) => Buffer.alloc(length, length),
      createLoopbackReceiver: async (state) => {
        expectedCallbackState = state;
        return {
          redirectUri: 'http://127.0.0.1:43210/callback',
          waitForCallback: async () => ({ code: 'one-time-code', state }),
          close: async () => {
            receiverClosed = true;
          },
        };
      },
      openBrowser: async (url) => browserUrls.push(url),
    },
  );

  assert.equal(calls[0].url, 'https://old-hub.example.com/agent-auth/v1/revoke');
  assert.deepEqual(calls[0].body, {
    client_app_id: 'example-agent-client',
    refresh_token: 'old-refresh-secret',
  });
  const authorizationCall = calls.find((call) =>
    call.url.endsWith('/agent-auth/v1/authorizations'),
  );
  const tokenCall = calls.find((call) => call.url.endsWith('/agent-auth/v1/token'));
  const authorizationBody = authorizationCall.body;
  const verifier = Buffer.alloc(64, 64).toString('base64url');
  assert.deepEqual(authorizationBody, {
    client_app_id: 'example-agent-client',
    redirect_uri: 'http://127.0.0.1:43210/callback',
    state: expectedCallbackState,
    requested_routes: ['orders'],
    device_label: 'My Mac',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
  });
  assert.deepEqual(tokenCall.body, {
    grant_type: 'authorization_code',
    client_app_id: 'example-agent-client',
    code: 'one-time-code',
    redirect_uri: 'http://127.0.0.1:43210/callback',
    code_verifier: verifier,
  });
  assert.deepEqual(browserUrls, [
    'https://business.example.com/agent-authorize?id=authorization-1',
  ]);
  assert.equal(receiverClosed, true);
  assert.equal(credentials.route, 'orders');
  assert.equal(credentials.access_expires_at, '2026-08-25T01:00:00.000Z');
  assert.deepEqual(await store.load(), credentials);
});

test('login keeps the existing credentials and never starts authorization when revoke fails', async () => {
  const store = new MemoryCredentialStore(OLD_CREDENTIALS);
  let receiverCreated = false;
  await assert.rejects(
    performAgentLogin(
      {
        baseUrl: 'https://hub.example.com',
        clientAppId: 'example-agent-client',
        route: 'orders',
        deviceLabel: 'My Mac',
      },
      {
        store,
        fetchImpl: async (url, init) => {
          assert.equal(String(url), 'https://old-hub.example.com/agent-auth/v1/revoke');
          assert.equal(init.redirect, 'error');
          return jsonResponse({}, 503);
        },
        createLoopbackReceiver: async () => {
          receiverCreated = true;
          throw new Error('must not start a new authorization');
        },
      },
    ),
    /existing Agent Session could not be revoked.*local login was kept/,
  );
  assert.equal(receiverCreated, false);
  assert.deepEqual(await store.load(), OLD_CREDENTIALS);
});

test('concurrent login flows are serialized so the replaced session is revoked', async () => {
  const store = new MemoryCredentialStore();
  let issued = 0;
  let activeReceivers = 0;
  let maximumActiveReceivers = 0;
  const revokedRefreshTokens = [];
  const fetchImpl = async (url, init) => {
    if (String(url).endsWith('/agent-auth/v1/authorizations')) {
      return jsonResponse(
        {
          authorization_id: `authorization-${issued + 1}`,
          authorization_url: 'https://business.example.com/agent-authorize',
          expires_in: 300,
        },
        201,
      );
    }
    if (String(url).endsWith('/agent-auth/v1/token')) {
      issued += 1;
      return jsonResponse({
        token_type: 'Bearer',
        access_token: `access-${issued}`,
        expires_in: 3600,
        refresh_token: `refresh-${issued}`,
        refresh_expires_in: 86400,
        session_id: `session-${issued}`,
        client_app_id: 'example-agent-client',
      });
    }
    if (String(url).endsWith('/agent-auth/v1/session')) {
      const suffix = init.headers.Authorization.endsWith('access-1') ? '1' : '2';
      return jsonResponse({ ...SESSION_RESPONSE, session_id: `session-${suffix}` });
    }
    if (String(url).endsWith('/agent-auth/v1/revoke')) {
      revokedRefreshTokens.push(JSON.parse(init.body).refresh_token);
      return jsonResponse({ revoked: true });
    }
    throw new Error('unexpected endpoint');
  };
  const dependencies = {
    store,
    fetchImpl,
    now: () => Date.parse('2026-08-25T00:00:00.000Z'),
    createLoopbackReceiver: async (state) => {
      activeReceivers += 1;
      maximumActiveReceivers = Math.max(maximumActiveReceivers, activeReceivers);
      return {
        redirectUri: 'http://127.0.0.1:43210/callback',
        waitForCallback: async () => ({ code: 'one-time-code', state }),
        close: async () => {
          activeReceivers -= 1;
        },
      };
    },
    openBrowser: async () => undefined,
  };
  const config = {
    baseUrl: 'https://hub.example.com',
    clientAppId: 'example-agent-client',
    route: 'orders',
    deviceLabel: 'My Mac',
  };

  const [first, second] = await Promise.all([
    performAgentLogin(config, dependencies),
    performAgentLogin(config, dependencies),
  ]);
  assert.equal(maximumActiveReceivers, 1);
  assert.equal(first.session_id, 'session-1');
  assert.equal(second.session_id, 'session-2');
  assert.deepEqual(revokedRefreshTokens, ['refresh-1']);
  assert.equal((await store.load()).session_id, 'session-2');
});

test('login revokes the new remote session when secure persistence fails', async () => {
  let revokeBody;
  let closed = false;
  const fetchImpl = async (url, init) => {
    if (String(url).endsWith('/agent-auth/v1/authorizations')) {
      return jsonResponse(
        {
          authorization_id: 'authorization-1',
          authorization_url: 'https://business.example.com/agent-authorize',
          expires_in: 300,
        },
        201,
      );
    }
    if (String(url).endsWith('/agent-auth/v1/token')) {
      return jsonResponse({
        token_type: 'Bearer',
        access_token: 'orphan-access-secret',
        expires_in: 3600,
        refresh_token: 'orphan-refresh-secret',
        refresh_expires_in: 86400,
        session_id: 'session-1',
        client_app_id: 'example-agent-client',
      });
    }
    if (String(url).endsWith('/agent-auth/v1/session')) {
      return jsonResponse(SESSION_RESPONSE);
    }
    if (String(url).endsWith('/agent-auth/v1/revoke')) {
      revokeBody = JSON.parse(init.body);
      return jsonResponse({ revoked: true });
    }
    throw new Error('unexpected endpoint');
  };

  await assert.rejects(
    performAgentLogin(
      {
        baseUrl: 'https://hub.example.com',
        clientAppId: 'example-agent-client',
        route: 'orders',
        deviceLabel: 'My Mac',
      },
      {
        store: {
          description: 'failing store',
          load: async () => undefined,
          save: async () => {
            throw new Error('secure persistence failed');
          },
          delete: async () => undefined,
        },
        fetchImpl,
        now: () => Date.parse('2026-08-25T00:00:00.000Z'),
        createLoopbackReceiver: async (state) => ({
          redirectUri: 'http://127.0.0.1:43210/callback',
          waitForCallback: async () => ({ code: 'one-time-code', state }),
          close: async () => {
            closed = true;
          },
        }),
        openBrowser: async () => undefined,
      },
    ),
    /secure persistence failed/,
  );
  assert.deepEqual(revokeBody, {
    client_app_id: 'example-agent-client',
    refresh_token: 'orphan-refresh-secret',
  });
  assert.equal(closed, true);
});

test('refresh rotates both tokens once for concurrent callers', async () => {
  const now = Date.parse('2026-08-25T00:00:00.000Z');
  const store = new MemoryCredentialStore({
    schema_version: 1,
    base_url: 'https://hub.example.com',
    client_app_id: 'example-agent-client',
    route: 'orders',
    session_id: 'session-1',
    access_token: 'old-access-secret',
    refresh_token: 'old-refresh-secret',
    access_expires_at: new Date(now - 1).toISOString(),
    refresh_expires_at: new Date(now + 86400000).toISOString(),
  });
  let refreshCount = 0;
  const manager = new AgentSessionManager(
    store,
    async (url, init) => {
      if (String(url).endsWith('/agent-auth/v1/token')) {
        assert.deepEqual(JSON.parse(init.body), {
          grant_type: 'refresh_token',
          client_app_id: 'example-agent-client',
          refresh_token: 'old-refresh-secret',
        });
        refreshCount += 1;
        return jsonResponse({
          token_type: 'Bearer',
          access_token: 'rotated-access-secret',
          expires_in: 3600,
          refresh_token: 'rotated-refresh-secret',
          refresh_expires_in: 86400,
          session_id: 'session-1',
          client_app_id: 'example-agent-client',
        });
      }
      assert.equal(String(url), 'https://hub.example.com/agent-auth/v1/session');
      assert.equal(init.headers.Authorization, 'Bearer rotated-access-secret');
      return jsonResponse(SESSION_RESPONSE);
    },
    () => now,
  );

  assert.deepEqual(await Promise.all([manager.getAccessToken(), manager.getAccessToken()]), [
    'rotated-access-secret',
    'rotated-access-secret',
  ]);
  assert.equal(refreshCount, 1);
  assert.equal((await store.load()).refresh_token, 'rotated-refresh-secret');
});

test('distinct file-store instances share the cross-process lock and reload after rotation', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'bailinghub-refresh-lock-'));
  const path = join(directory, 'credentials.json');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const now = Date.parse('2026-08-25T00:00:00.000Z');
  const initial = {
    schema_version: 1,
    base_url: 'https://hub.example.com',
    client_app_id: 'example-agent-client',
    route: 'orders',
    session_id: 'session-1',
    access_token: 'old-access-secret',
    refresh_token: 'old-refresh-secret',
    access_expires_at: new Date(now - 1).toISOString(),
    refresh_expires_at: new Date(now + 86400000).toISOString(),
  };
  const firstStore = new FileCredentialStore(path);
  const secondStore = new FileCredentialStore(path);
  await firstStore.save(initial);
  let refreshCount = 0;
  const refreshFetch = async () => {
    refreshCount += 1;
    await new Promise((resolve) => setTimeout(resolve, 75));
    return jsonResponse({
      token_type: 'Bearer',
      access_token: 'rotated-access-secret',
      expires_in: 3600,
      refresh_token: 'rotated-refresh-secret',
      refresh_expires_in: 86400,
      session_id: 'session-1',
      client_app_id: 'example-agent-client',
    });
  };
  const firstManager = new AgentSessionManager(firstStore, refreshFetch, () => now);
  const secondManager = new AgentSessionManager(secondStore, refreshFetch, () => now);

  assert.deepEqual(
    await Promise.all([
      firstManager.getAccessToken(),
      secondManager.getAccessToken(),
    ]),
    ['rotated-access-secret', 'rotated-access-secret'],
  );
  assert.equal(refreshCount, 1);
  assert.equal((await secondStore.load()).refresh_token, 'rotated-refresh-secret');
});

test('refresh rotation clears stale local credentials when the rotated token cannot be saved', async () => {
  const now = Date.parse('2026-08-25T00:00:00.000Z');
  let stored = {
    schema_version: 1,
    base_url: 'https://hub.example.com',
    client_app_id: 'example-agent-client',
    route: 'orders',
    session_id: 'session-1',
    access_token: 'old-access-secret',
    refresh_token: 'old-refresh-secret',
    access_expires_at: new Date(now - 1).toISOString(),
    refresh_expires_at: new Date(now + 86400000).toISOString(),
  };
  let revokeCount = 0;
  const manager = new AgentSessionManager(
    {
      description: 'failing store',
      load: async () => stored,
      save: async () => {
        throw new Error('do not expose rotated-refresh-secret');
      },
      delete: async () => {
        stored = undefined;
      },
    },
    async (url, init) => {
      assert.equal(init.redirect, 'error');
      if (String(url).endsWith('/agent-auth/v1/revoke')) {
        revokeCount += 1;
        assert.equal(init.headers.Authorization, 'Bearer rotated-access-secret');
        return jsonResponse({ revoked: true });
      }
      return jsonResponse({
        token_type: 'Bearer',
        access_token: 'rotated-access-secret',
        expires_in: 3600,
        refresh_token: 'rotated-refresh-secret',
        refresh_expires_in: 86400,
        session_id: 'session-1',
        client_app_id: 'example-agent-client',
      });
    },
    () => now,
  );

  await assert.rejects(
    manager.getAccessToken(),
    (error) =>
      /local login was removed; run login again/.test(error.message) &&
      !error.message.includes('rotated-refresh-secret'),
  );
  assert.equal(stored, undefined);
  assert.equal(revokeCount, 1);
});

test('session 401 does not delete credentials rotated after the observed access request', async () => {
  const rotated = {
    ...OLD_CREDENTIALS,
    session_id: 'rotated-session',
    access_token: 'rotated-access-secret',
    refresh_token: 'rotated-refresh-secret',
  };
  const store = new MemoryCredentialStore(OLD_CREDENTIALS);
  const observedTokens = [];
  const manager = new AgentSessionManager(store, async (url, init) => {
    assert.equal(String(url), 'https://old-hub.example.com/agent-auth/v1/session');
    const authorization = init.headers.Authorization;
    observedTokens.push(authorization);
    if (authorization === 'Bearer old-access-secret') {
      await store.save(rotated);
      return jsonResponse({}, 401);
    }
    assert.equal(authorization, 'Bearer rotated-access-secret');
    return jsonResponse({
      ...SESSION_RESPONSE,
      session_id: 'rotated-session',
    });
  });

  assert.equal((await manager.getSession()).session_id, 'rotated-session');
  assert.deepEqual(await store.load(), rotated);
  assert.deepEqual(observedTokens, [
    'Bearer old-access-secret',
    'Bearer rotated-access-secret',
  ]);
});

test('logout removes the local login only after remote revocation succeeds', async () => {
  const now = Date.parse('2026-08-25T00:00:00.000Z');
  const store = new MemoryCredentialStore({
    schema_version: 1,
    base_url: 'https://hub.example.com',
    client_app_id: 'example-agent-client',
    route: 'orders',
    session_id: 'session-1',
    access_token: 'access-secret',
    refresh_token: 'refresh-secret',
    access_expires_at: new Date(now + 3600000).toISOString(),
    refresh_expires_at: new Date(now + 86400000).toISOString(),
  });
  const manager = new AgentSessionManager(
    store,
    async (url, init) => {
      assert.equal(String(url), 'https://hub.example.com/agent-auth/v1/revoke');
      assert.equal(init.headers.Authorization, undefined);
      assert.deepEqual(JSON.parse(init.body), {
        client_app_id: 'example-agent-client',
        refresh_token: 'refresh-secret',
      });
      return jsonResponse({ revoked: true });
    },
    () => now,
  );
  assert.deepEqual(await manager.logout(), { hadCredentials: true, remoteRevoked: true });
  assert.equal(await store.load(), undefined);
});

test('logout retains the only local credential when remote revocation fails', async () => {
  const store = new MemoryCredentialStore(OLD_CREDENTIALS);
  const manager = new AgentSessionManager(store, async () => jsonResponse({}, 503));
  await assert.rejects(
    manager.logout(),
    /remote Agent Session could not be revoked.*local login was kept/,
  );
  assert.deepEqual(await store.load(), OLD_CREDENTIALS);
});

test('loopback callback ignores a forged state and accepts one matching callback', async (t) => {
  const receiver = await createLoopbackCallbackReceiver('expected-state');
  t.after(() => receiver.close());
  const forged = await fetch(`${receiver.redirectUri}?code=forged&state=wrong-state`);
  assert.equal(forged.status, 400);
  const pending = receiver.waitForCallback(1000);
  const valid = await fetch(
    `${receiver.redirectUri}?code=one-time-code&state=expected-state`,
  );
  assert.equal(valid.status, 200);
  assert.equal(valid.headers.get('cache-control'), 'no-store');
  assert.equal(valid.headers.get('connection'), 'close');
  assert.deepEqual(await pending, {
    code: 'one-time-code',
    state: 'expected-state',
  });
  await Promise.race([
    receiver.close(),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('loopback receiver did not close')), 500),
    ),
  ]);
});

test('Windows browser launch passes the authorization URL without a command shell', () => {
  const url = 'https://hub.example.com/authorize?id=1&state=a^b|c';
  assert.deepEqual(systemBrowserCommand(url, 'win32'), {
    executable: 'rundll32.exe',
    args: ['url.dll,FileProtocolHandler', url],
  });
});

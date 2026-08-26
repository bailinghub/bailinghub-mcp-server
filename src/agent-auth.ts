import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';

import {
  normalizeAgentRoute,
  normalizeClientAppId,
  type AgentLoginConfig,
} from './config.js';
import type { AgentCredentials, CredentialStore } from './credential-store.js';
import { PACKAGE_VERSION } from './version.js';

const MAX_RESPONSE_BYTES = 1024 * 1024;
const REFRESH_SKEW_MILLISECONDS = 30_000;

type AuthorizationResponse = {
  authorizationId: string;
  authorizationUrl: string;
  expiresIn: number;
};

type TokenResponse = {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  refreshExpiresIn: number;
  sessionId: string;
  clientAppId: string;
};

export type AgentSessionView = {
  session_id: string;
  client_app_id: string;
  device_label: string;
  principal: Record<string, unknown>;
  on_behalf_of: string;
  allowed_routes: string[];
  created_at: string;
  expires_at: string;
  refresh_expires_at: string;
};

export interface AgentAccessTokenProvider {
  getAccessToken(forceRefresh?: boolean): Promise<string>;
}

export type LoopbackCallback = {
  code: string;
  state: string;
};

export type LoopbackCallbackReceiver = {
  redirectUri: string;
  waitForCallback(timeoutMilliseconds: number): Promise<LoopbackCallback>;
  close(): Promise<void>;
};

type LoginDependencies = {
  store: CredentialStore;
  fetchImpl?: typeof fetch;
  createLoopbackReceiver?: (expectedState: string) => Promise<LoopbackCallbackReceiver>;
  openBrowser?: (url: string) => Promise<void>;
  randomBytesImpl?: typeof randomBytes;
  now?: () => number;
};

type LogoutResult = {
  hadCredentials: boolean;
  remoteRevoked: boolean;
};

function withCredentialRefreshLock<T>(
  store: CredentialStore,
  work: () => Promise<T>,
): Promise<T> {
  return store.withRefreshLock ? store.withRefreshLock(work) : work();
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('BailingHub returned an invalid Agent Auth response.');
  }
  return value as Record<string, unknown>;
}

function requiredResponseText(
  record: Record<string, unknown>,
  field: string,
  maximumLength: number,
): string {
  const value = record[field];
  if (typeof value !== 'string') {
    throw new Error('BailingHub returned an invalid Agent Auth response.');
  }
  const text = value.trim();
  if (!text || text.length > maximumLength) {
    throw new Error('BailingHub returned an invalid Agent Auth response.');
  }
  return text;
}

function requiredPositiveInteger(
  record: Record<string, unknown>,
  field: string,
  maximum: number,
): number {
  const value = record[field];
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > maximum) {
    throw new Error('BailingHub returned an invalid Agent Auth response.');
  }
  return Number(value);
}

function parseAuthorizationResponse(value: unknown): AuthorizationResponse {
  const record = asObject(value);
  const authorizationUrl = requiredResponseText(record, 'authorization_url', 4096);
  let parsed: URL;
  try {
    parsed = new URL(authorizationUrl);
  } catch {
    throw new Error('BailingHub returned an unsafe authorization URL.');
  }
  if (parsed.username || parsed.password || !['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('BailingHub returned an unsafe authorization URL.');
  }
  if (
    parsed.protocol === 'http:' &&
    (!['127.0.0.1', '[::1]'].includes(parsed.hostname.toLowerCase()) ||
      !parsed.port ||
      Number(parsed.port) === 0)
  ) {
    throw new Error('BailingHub returned an unsafe authorization URL.');
  }
  return {
    authorizationId: requiredResponseText(record, 'authorization_id', 128),
    authorizationUrl,
    expiresIn: requiredPositiveInteger(record, 'expires_in', 3600),
  };
}

function parseTokenResponse(value: unknown): TokenResponse {
  const record = asObject(value);
  if (record.token_type !== 'Bearer') {
    throw new Error('BailingHub returned an invalid Agent Auth response.');
  }
  return {
    accessToken: requiredResponseText(record, 'access_token', 8192),
    refreshToken: requiredResponseText(record, 'refresh_token', 8192),
    expiresIn: requiredPositiveInteger(record, 'expires_in', 31 * 24 * 60 * 60),
    refreshExpiresIn: requiredPositiveInteger(
      record,
      'refresh_expires_in',
      366 * 24 * 60 * 60,
    ),
    sessionId: requiredResponseText(record, 'session_id', 128),
    clientAppId: requiredResponseText(record, 'client_app_id', 64),
  };
}

function parseSessionView(value: unknown): AgentSessionView {
  const record = asObject(value);
  const principal = asObject(record.principal);
  const allowedRoutes = record.allowed_routes;
  if (
    !Array.isArray(allowedRoutes) ||
    allowedRoutes.length === 0 ||
    allowedRoutes.some(
      (route) => typeof route !== 'string' || !route.trim() || route.length > 64,
    )
  ) {
    throw new Error('BailingHub returned an invalid Agent Session response.');
  }
  const session = {
    session_id: requiredResponseText(record, 'session_id', 128),
    client_app_id: requiredResponseText(record, 'client_app_id', 64),
    device_label: requiredResponseText(record, 'device_label', 128),
    principal,
    on_behalf_of: requiredResponseText(record, 'on_behalf_of', 256),
    allowed_routes: allowedRoutes.map((route) => String(route)),
    created_at: requiredResponseText(record, 'created_at', 100),
    expires_at: requiredResponseText(record, 'expires_at', 100),
    refresh_expires_at: requiredResponseText(record, 'refresh_expires_at', 100),
  };
  if (
    !Number.isFinite(Date.parse(session.created_at)) ||
    !Number.isFinite(Date.parse(session.expires_at)) ||
    !Number.isFinite(Date.parse(session.refresh_expires_at))
  ) {
    throw new Error('BailingHub returned an invalid Agent Session response.');
  }
  return session;
}

async function readJsonWithLimit(response: Response): Promise<unknown> {
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) {
    throw new Error('BailingHub Agent Auth response exceeded the safety limit.');
  }
  if (!response.body) throw new Error('BailingHub returned an empty Agent Auth response.');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error('BailingHub Agent Auth response exceeded the safety limit.');
    }
    chunks.push(value);
  }
  try {
    return JSON.parse(
      Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8'),
    ) as unknown;
  } catch {
    throw new Error('BailingHub returned invalid Agent Auth JSON.');
  }
}

function authorizationHttpError(statusCode: number): Error {
  if (statusCode === 400) return new Error('The Agent authorization is invalid or expired.');
  if (statusCode === 401) return new Error('The BailingHub Agent Session is invalid or expired.');
  if (statusCode === 403) return new Error('The Agent is not allowed to use this route.');
  if (statusCode === 404) return new Error('The Agent authorization was not found.');
  if (statusCode === 409) return new Error('The Agent authorization is no longer pending.');
  if (statusCode === 429) return new Error('Too many Agent authorization requests. Try later.');
  if (statusCode >= 500) return new Error('BailingHub Agent Auth is temporarily unavailable.');
  return new Error(`BailingHub rejected Agent Auth (HTTP ${statusCode}).`);
}

export class AgentAuthHttpClient {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async createAuthorization(input: {
    clientAppId: string;
    redirectUri: string;
    state: string;
    codeChallenge: string;
    route: string;
    deviceLabel: string;
  }): Promise<AuthorizationResponse> {
    const value = await this.request('/agent-auth/v1/authorizations', {
      client_app_id: input.clientAppId,
      redirect_uri: input.redirectUri,
      state: input.state,
      requested_routes: [input.route],
      device_label: input.deviceLabel,
      code_challenge: input.codeChallenge,
      code_challenge_method: 'S256',
    }, 201);
    return parseAuthorizationResponse(value);
  }

  async exchangeCode(input: {
    clientAppId: string;
    code: string;
    redirectUri: string;
    codeVerifier: string;
  }): Promise<TokenResponse> {
    return parseTokenResponse(
      await this.request('/agent-auth/v1/token', {
        grant_type: 'authorization_code',
        client_app_id: input.clientAppId,
        code: input.code,
        redirect_uri: input.redirectUri,
        code_verifier: input.codeVerifier,
      }),
    );
  }

  async refresh(clientAppId: string, refreshToken: string): Promise<TokenResponse> {
    return parseTokenResponse(
      await this.request('/agent-auth/v1/token', {
        grant_type: 'refresh_token',
        client_app_id: clientAppId,
        refresh_token: refreshToken,
      }),
    );
  }

  async getSession(accessToken: string): Promise<AgentSessionView> {
    return parseSessionView(
      await this.request('/agent-auth/v1/session', undefined, 200, accessToken, 'GET'),
    );
  }

  async revoke(input: {
    clientAppId: string;
    refreshToken: string;
    accessToken?: string;
  }): Promise<void> {
    await this.request(
      '/agent-auth/v1/revoke',
      {
        client_app_id: input.clientAppId,
        refresh_token: input.refreshToken,
      },
      200,
      input.accessToken,
    );
  }

  private async request(
    path: string,
    body?: Record<string, unknown>,
    expectedStatus = 200,
    accessToken?: string,
    method: 'GET' | 'POST' = 'POST',
  ): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const headers: Record<string, string> = {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': `bailinghub-mcp-server/${PACKAGE_VERSION}`,
      };
      if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
      const init: RequestInit = {
        method,
        headers,
        redirect: 'error',
        signal: controller.signal,
      };
      if (body !== undefined) init.body = JSON.stringify(body);
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, init);
      if (response.status !== expectedStatus) throw authorizationHttpError(response.status);
      return await readJsonWithLimit(response);
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error('BailingHub Agent Auth request timed out.');
      }
      if (error instanceof TypeError) {
        throw new Error('Could not connect to BailingHub Agent Auth.');
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}

function base64Url(value: Buffer): string {
  return value.toString('base64url');
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!server.listening) {
      server.closeAllConnections();
      resolve();
      return;
    }
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections();
  });
}

export async function createLoopbackCallbackReceiver(
  expectedState: string,
): Promise<LoopbackCallbackReceiver> {
  let settleCallback:
    | { resolve(value: LoopbackCallback): void; reject(error: Error): void }
    | undefined;
  let settled = false;
  const callbackPromise = new Promise<LoopbackCallback>((resolve, reject) => {
    settleCallback = { resolve, reject };
  });
  const server = createServer((request, response) => {
    response.setHeader('Connection', 'close');
    if (request.method !== 'GET' || !request.url) {
      response.writeHead(404).end();
      return;
    }
    let requestUrl: URL;
    try {
      requestUrl = new URL(request.url, 'http://127.0.0.1');
    } catch {
      response.writeHead(400).end();
      return;
    }
    if (requestUrl.pathname !== '/callback') {
      response.writeHead(404).end();
      return;
    }
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Pragma', 'no-cache');
    const state = requestUrl.searchParams.get('state') ?? '';
    if (state !== expectedState) {
      response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Invalid authorization state. You can close this window.');
      return;
    }
    if (settled) {
      response.writeHead(409).end();
      return;
    }
    settled = true;
    const authorizationError = requestUrl.searchParams.get('error');
    if (authorizationError) {
      response.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Authorization was not approved. You can close this window.');
      settleCallback?.reject(new Error('Agent authorization was not approved.'));
      return;
    }
    const code = requestUrl.searchParams.get('code') ?? '';
    if (!code || code.length > 4096) {
      response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Invalid authorization response. You can close this window.');
      settleCallback?.reject(new Error('BailingHub returned an invalid authorization code.'));
      return;
    }
    response.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': "default-src 'none'",
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
    });
    response.end(
      '<!doctype html><meta charset="utf-8"><title>BailingHub</title>' +
        '<p>Authorization completed. You can close this window.</p>',
    );
    settleCallback?.resolve({ code, state });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    await closeServer(server);
    throw new Error('Could not start the local authorization callback.');
  }

  return {
    redirectUri: `http://127.0.0.1:${address.port}/callback`,
    async waitForCallback(timeoutMilliseconds: number) {
      let timeout: NodeJS.Timeout | undefined;
      try {
        return await Promise.race([
          callbackPromise,
          new Promise<LoopbackCallback>((_resolve, reject) => {
            timeout = setTimeout(
              () => reject(new Error('Agent authorization timed out.')),
              timeoutMilliseconds,
            );
          }),
        ]);
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    },
    close: () => closeServer(server),
  };
}

export function systemBrowserCommand(
  url: string,
  platform: NodeJS.Platform = process.platform,
): { executable: string; args: string[] } {
  if (platform === 'darwin') return { executable: '/usr/bin/open', args: [url] };
  if (platform === 'win32') {
    // Avoid cmd.exe: authorization URLs contain shell metacharacters such as '&'.
    return {
      executable: 'rundll32.exe',
      args: ['url.dll,FileProtocolHandler', url],
    };
  }
  return { executable: 'xdg-open', args: [url] };
}

export function openSystemBrowser(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const { executable, args } = systemBrowserCommand(url);
    const child = spawn(executable, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.once('error', () => reject(new Error('Could not open the system browser.')));
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

export async function performAgentLogin(
  config: AgentLoginConfig,
  dependencies: LoginDependencies,
): Promise<AgentCredentials> {
  const route = normalizeAgentRoute(config.route);
  const clientAppId = normalizeClientAppId(config.clientAppId);
  return withCredentialRefreshLock(dependencies.store, async () => {
    const existing = await dependencies.store.load();
    if (existing) {
      try {
        await new AgentAuthHttpClient(existing.base_url, dependencies.fetchImpl).revoke({
          clientAppId: existing.client_app_id,
          refreshToken: existing.refresh_token,
        });
      } catch {
        throw new Error(
          'The existing Agent Session could not be revoked. The local login was kept; retry login later.',
        );
      }
      try {
        await dependencies.store.delete();
      } catch {
        throw new Error(
          'The existing Agent Session was revoked, but its local credentials could not be removed.',
        );
      }
    }
    const randomBytesImpl = dependencies.randomBytesImpl ?? randomBytes;
    const state = base64Url(randomBytesImpl(32));
    const codeVerifier = base64Url(randomBytesImpl(64));
    const codeChallenge = base64Url(createHash('sha256').update(codeVerifier).digest());
    const receiverFactory =
      dependencies.createLoopbackReceiver ?? createLoopbackCallbackReceiver;
    const receiver = await receiverFactory(state);
    const client = new AgentAuthHttpClient(config.baseUrl, dependencies.fetchImpl);
    const now = dependencies.now ?? Date.now;

    try {
      const authorization = await client.createAuthorization({
        clientAppId,
        redirectUri: receiver.redirectUri,
        state,
        codeChallenge,
        route,
        deviceLabel: config.deviceLabel,
      });
      await (dependencies.openBrowser ?? openSystemBrowser)(authorization.authorizationUrl);
      const callback = await receiver.waitForCallback(authorization.expiresIn * 1000);
      if (callback.state !== state) {
        throw new Error('BailingHub returned an invalid authorization state.');
      }
      const token = await client.exchangeCode({
        clientAppId,
        code: callback.code,
        redirectUri: receiver.redirectUri,
        codeVerifier,
      });
      if (token.clientAppId !== clientAppId) {
        throw new Error('BailingHub returned a token for a different Agent client.');
      }
      const session = await client.getSession(token.accessToken);
      if (
        session.session_id !== token.sessionId ||
        session.client_app_id !== clientAppId ||
        !session.allowed_routes.includes(route)
      ) {
        throw new Error('The approved Agent Session does not include the configured route.');
      }
      const sessionExpiresAt = Date.parse(session.expires_at);
      const refreshExpiresAt = Date.parse(session.refresh_expires_at);
      if (sessionExpiresAt <= now() || refreshExpiresAt <= sessionExpiresAt) {
        throw new Error('BailingHub returned an already expired Agent Session.');
      }
      const credentials: AgentCredentials = {
        schema_version: 1,
        base_url: config.baseUrl,
        client_app_id: clientAppId,
        route,
        session_id: token.sessionId,
        access_token: token.accessToken,
        refresh_token: token.refreshToken,
        access_expires_at: new Date(sessionExpiresAt).toISOString(),
        refresh_expires_at: new Date(refreshExpiresAt).toISOString(),
      };
      try {
        await dependencies.store.save(credentials);
      } catch (error) {
        await client
          .revoke({
            clientAppId: credentials.client_app_id,
            refreshToken: credentials.refresh_token,
            accessToken: credentials.access_token,
          })
          .catch(() => undefined);
        throw error;
      }
      return credentials;
    } finally {
      await receiver.close();
    }
  });
}

export class AgentSessionManager implements AgentAccessTokenProvider {
  private refreshInFlight: Promise<AgentCredentials> | undefined;

  constructor(
    private readonly store: CredentialStore,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  async loadRequired(): Promise<AgentCredentials> {
    const credentials = await this.store.load();
    if (!credentials) {
      throw new Error('No Agent login was found. Run bailinghub-mcp-server login first.');
    }
    return credentials;
  }

  async getAccessToken(forceRefresh = false): Promise<string> {
    const credentials = await this.loadRequired();
    if (
      !forceRefresh &&
      Date.parse(credentials.access_expires_at) >
        this.now() + REFRESH_SKEW_MILLISECONDS
    ) {
      return credentials.access_token;
    }
    return (await this.refresh(credentials.refresh_token)).access_token;
  }

  async getSession(): Promise<AgentSessionView> {
    const credentials = await this.loadRequired();
    const token = await this.getAccessToken();
    const session = await new AgentAuthHttpClient(
      credentials.base_url,
      this.fetchImpl,
    ).getSession(token);
    if (
      session.session_id !== credentials.session_id ||
      session.client_app_id !== credentials.client_app_id
    ) {
      throw new Error('The remote Agent Session does not match the local login.');
    }
    return session;
  }

  async logout(): Promise<LogoutResult> {
    return withCredentialRefreshLock(this.store, async () => {
      const credentials = await this.store.load();
      if (!credentials) return { hadCredentials: false, remoteRevoked: true };
      try {
        await new AgentAuthHttpClient(credentials.base_url, this.fetchImpl).revoke({
          clientAppId: credentials.client_app_id,
          refreshToken: credentials.refresh_token,
        });
      } catch {
        throw new Error(
          'The remote Agent Session could not be revoked. The local login was kept so logout can be retried.',
        );
      }
      await this.store.delete();
      return { hadCredentials: true, remoteRevoked: true };
    });
  }

  private refresh(observedRefreshToken: string): Promise<AgentCredentials> {
    if (this.refreshInFlight) return this.refreshInFlight;
    this.refreshInFlight = withCredentialRefreshLock(this.store, () =>
      this.performRefresh(observedRefreshToken),
    ).finally(() => {
      this.refreshInFlight = undefined;
    });
    return this.refreshInFlight;
  }

  private async performRefresh(observedRefreshToken: string): Promise<AgentCredentials> {
    const current = await this.loadRequired();
    if (current.refresh_token !== observedRefreshToken) {
      return current;
    }
    if (Date.parse(current.refresh_expires_at) <= this.now()) {
      throw new Error('The Agent login has expired. Run bailinghub-mcp-server login again.');
    }
    const refreshStartedAt = this.now();
    const client = new AgentAuthHttpClient(
      current.base_url,
      this.fetchImpl,
    );
    const token = await client.refresh(current.client_app_id, current.refresh_token);
    if (
      token.clientAppId !== current.client_app_id ||
      token.sessionId !== current.session_id
    ) {
      throw new Error('BailingHub returned a refresh token for a different Agent Session.');
    }
    const next: AgentCredentials = {
      ...current,
      access_token: token.accessToken,
      refresh_token: token.refreshToken,
      // Anchor relative lifetimes before the network request so local expiry can only be
      // conservative; a slow response must never extend a server-issued lifetime.
      access_expires_at: new Date(
        refreshStartedAt + token.expiresIn * 1000,
      ).toISOString(),
      refresh_expires_at: new Date(
        refreshStartedAt + token.refreshExpiresIn * 1000,
      ).toISOString(),
    };
    try {
      await this.store.save(next);
    } catch {
      await client
        .revoke({
          clientAppId: next.client_app_id,
          refreshToken: next.refresh_token,
          accessToken: next.access_token,
        })
        .catch(() => undefined);
      try {
        await this.store.delete();
      } catch {
        throw new Error(
          'Agent token rotation could not be persisted or removed. Remove the local login before retrying.',
        );
      }
      throw new Error(
        'Agent token rotation could not be persisted. The local login was removed; run login again.',
      );
    }
    return next;
  }
}

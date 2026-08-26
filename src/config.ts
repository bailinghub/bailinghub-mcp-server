const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const ROUTE_PATTERN = /^[a-z0-9][a-z0-9_-]{1,63}$/;
const CLIENT_APP_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{1,63}$/;

export type BailingHubMcpConfig = {
  mode?: 'client';
  baseUrl: string;
  clientToken: string;
  route: string;
};

export type AgentLoginConfig = {
  baseUrl: string;
  clientAppId: string;
  route: string;
  deviceLabel: string;
};

function requiredText(
  value: string | undefined,
  name: string,
  maximumLength?: number,
): string {
  const text = String(value ?? '').trim();
  if (!text) throw new Error(`${name} is required.`);
  if (maximumLength !== undefined && text.length > maximumLength) {
    throw new Error(`${name} must not exceed ${maximumLength} characters.`);
  }
  return text;
}

export function booleanFlag(value: string | undefined, name: string): boolean {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!normalized || normalized === 'false' || normalized === '0') return false;
  if (normalized === 'true' || normalized === '1') return true;
  throw new Error(`${name} must be true or false.`);
}

export function normalizeRoute(value: string | undefined): string {
  const route = requiredText(value, 'BAILINGHUB_ROUTE', 64);
  if (!ROUTE_PATTERN.test(route)) {
    throw new Error('BAILINGHUB_ROUTE must match ^[a-z0-9][a-z0-9_-]{1,63}$.');
  }
  return route;
}

export function normalizeAgentRoute(value: string | undefined): string {
  const route = normalizeRoute(value);
  if (route === 'auto') {
    throw new Error('BAILINGHUB_ROUTE=auto is not allowed for Agent login.');
  }
  return route;
}

export function normalizeClientAppId(value: string | undefined): string {
  const clientAppId = requiredText(value, 'BAILINGHUB_CLIENT_APP_ID', 64);
  if (!CLIENT_APP_ID_PATTERN.test(clientAppId)) {
    throw new Error(
      'BAILINGHUB_CLIENT_APP_ID must match ^[a-z0-9][a-z0-9_-]{1,63}$.',
    );
  }
  return clientAppId;
}

export function normalizeBaseUrl(value: string, allowInsecureHttp = false): string {
  const raw = requiredText(value, 'BAILINGHUB_BASE_URL');
  if (!URL.canParse(raw)) {
    throw new Error('BAILINGHUB_BASE_URL must be an absolute HTTP(S) URL.');
  }

  const parsed = new URL(raw);
  if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) {
    throw new Error('BAILINGHUB_BASE_URL must be an absolute HTTP(S) URL.');
  }
  if (parsed.username || parsed.password) {
    throw new Error('BAILINGHUB_BASE_URL must not contain embedded credentials.');
  }
  if (parsed.search || parsed.hash) {
    throw new Error('BAILINGHUB_BASE_URL must not contain a query string or fragment.');
  }
  if (
    parsed.protocol === 'http:' &&
    !allowInsecureHttp &&
    !LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase())
  ) {
    throw new Error(
      'Use HTTPS for non-loopback BailingHub connections, or explicitly set ' +
        'BAILINGHUB_ALLOW_INSECURE_HTTP=true.',
    );
  }

  parsed.pathname = parsed.pathname.replace(/\/+$/, '');
  return parsed.toString().replace(/\/$/, '');
}

export function loadConfig(
  environment: NodeJS.ProcessEnv = process.env,
): BailingHubMcpConfig {
  const allowInsecureHttp = booleanFlag(
    environment.BAILINGHUB_ALLOW_INSECURE_HTTP,
    'BAILINGHUB_ALLOW_INSECURE_HTTP',
  );
  const route = normalizeRoute(environment.BAILINGHUB_ROUTE);

  return {
    baseUrl: normalizeBaseUrl(
      requiredText(environment.BAILINGHUB_BASE_URL, 'BAILINGHUB_BASE_URL'),
      allowInsecureHttp,
    ),
    clientToken: requiredText(
      environment.BAILINGHUB_CLIENT_TOKEN,
      'BAILINGHUB_CLIENT_TOKEN',
    ),
    route,
  };
}

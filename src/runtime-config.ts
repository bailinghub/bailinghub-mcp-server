import { AgentSessionManager, type AgentAccessTokenProvider } from './agent-auth.js';
import {
  booleanFlag,
  loadConfig,
  normalizeAgentRoute,
  normalizeBaseUrl,
  normalizeClientAppId,
  type BailingHubMcpConfig,
} from './config.js';
import {
  selectCredentialStore,
  type CredentialStore,
} from './credential-store.js';

export type AgentBailingHubMcpConfig = {
  mode: 'agent';
  baseUrl: string;
  route: string;
  clientAppId: string;
  sessionId: string;
  accessTokenProvider: AgentAccessTokenProvider;
};

export type BailingHubRuntimeConfig =
  | BailingHubMcpConfig
  | AgentBailingHubMcpConfig;

export async function loadRuntimeConfig(
  environment: NodeJS.ProcessEnv = process.env,
  store?: CredentialStore,
): Promise<BailingHubRuntimeConfig> {
  if (String(environment.BAILINGHUB_CLIENT_TOKEN ?? '').trim()) {
    return loadConfig(environment);
  }

  const credentialStore = store ?? selectCredentialStore(environment);
  const manager = new AgentSessionManager(credentialStore);
  const credentials = await manager.loadRequired();
  const allowInsecureHttp = booleanFlag(
    environment.BAILINGHUB_ALLOW_INSECURE_HTTP,
    'BAILINGHUB_ALLOW_INSECURE_HTTP',
  );
  const baseUrl = normalizeBaseUrl(
    credentials.base_url,
    allowInsecureHttp,
  );
  const route = normalizeAgentRoute(credentials.route);
  const clientAppId = normalizeClientAppId(credentials.client_app_id);

  const configuredBaseUrl = String(environment.BAILINGHUB_BASE_URL ?? '').trim();
  if (
    configuredBaseUrl &&
    normalizeBaseUrl(configuredBaseUrl, allowInsecureHttp) !== baseUrl
  ) {
    throw new Error(
      'BAILINGHUB_BASE_URL does not match the stored Agent login. Run login again for this Hub.',
    );
  }
  const configuredRoute = String(environment.BAILINGHUB_ROUTE ?? '').trim();
  if (configuredRoute && normalizeAgentRoute(configuredRoute) !== route) {
    throw new Error(
      'BAILINGHUB_ROUTE does not match the stored Agent login. Run login again for this route.',
    );
  }

  return {
    mode: 'agent',
    baseUrl,
    route,
    clientAppId,
    sessionId: credentials.session_id,
    accessTokenProvider: manager,
  };
}

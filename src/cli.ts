import {
  AgentSessionManager,
  performAgentLogin,
  type LoopbackCallbackReceiver,
} from './agent-auth.js';
import {
  booleanFlag,
  normalizeAgentRoute,
  normalizeBaseUrl,
  normalizeClientAppId,
  type AgentLoginConfig,
} from './config.js';
import {
  selectCredentialStore,
  type CredentialStore,
} from './credential-store.js';
import { PACKAGE_VERSION } from './version.js';

const HELP = `BailingHub MCP Server ${PACKAGE_VERSION}

Usage:
  bailinghub-mcp-server                     Start the MCP stdio server
  bailinghub-mcp-server login [options]     Authorize this local Agent
  bailinghub-mcp-server status              Check the current Agent login
  bailinghub-mcp-server logout              Revoke and remove the Agent login

Login options:
  --base-url <url>        BailingHub origin (or BAILINGHUB_BASE_URL)
  --client-app-id <id>    Registered public Agent client (or BAILINGHUB_CLIENT_APP_ID)
  --route <route>         Route requested for this Agent (or BAILINGHUB_ROUTE)
  --device-label <label>  Human-readable device label
  --allow-insecure-http   Allow HTTP for a non-loopback trusted private network

On macOS credentials are stored in Keychain. Linux and other POSIX platforms require
the explicit BAILINGHUB_ALLOW_FILE_CREDENTIAL_STORE=true opt-in and use a mode-0600
file. Windows stores Agent Session credentials as CurrentUser DPAPI-protected files.
`;

type CliDependencies = {
  environment?: NodeJS.ProcessEnv;
  store?: CredentialStore;
  fetchImpl?: typeof fetch;
  openBrowser?: (url: string) => Promise<void>;
  createLoopbackReceiver?: (expectedState: string) => Promise<LoopbackCallbackReceiver>;
  now?: () => number;
  stdout?: (value: string) => void;
};

type ParsedLoginOptions = {
  baseUrl?: string;
  clientAppId?: string;
  route?: string;
  deviceLabel?: string;
  allowInsecureHttp: boolean;
};

function parseLoginOptions(args: string[]): ParsedLoginOptions {
  const parsed: ParsedLoginOptions = { allowInsecureHttp: false };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--allow-insecure-http') {
      parsed.allowInsecureHttp = true;
      continue;
    }
    if (!argument?.startsWith('--')) {
      throw new Error('Unexpected login argument.');
    }
    const value = args[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`${argument} requires a value.`);
    }
    index += 1;
    if (argument === '--base-url') parsed.baseUrl = value;
    else if (argument === '--client-app-id') parsed.clientAppId = value;
    else if (argument === '--route') parsed.route = value;
    else if (argument === '--device-label') parsed.deviceLabel = value;
    else throw new Error('Unknown login option.');
  }
  return parsed;
}

function deviceLabel(value: string | undefined): string {
  const label = String(value ?? 'bailinghub-mcp-server').trim();
  if (!label || label.length > 128 || /[\u0000-\u001f\u007f]/.test(label)) {
    throw new Error('The device label must contain 1 to 128 printable characters.');
  }
  return label;
}

function loginConfig(
  options: ParsedLoginOptions,
  environment: NodeJS.ProcessEnv,
): AgentLoginConfig {
  const environmentAllowsHttp = booleanFlag(
    environment.BAILINGHUB_ALLOW_INSECURE_HTTP,
    'BAILINGHUB_ALLOW_INSECURE_HTTP',
  );
  return {
    baseUrl: normalizeBaseUrl(
      options.baseUrl ?? String(environment.BAILINGHUB_BASE_URL ?? ''),
      options.allowInsecureHttp || environmentAllowsHttp,
    ),
    clientAppId: normalizeClientAppId(
      options.clientAppId ?? environment.BAILINGHUB_CLIENT_APP_ID,
    ),
    route: normalizeAgentRoute(options.route ?? environment.BAILINGHUB_ROUTE),
    deviceLabel: deviceLabel(options.deviceLabel),
  };
}

export async function runCli(
  args: string[],
  dependencies: CliDependencies = {},
): Promise<boolean> {
  const command = args[0];
  const write = dependencies.stdout ?? ((value: string) => console.log(value));
  if (!command) return false;
  if (command === '--help' || command === '-h' || command === 'help') {
    write(HELP.trimEnd());
    return true;
  }
  if (command === '--version' || command === '-v' || command === 'version') {
    write(PACKAGE_VERSION);
    return true;
  }
  if (!['login', 'status', 'logout'].includes(command)) {
    throw new Error('Unknown command. Run bailinghub-mcp-server --help.');
  }

  const environment = dependencies.environment ?? process.env;
  const store = dependencies.store ?? selectCredentialStore(environment);
  if (command === 'login') {
    const config = loginConfig(parseLoginOptions(args.slice(1)), environment);
    const credentials = await performAgentLogin(config, {
      store,
      ...(dependencies.fetchImpl ? { fetchImpl: dependencies.fetchImpl } : {}),
      ...(dependencies.openBrowser ? { openBrowser: dependencies.openBrowser } : {}),
      ...(dependencies.createLoopbackReceiver
        ? { createLoopbackReceiver: dependencies.createLoopbackReceiver }
        : {}),
      ...(dependencies.now ? { now: dependencies.now } : {}),
    });
    write(
      JSON.stringify({
        status: 'logged_in',
        base_url: credentials.base_url,
        client_app_id: credentials.client_app_id,
        route: credentials.route,
        session_id: credentials.session_id,
        credential_store: store.description,
      }),
    );
    return true;
  }

  if (args.length !== 1) throw new Error(`${command} does not accept arguments.`);
  const manager = new AgentSessionManager(store, dependencies.fetchImpl);
  if (command === 'status') {
    const credentials = await manager.loadRequired();
    const session = await manager.getSession();
    write(
      JSON.stringify({
        status: 'logged_in',
        base_url: credentials.base_url,
        client_app_id: session.client_app_id,
        route: credentials.route,
        session_id: session.session_id,
        device_label: session.device_label,
        on_behalf_of: session.on_behalf_of,
        allowed_routes: session.allowed_routes,
        expires_at: session.expires_at,
        refresh_expires_at: session.refresh_expires_at,
        credential_store: store.description,
      }),
    );
    return true;
  }

  const result = await manager.logout();
  write(
    JSON.stringify({
      status: result.hadCredentials ? 'logged_out' : 'not_logged_in',
      remote_revoked: result.remoteRevoked,
      local_credentials_removed: true,
    }),
  );
  return true;
}

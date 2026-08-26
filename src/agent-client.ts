import type { AgentAccessTokenProvider } from './agent-auth.js';
import {
  AGENT_TOOL_INVOCATION_STATES,
  BailingHubClientError,
  CLIENT_API_LIMITS,
  type AgentToolCatalogEntry,
  type AgentToolInvocation,
  type AgentToolInvocationState,
} from './client.js';
import { normalizeAgentRoute, normalizeBaseUrl, normalizeClientAppId } from './config.js';
import { PACKAGE_VERSION } from './version.js';

const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;
const INVOCATION_ID_PATTERN = /^[0-9a-f]{64}$/;
const TOOL_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const REVISION_PATTERN = /^[a-f0-9]{64}$/;
const MESSAGE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const RISK_VALUES = new Set(['low', 'medium', 'high']);
const INVOCATION_STATES = new Set<string>(AGENT_TOOL_INVOCATION_STATES);
const RUN_COMPLETION_STATUSES = new Set(['completed', 'failed', 'cancelled']);
const MAX_ACTIVE_TOOLS = 12;
const MAX_WORKSPACES = 128;
const MAX_RENDERERS = 20;
const MAX_CONTEXT_BYTES = 64 * 1024;
const MAX_USAGE_BYTES = 16 * 1024;
const MAX_PAGE_CONTEXT_BYTES = 16 * 1024;
const MAX_VISIBLE_CONTENT = 64_000;
const USAGE_KEYS = new Set([
  'input_tokens',
  'cached_input_tokens',
  'output_tokens',
  'total_tokens',
  'tool_calls',
  'cost_usd',
]);
const PUBLIC_AGENT_ERROR_CODES = new Set([
  'agent_client_disabled',
  'agent_direct_disabled',
  'agent_runtime_unavailable',
  'agent_tools_unavailable',
  'arguments_too_large',
  'assistant_message_conflict',
  'audience_not_allowed',
  'capability_changed',
  'hub_paused',
  'invalid_request',
  'invalid_route',
  'invocation_conflict',
  'invocation_not_found',
  'page_context_too_large',
  'route_not_allowed',
  'route_unavailable',
  'run_completion_conflict',
  'run_not_found',
  'tool_not_found',
  'turn_conflict',
]);

export const AGENT_CLIENT_V1_PATHS = {
  workspaces: '/agent-api/v1/workspaces',
  bootstrap: (route: string) =>
    `/agent-api/v1/workspaces/${encodeURIComponent(route)}/bootstrap`,
  turns: (route: string) =>
    `/agent-api/v1/workspaces/${encodeURIComponent(route)}/turns`,
  capabilitySearch: (route: string) =>
    `/agent-api/v1/workspaces/${encodeURIComponent(route)}/capabilities/search`,
  invocations: '/agent-api/v1/tool-invocations',
  resumeInvocation: (invocationId: string) =>
    `/agent-api/v1/tool-invocations/${encodeURIComponent(invocationId)}/resume`,
  completeRun: (runId: string) =>
    `/agent-api/v1/runs/${encodeURIComponent(runId)}/complete`,
} as const;

export type AgentClientConnection = {
  baseUrl: string;
  clientAppId: string;
  workspace: string;
  sessionId: string;
  accessTokenProvider: AgentAccessTokenProvider;
};

export type AgentWorkspace = {
  route: string;
  name: string;
  description?: string;
};

export type AgentWorkspaceList = {
  schema: 'bailing.agent-workspaces.v1';
  workspaces: AgentWorkspace[];
  etag?: string;
  not_modified?: boolean;
};

export type AgentRuntimeProfile = {
  schema: 'bailing.agent-runtime-profile.v1';
  workspace: AgentWorkspace;
  profile: {
    revision: string;
    instructions: string;
    knowledge?: unknown;
    memory?: unknown;
    memory_refs?: unknown[];
    knowledge_refs?: unknown[];
    governance?: Record<string, unknown>;
    renderers?: string[];
  };
  capabilities: {
    revision: string;
    active_tools?: AgentToolCatalogEntry[];
    authorized_total?: number;
    active_limit?: number;
    readonly?: number;
    writes?: number;
    approval_required?: number;
  };
  etag?: string;
  not_modified?: boolean;
};

export type StartAgentTurnInput = {
  clientConversationId: string;
  clientTurnId: string;
  userMessageId: string;
  userInput: string;
  pageContext?: Record<string, unknown>;
  renderers?: string[];
};

export type AgentTurnContext = {
  schema: 'bailing.agent-turn-context.v1';
  run_id: string;
  profile_revision: string;
  capability_revision: string;
  context: {
    instructions: string;
    page_context: Record<string, unknown>;
    renderers: string[];
    memory: unknown;
    memory_refs: unknown[];
    knowledge: unknown[];
    knowledge_refs: unknown[];
    governance: Record<string, unknown>;
  };
  active_tools: AgentToolCatalogEntry[];
};

export type SearchAgentCapabilitiesInput = {
  query?: string;
  limit?: number;
  runId?: string;
};

export type AgentCapabilitySearchResult = {
  schema: 'bailing.agent-capability-search.v1';
  capability_revision: string;
  tools: AgentToolCatalogEntry[];
};

export type InvokeAgentCapabilityInput = {
  invocationId: string;
  capabilityRevision: string;
  agentRunId: string;
  tool: string;
  arguments: Record<string, unknown>;
};

export type CompleteAgentRunInput = {
  assistantMessageId: string;
  content: string;
  status: 'completed' | 'failed' | 'cancelled';
  model?: string;
  runtime?: string;
  usage?: Record<string, unknown>;
};

export type AgentRunCompletion = {
  schema: 'bailing.agent-run-completion.v1';
  run_id: string;
  status: 'completed' | 'failed' | 'cancelled';
};

type AgentTransportResponse = {
  status: number;
  body?: unknown;
  etag?: string;
};

type AgentRequestOptions = {
  expectedStatus?: number;
  ifNoneMatch?: string;
  acceptedUnknownOnFailure?: boolean;
};

function asObject(value: unknown, label = 'response'): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BailingHubClientError(`BailingHub returned an invalid Agent ${label}.`);
  }
  return value as Record<string, unknown>;
}

function responseSchema(body: Record<string, unknown>): string {
  const schema = body.schema ?? body.schema_version;
  return typeof schema === 'string' ? schema : '';
}

function requiredString(
  value: unknown,
  label: string,
  maximumLength: number,
): string {
  if (typeof value !== 'string') {
    throw new BailingHubClientError(`BailingHub returned an invalid ${label}.`);
  }
  const text = value.trim();
  if (!text || text.length > maximumLength || /[\u0000-\u001f\u007f]/.test(text)) {
    throw new BailingHubClientError(`BailingHub returned an invalid ${label}.`);
  }
  return text;
}

function requiredContent(
  value: unknown,
  label: string,
  maximumLength: number,
): string {
  if (typeof value !== 'string') {
    throw new BailingHubClientError(`BailingHub returned an invalid ${label}.`);
  }
  if (
    !value.trim() ||
    value.length > maximumLength ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
  ) {
    throw new BailingHubClientError(`BailingHub returned an invalid ${label}.`);
  }
  return value;
}

function identifierText(value: unknown, label: string, maximumLength: number): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a string.`);
  const text = value.trim();
  if (!text || text.length > maximumLength || /[\u0000-\u001f\u007f]/.test(text)) {
    throw new Error(`${label} is invalid.`);
  }
  return text;
}

function contentText(value: unknown, label: string, maximumLength: number): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a string.`);
  if (
    !value.trim() ||
    value.length > maximumLength ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
  ) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function revision(value: unknown, label: string): string {
  const text = requiredString(value, label, 128);
  if (!REVISION_PATTERN.test(text)) {
    throw new BailingHubClientError(`BailingHub returned an invalid ${label}.`);
  }
  return text;
}

function assertJsonBounded(value: unknown, label: string, maximumBytes: number): void {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error(`${label} must be JSON serializable.`);
  }
  if (serialized === undefined || Buffer.byteLength(serialized) > maximumBytes) {
    throw new Error(`${label} exceeds the safety limit.`);
  }
}

function optionalRecord(
  value: unknown,
  label: string,
  maximumBytes = MAX_CONTEXT_BYTES,
): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  assertJsonBounded(value, label, maximumBytes);
  return value as Record<string, unknown>;
}

function normalizedUsage(value: unknown): Record<string, unknown> | undefined {
  const usage = optionalRecord(value, 'usage', MAX_USAGE_BYTES);
  if (!usage) return undefined;
  const normalized: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(usage)) {
    if (!USAGE_KEYS.has(key)) throw new Error(`usage.${key} is not supported.`);
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) {
      throw new Error(`usage.${key} must be a non-negative number.`);
    }
    normalized[key] = raw;
  }
  return normalized;
}

function normalizedRenderers(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > MAX_RENDERERS) {
    throw new Error(`renderers must contain at most ${MAX_RENDERERS} entries.`);
  }
  const items = value.map((item) => identifierText(item, 'renderer', 64));
  if (new Set(items).size !== items.length) throw new Error('renderers must be unique.');
  return items;
}

function optionalCount(
  value: unknown,
  label: string,
  maximum = Number.MAX_SAFE_INTEGER,
): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || Number(value) < 0 || Number(value) > maximum) {
    throw new BailingHubClientError(`BailingHub returned an invalid ${label}.`);
  }
  return Number(value);
}

function normalizeWorkspace(value: unknown, expectedRoute?: string): AgentWorkspace {
  const body = asObject(value, 'workspace');
  const route = requiredString(body.route ?? body.route_key, 'workspace route', 64);
  try {
    normalizeAgentRoute(route);
  } catch {
    throw new BailingHubClientError('BailingHub returned an invalid workspace route.');
  }
  if (expectedRoute && route !== expectedRoute) {
    throw new BailingHubClientError('BailingHub returned a different Agent workspace.');
  }
  const name = typeof body.name === 'string' && body.name.trim()
    ? requiredString(body.name, 'workspace name', 256)
    : route;
  const description = typeof body.description === 'string' && body.description.trim()
    ? requiredContent(body.description, 'workspace description', 2_000)
    : undefined;
  return { route, name, ...(description ? { description } : {}) };
}

function normalizeInputSchema(value: unknown): Record<string, unknown> {
  const schema = asObject(value, 'tool input_schema');
  if (schema.type !== 'object') {
    throw new BailingHubClientError(
      'BailingHub returned a tool input_schema that is not an object schema.',
    );
  }
  assertJsonBounded(schema, 'tool input_schema', 64 * 1024);
  return schema;
}

function normalizeTool(value: unknown): AgentToolCatalogEntry {
  const body = asObject(value, 'tool definition');
  const name = requiredString(body.name, 'tool name', 64);
  const description = requiredContent(
    body.description,
    'tool description',
    CLIENT_API_LIMITS.toolDescription,
  );
  const scope = requiredString(body.scope, 'tool scope', 256);
  const risk = requiredString(body.risk, 'tool risk', 16);
  if (!TOOL_NAME_PATTERN.test(name) || !RISK_VALUES.has(risk)) {
    throw new BailingHubClientError('BailingHub returned an invalid Agent tool definition.');
  }
  for (const key of ['approval_required', 'readonly', 'idempotent'] as const) {
    if (typeof body[key] !== 'boolean') {
      throw new BailingHubClientError('BailingHub returned an invalid Agent tool definition.');
    }
  }
  return {
    name,
    description,
    input_schema: normalizeInputSchema(body.input_schema),
    scope,
    risk: risk as AgentToolCatalogEntry['risk'],
    approval_required: body.approval_required as boolean,
    readonly: body.readonly as boolean,
    idempotent: body.idempotent as boolean,
  };
}

function normalizeTools(value: unknown, label: string): AgentToolCatalogEntry[] {
  if (!Array.isArray(value) || value.length > MAX_ACTIVE_TOOLS) {
    throw new BailingHubClientError(
      `BailingHub returned an invalid ${label}; at most ${MAX_ACTIVE_TOOLS} active tools are allowed.`,
    );
  }
  const tools = value.map(normalizeTool);
  if (new Set(tools.map((tool) => tool.name)).size !== tools.length) {
    throw new BailingHubClientError(`BailingHub returned duplicate tools in ${label}.`);
  }
  return tools;
}

function normalizeInvocation(
  value: unknown,
  expected: { invocationId: string; route: string; tool?: string },
): AgentToolInvocation {
  const body = asObject(value, 'tool invocation');
  const schema = responseSchema(body);
  if (schema !== 'bailing.agent-tool-invocation.v1') {
    throw new BailingHubClientError('BailingHub returned an unsupported Agent invocation.');
  }
  const invocationId = requiredString(body.invocation_id, 'invocation_id', 64);
  const route = requiredString(body.route, 'invocation route', 64);
  const tool = requiredString(body.tool, 'invocation tool', 64);
  const state = requiredString(body.state, 'invocation state', 64);
  if (
    invocationId !== expected.invocationId ||
    route !== expected.route ||
    (expected.tool && tool !== expected.tool) ||
    !INVOCATION_ID_PATTERN.test(invocationId) ||
    !TOOL_NAME_PATTERN.test(tool) ||
    !INVOCATION_STATES.has(state) ||
    typeof body.ok !== 'boolean' ||
    typeof body.auto_retry_allowed !== 'boolean' ||
    typeof body.text !== 'string' ||
    body.text.length > CLIENT_API_LIMITS.toolResultText
  ) {
    throw new BailingHubClientError('BailingHub returned an invalid Agent invocation.');
  }
  const result: AgentToolInvocation = {
    schema_version: 'bailing.agent-tool-invocation.v1',
    invocation_id: invocationId,
    route,
    tool,
    state: state as AgentToolInvocationState,
    ok: body.ok,
    auto_retry_allowed: body.auto_retry_allowed,
    text: body.text,
  };
  if (body.business_status !== undefined) {
    if (!Number.isInteger(body.business_status) || Number(body.business_status) < 100 || Number(body.business_status) > 599) {
      throw new BailingHubClientError('BailingHub returned an invalid business_status.');
    }
    result.business_status = Number(body.business_status);
  }
  if (body.approval_id !== undefined) {
    if (!Number.isInteger(body.approval_id) || Number(body.approval_id) < 1) {
      throw new BailingHubClientError('BailingHub returned an invalid approval_id.');
    }
    result.approval_id = Number(body.approval_id);
  }
  return result;
}

async function readJsonWithLimit(response: Response): Promise<unknown> {
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > CLIENT_API_LIMITS.responseBytes) {
    throw new BailingHubClientError('BailingHub response exceeded the 1 MiB safety limit.');
  }
  if (!response.body) throw new BailingHubClientError('BailingHub returned an empty response.');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > CLIENT_API_LIMITS.responseBytes) {
      await reader.cancel();
      throw new BailingHubClientError('BailingHub response exceeded the 1 MiB safety limit.');
    }
    chunks.push(value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8'));
  } catch {
    throw new BailingHubClientError('BailingHub returned invalid JSON.');
  }
}

async function publicErrorCode(response: Response): Promise<string | undefined> {
  try {
    const body = asObject(await readJsonWithLimit(response), 'error response');
    const code = typeof body.error === 'string' ? body.error.trim() : '';
    return PUBLIC_AGENT_ERROR_CODES.has(code) ? code : undefined;
  } catch {
    return undefined;
  }
}

function safeHttpError(
  status: number,
  acceptedUnknown: boolean,
  publicCode?: string,
): BailingHubClientError {
  const disposition = publicCode === 'capability_changed'
    ? 'refresh_required'
    : publicCode
      ? 'definitive_rejection'
      : acceptedUnknown && (status === 408 || status === 425 || status >= 500)
        ? 'accepted_unknown'
        : 'definitive_rejection';
  const message = status === 401
    ? 'BailingHub rejected the Agent Session.'
    : status === 403
      ? 'The Agent Session is not allowed to perform this operation.'
      : status === 404
        ? 'The requested BailingHub Agent resource was not found.'
        : status === 409
          ? 'BailingHub rejected the Agent operation because its state changed.'
          : status === 429
            ? 'The BailingHub Agent rate limit was exceeded.'
            : status >= 500
              ? 'BailingHub Agent services are temporarily unavailable.'
              : `BailingHub rejected the Agent request (HTTP ${status}).`;
  return new BailingHubClientError(
    message,
    status,
    status === 408 || status === 425 || status === 429 || status >= 500,
    publicCode,
    disposition,
  );
}

/** Host-neutral HTTP boundary for Agent Client API v1. */
export class AgentClientTransport {
  readonly baseUrl: string;

  constructor(
    baseUrl: string,
    private readonly accessTokenProvider: AgentAccessTokenProvider,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMilliseconds = 15_000,
    allowInsecureHttp = false,
  ) {
    this.baseUrl = normalizeBaseUrl(baseUrl, allowInsecureHttp);
    if (!Number.isInteger(timeoutMilliseconds) || timeoutMilliseconds < 1 || timeoutMilliseconds > 120_000) {
      throw new Error('timeoutMilliseconds must be an integer from 1 to 120000.');
    }
  }

  async request(
    method: 'GET' | 'POST',
    path: string,
    body?: Record<string, unknown>,
    options: AgentRequestOptions = {},
  ): Promise<AgentTransportResponse> {
    const expectedStatus = options.expectedStatus ?? 200;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMilliseconds);
    try {
      let response = await this.send(method, path, body, false, controller.signal, options.ifNoneMatch);
      if (response.status === 401) {
        response = await this.send(method, path, body, true, controller.signal, options.ifNoneMatch);
      }
      if (response.status === 304 && options.ifNoneMatch) {
        return { status: 304, ...(response.headers.get('etag') ? { etag: response.headers.get('etag')! } : {}) };
      }
      if (response.status !== expectedStatus) {
        throw safeHttpError(
          response.status,
          options.acceptedUnknownOnFailure === true,
          await publicErrorCode(response),
        );
      }
      const value = await readJsonWithLimit(response);
      return {
        status: response.status,
        body: value,
        ...(response.headers.get('etag') ? { etag: response.headers.get('etag')! } : {}),
      };
    } catch (error) {
      if (error instanceof BailingHubClientError) throw error;
      if (error instanceof Error && error.name === 'AbortError') {
        throw new BailingHubClientError(
          'BailingHub Agent request timed out.',
          408,
          true,
          undefined,
          options.acceptedUnknownOnFailure ? 'accepted_unknown' : 'definitive_rejection',
        );
      }
      throw new BailingHubClientError(
        'Could not connect to BailingHub Agent services.',
        undefined,
        true,
        undefined,
        options.acceptedUnknownOnFailure ? 'accepted_unknown' : 'definitive_rejection',
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  private async send(
    method: 'GET' | 'POST',
    path: string,
    body: Record<string, unknown> | undefined,
    forceRefresh: boolean,
    signal: AbortSignal,
    ifNoneMatch?: string,
  ): Promise<Response> {
    let token: string;
    try {
      token = await this.accessTokenProvider.getAccessToken(forceRefresh);
    } catch {
      throw new BailingHubClientError(
        'The BailingHub Agent login could not be refreshed. Run login again.',
        401,
      );
    }
    const headers: Record<string, string> = {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': `bailinghub-agent-client/${PACKAGE_VERSION}`,
    };
    if (ifNoneMatch) headers['If-None-Match'] = identifierText(ifNoneMatch, 'ifNoneMatch', 256);
    const init: RequestInit = { method, headers, redirect: 'error', signal };
    if (body !== undefined) init.body = JSON.stringify(body);
    return await this.fetchImpl(`${this.baseUrl}${path}`, init);
  }
}

/** Framework-neutral Agent Client SDK. It contains no DSH-specific APIs. */
export class BailingHubAgentClient {
  readonly connection: Omit<AgentClientConnection, 'accessTokenProvider'>;
  readonly transport: AgentClientTransport;

  constructor(
    connection: AgentClientConnection,
    options: {
      fetchImpl?: typeof fetch;
      timeoutMilliseconds?: number;
      allowInsecureHttp?: boolean;
    } = {},
  ) {
    const baseUrl = normalizeBaseUrl(
      connection.baseUrl,
      options.allowInsecureHttp === true,
    );
    const clientAppId = normalizeClientAppId(connection.clientAppId);
    const workspace = normalizeAgentRoute(connection.workspace);
    const sessionId = identifierText(connection.sessionId, 'sessionId', 128);
    this.connection = { baseUrl, clientAppId, workspace, sessionId };
    this.transport = new AgentClientTransport(
      baseUrl,
      connection.accessTokenProvider,
      options.fetchImpl,
      options.timeoutMilliseconds,
      options.allowInsecureHttp === true,
    );
  }

  async listWorkspaces(options: { ifNoneMatch?: string } = {}): Promise<AgentWorkspaceList> {
    const response = await this.transport.request('GET', AGENT_CLIENT_V1_PATHS.workspaces, undefined, {
      ...(options.ifNoneMatch ? { ifNoneMatch: options.ifNoneMatch } : {}),
    });
    if (response.status === 304) {
      return {
        schema: 'bailing.agent-workspaces.v1',
        workspaces: [],
        not_modified: true,
        ...(response.etag ? { etag: response.etag } : {}),
      };
    }
    const body = asObject(response.body, 'workspace list');
    if (responseSchema(body) !== 'bailing.agent-workspaces.v1' || !Array.isArray(body.workspaces) || body.workspaces.length > MAX_WORKSPACES) {
      throw new BailingHubClientError('BailingHub returned an unsupported Agent workspace list.');
    }
    const workspaces = body.workspaces.map((item) => normalizeWorkspace(item));
    if (new Set(workspaces.map((item) => item.route)).size !== workspaces.length) {
      throw new BailingHubClientError('BailingHub returned duplicate Agent workspaces.');
    }
    return {
      schema: 'bailing.agent-workspaces.v1',
      workspaces,
      ...(response.etag ? { etag: response.etag } : {}),
    };
  }

  async bootstrapWorkspace(options: { ifNoneMatch?: string } = {}): Promise<AgentRuntimeProfile> {
    const route = this.connection.workspace;
    const response = await this.transport.request('GET', AGENT_CLIENT_V1_PATHS.bootstrap(route), undefined, {
      ...(options.ifNoneMatch ? { ifNoneMatch: options.ifNoneMatch } : {}),
    });
    if (response.status === 304) {
      return {
        schema: 'bailing.agent-runtime-profile.v1',
        workspace: { route, name: route },
        profile: { revision: 'not-modified', instructions: '' },
        capabilities: { revision: 'not-modified' },
        not_modified: true,
        ...(response.etag ? { etag: response.etag } : {}),
      };
    }
    const body = asObject(response.body, 'runtime profile');
    if (responseSchema(body) !== 'bailing.agent-runtime-profile.v1') {
      throw new BailingHubClientError('BailingHub returned an unsupported Agent runtime profile.');
    }
    const workspaceBody = body.workspace ?? { route: body.route ?? body.route_key, name: body.name, description: body.description };
    const workspace = normalizeWorkspace(workspaceBody, route);
    const profileBody = body.profile && typeof body.profile === 'object' && !Array.isArray(body.profile)
      ? body.profile as Record<string, unknown>
      : body;
    const capabilitiesBody = body.capabilities && typeof body.capabilities === 'object' && !Array.isArray(body.capabilities)
      ? body.capabilities as Record<string, unknown>
      : body;
    const profileRevision = revision(profileBody.revision ?? body.profile_revision, 'profile revision');
    const capabilityRevision = revision(capabilitiesBody.revision ?? body.capability_revision, 'capability revision');
    const instructions = typeof profileBody.instructions === 'string'
      ? profileBody.instructions
      : typeof body.instructions === 'string'
        ? body.instructions
        : '';
    if (instructions.length > 100_000 || /\u0000/.test(instructions)) {
      throw new BailingHubClientError('BailingHub returned invalid Agent instructions.');
    }
    const renderers = normalizedRenderers(profileBody.renderers ?? body.renderers);
    const governance = profileBody.governance === undefined
      ? undefined
      : asObject(profileBody.governance, 'runtime governance');
    if (governance) assertJsonBounded(governance, 'runtime governance', MAX_CONTEXT_BYTES);
    const knowledgeRefs = profileBody.knowledge_refs;
    if (knowledgeRefs !== undefined && !Array.isArray(knowledgeRefs)) {
      throw new BailingHubClientError('BailingHub returned invalid knowledge_refs.');
    }
    const memoryRefs = profileBody.memory_refs;
    if (memoryRefs !== undefined && !Array.isArray(memoryRefs)) {
      throw new BailingHubClientError('BailingHub returned invalid memory_refs.');
    }
    assertJsonBounded({
      knowledge: profileBody.knowledge ?? null,
      memory: profileBody.memory ?? null,
      memory_refs: memoryRefs ?? [],
      knowledge_refs: knowledgeRefs ?? [],
      governance: governance ?? {},
    }, 'runtime profile', MAX_CONTEXT_BYTES);
    const activeTools = capabilitiesBody.active_tools ?? capabilitiesBody.tools;
    const authorizedTotal = optionalCount(capabilitiesBody.authorized_total, 'authorized_total');
    const activeLimit = optionalCount(capabilitiesBody.active_limit, 'active_limit', MAX_ACTIVE_TOOLS);
    const readonly = optionalCount(capabilitiesBody.readonly, 'readonly');
    const writes = optionalCount(capabilitiesBody.writes, 'writes');
    const approvalRequired = optionalCount(capabilitiesBody.approval_required, 'approval_required');
    return {
      schema: 'bailing.agent-runtime-profile.v1',
      workspace,
      profile: {
        revision: profileRevision,
        instructions,
        ...(profileBody.knowledge !== undefined ? { knowledge: profileBody.knowledge } : {}),
        ...(profileBody.memory !== undefined ? { memory: profileBody.memory } : {}),
        ...(memoryRefs ? { memory_refs: memoryRefs } : {}),
        ...(knowledgeRefs ? { knowledge_refs: knowledgeRefs } : {}),
        ...(governance ? { governance } : {}),
        ...(renderers ? { renderers } : {}),
      },
      capabilities: {
        revision: capabilityRevision,
        ...(activeTools !== undefined
          ? { active_tools: normalizeTools(activeTools, 'runtime active_tools') }
          : {}),
        ...(authorizedTotal !== undefined ? { authorized_total: authorizedTotal } : {}),
        ...(activeLimit !== undefined ? { active_limit: activeLimit } : {}),
        ...(readonly !== undefined ? { readonly } : {}),
        ...(writes !== undefined ? { writes } : {}),
        ...(approvalRequired !== undefined ? { approval_required: approvalRequired } : {}),
      },
      ...(response.etag ? { etag: response.etag } : {}),
    };
  }

  async startTurn(input: StartAgentTurnInput): Promise<AgentTurnContext> {
    const body: Record<string, unknown> = {
      client_conversation_id: identifierText(input.clientConversationId, 'clientConversationId', 128),
      client_turn_id: identifierText(input.clientTurnId, 'clientTurnId', 128),
      user_message_id: identifierText(input.userMessageId, 'userMessageId', 128),
      user_input: contentText(input.userInput, 'userInput', MAX_VISIBLE_CONTENT),
    };
    const requestPageContext = optionalRecord(input.pageContext, 'pageContext', MAX_PAGE_CONTEXT_BYTES);
    const requestRenderers = normalizedRenderers(input.renderers);
    if (requestPageContext) body.page_context = requestPageContext;
    if (requestRenderers) body.renderers = requestRenderers;
    const response = await this.transport.request('POST', AGENT_CLIENT_V1_PATHS.turns(this.connection.workspace), body);
    const value = asObject(response.body, 'turn context');
    if (responseSchema(value) !== 'bailing.agent-turn-context.v1') {
      throw new BailingHubClientError('BailingHub returned an unsupported Agent turn context.');
    }
    const runId = requiredString(value.run_id, 'run_id', 36);
    if (!UUID_PATTERN.test(runId)) throw new BailingHubClientError('BailingHub returned an invalid run_id.');
    const context = asObject(value.context, 'turn context body');
    const instructions = typeof context.instructions === 'string' ? context.instructions : '';
    if (instructions.length > 100_000 || /\u0000/.test(instructions)) {
      throw new BailingHubClientError('BailingHub returned invalid turn instructions.');
    }
    const knowledgeRefs = context.knowledge_refs ?? [];
    if (!Array.isArray(knowledgeRefs)) throw new BailingHubClientError('BailingHub returned invalid turn knowledge_refs.');
    const knowledge = context.knowledge ?? [];
    if (!Array.isArray(knowledge)) throw new BailingHubClientError('BailingHub returned invalid turn knowledge.');
    const governance = context.governance === undefined ? {} : asObject(context.governance, 'turn governance');
    const pageContext = context.page_context === undefined
      ? {}
      : asObject(context.page_context, 'turn page_context');
    assertJsonBounded(pageContext, 'turn page_context', MAX_PAGE_CONTEXT_BYTES);
    const renderers = normalizedRenderers(context.renderers) ?? [];
    const memoryRefs = context.memory_refs ?? [];
    if (!Array.isArray(memoryRefs)) throw new BailingHubClientError('BailingHub returned invalid turn memory_refs.');
    assertJsonBounded({ memory: context.memory ?? null, memory_refs: memoryRefs, knowledge, knowledge_refs: knowledgeRefs, governance }, 'turn context', MAX_CONTEXT_BYTES);
    return {
      schema: 'bailing.agent-turn-context.v1',
      run_id: runId,
      profile_revision: revision(value.profile_revision, 'profile_revision'),
      capability_revision: revision(value.capability_revision, 'capability_revision'),
      context: {
        instructions,
        page_context: pageContext,
        renderers,
        memory: context.memory ?? null,
        memory_refs: memoryRefs,
        knowledge,
        knowledge_refs: knowledgeRefs,
        governance,
      },
      active_tools: normalizeTools(value.active_tools, 'turn active_tools'),
    };
  }

  async searchCapabilities(input: SearchAgentCapabilitiesInput): Promise<AgentCapabilitySearchResult> {
    const limit = input.limit ?? MAX_ACTIVE_TOOLS;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_ACTIVE_TOOLS) {
      throw new Error(`limit must be an integer from 1 to ${MAX_ACTIVE_TOOLS}.`);
    }
    const body: Record<string, unknown> = { limit };
    const query = typeof input.query === 'string' && input.query.trim()
      ? contentText(input.query, 'query', 2_000)
      : undefined;
    if (query !== undefined) body.query = query;
    if (input.runId !== undefined) {
      const runId = identifierText(input.runId, 'runId', 36);
      if (!UUID_PATTERN.test(runId)) throw new Error('runId must be a UUID.');
      body.run_id = runId;
    }
    if (query === undefined && body.run_id === undefined) {
      throw new Error('query or runId is required.');
    }
    const response = await this.transport.request('POST', AGENT_CLIENT_V1_PATHS.capabilitySearch(this.connection.workspace), body);
    const value = asObject(response.body, 'capability search');
    const schema = responseSchema(value);
    if (schema !== 'bailing.agent-capability-search.v1') {
      throw new BailingHubClientError('BailingHub returned an unsupported capability search response.');
    }
    return {
      schema: 'bailing.agent-capability-search.v1',
      capability_revision: revision(value.capability_revision, 'capability_revision'),
      tools: normalizeTools(value.tools, 'capability search tools'),
    };
  }

  async invoke(input: InvokeAgentCapabilityInput): Promise<AgentToolInvocation> {
    const invocationId = identifierText(input.invocationId, 'invocationId', 64);
    const capabilityRevision = identifierText(input.capabilityRevision, 'capabilityRevision', 128);
    const agentRunId = identifierText(input.agentRunId, 'agentRunId', 36);
    const tool = identifierText(input.tool, 'tool', 64);
    if (!INVOCATION_ID_PATTERN.test(invocationId) || !REVISION_PATTERN.test(capabilityRevision) || !UUID_PATTERN.test(agentRunId) || !TOOL_NAME_PATTERN.test(tool)) {
      throw new Error('The Agent capability invocation identifiers are invalid.');
    }
    const argumentsValue = optionalRecord(input.arguments, 'arguments', 16 * 1024);
    if (!argumentsValue) throw new Error('arguments must be an object.');
    try {
      const response = await this.transport.request('POST', AGENT_CLIENT_V1_PATHS.invocations, {
        invocation_id: invocationId,
        route: this.connection.workspace,
        capability_revision: capabilityRevision,
        agent_run_id: agentRunId,
        tool,
        arguments: argumentsValue,
      }, { acceptedUnknownOnFailure: true });
      return normalizeInvocation(response.body, { invocationId, route: this.connection.workspace, tool });
    } catch (error) {
      if (error instanceof BailingHubClientError) {
        throw new BailingHubClientError(
          error.message,
          error.statusCode,
          error.retryable,
          error.publicCode,
          error.disposition === 'definitive_rejection' && error.statusCode === undefined
            ? 'accepted_unknown'
            : error.disposition,
          invocationId,
        );
      }
      throw new BailingHubClientError(
        'BailingHub returned an invalid governed invocation response.',
        undefined,
        true,
        undefined,
        'accepted_unknown',
        invocationId,
      );
    }
  }

  async resume(invocationIdValue: unknown): Promise<AgentToolInvocation> {
    const invocationId = identifierText(invocationIdValue, 'invocationId', 64);
    if (!INVOCATION_ID_PATTERN.test(invocationId)) throw new Error('invocationId must be a 64-character lowercase digest.');
    try {
      const response = await this.transport.request('POST', AGENT_CLIENT_V1_PATHS.resumeInvocation(invocationId), undefined, { acceptedUnknownOnFailure: true });
      return normalizeInvocation(response.body, { invocationId, route: this.connection.workspace });
    } catch (error) {
      if (error instanceof BailingHubClientError) {
        throw new BailingHubClientError(
          error.message,
          error.statusCode,
          error.retryable,
          error.publicCode,
          error.disposition === 'definitive_rejection' && error.statusCode === undefined
            ? 'accepted_unknown'
            : error.disposition,
          invocationId,
        );
      }
      throw new BailingHubClientError(
        'BailingHub returned an invalid governed invocation response.',
        undefined,
        true,
        undefined,
        'accepted_unknown',
        invocationId,
      );
    }
  }

  async completeRun(runIdValue: unknown, input: CompleteAgentRunInput): Promise<AgentRunCompletion> {
    const runId = identifierText(runIdValue, 'runId', 36);
    if (!UUID_PATTERN.test(runId)) throw new Error('runId must be a UUID.');
    if (!RUN_COMPLETION_STATUSES.has(input.status)) throw new Error('status is invalid.');
    const body: Record<string, unknown> = {
      assistant_message_id: identifierText(input.assistantMessageId, 'assistantMessageId', 128),
      content: contentText(input.content, 'content', MAX_VISIBLE_CONTENT),
      status: input.status,
    };
    if (!MESSAGE_ID_PATTERN.test(body.assistant_message_id as string)) throw new Error('assistantMessageId is invalid.');
    if (input.model !== undefined) body.model = identifierText(input.model, 'model', 191);
    if (input.runtime !== undefined) body.runtime = identifierText(input.runtime, 'runtime', 191);
    const usage = normalizedUsage(input.usage);
    if (usage) body.usage = usage;
    // The public DTO is deliberately constructed field-by-field. Hidden reasoning fields can
    // never cross this boundary even when an untyped host passes extra properties.
    try {
      const response = await this.transport.request(
        'POST',
        AGENT_CLIENT_V1_PATHS.completeRun(runId),
        body,
        { acceptedUnknownOnFailure: true },
      );
      const value = asObject(response.body, 'run completion');
      const schema = responseSchema(value);
      if (schema && schema !== 'bailing.agent-run-completion.v1') {
        throw new BailingHubClientError('BailingHub returned an unsupported run completion.');
      }
      const responseRunId = requiredString(value.run_id, 'run completion run_id', 36);
      const status = requiredString(value.status, 'run completion status', 32);
      if (responseRunId !== runId || !RUN_COMPLETION_STATUSES.has(status)) {
        throw new BailingHubClientError('BailingHub returned an invalid run completion.');
      }
      return {
        schema: 'bailing.agent-run-completion.v1',
        run_id: responseRunId,
        status: status as AgentRunCompletion['status'],
      };
    } catch (error) {
      if (error instanceof BailingHubClientError) {
        if (error.statusCode !== undefined || error.disposition !== 'definitive_rejection') throw error;
        throw new BailingHubClientError(
          error.message,
          error.statusCode,
          true,
          error.publicCode,
          'accepted_unknown',
        );
      }
      throw error;
    }
  }
}

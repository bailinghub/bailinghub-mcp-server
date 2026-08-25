import type { BailingHubMcpConfig } from './config.js';
import type {
  AgentBailingHubMcpConfig,
  BailingHubRuntimeConfig,
} from './runtime-config.js';
import { PACKAGE_VERSION } from './version.js';

export const TERMINAL_STATUSES = ['done', 'error', 'rejected'] as const;
export const KNOWN_STATUSES = [
  'queued',
  'running',
  'dispatched',
  ...TERMINAL_STATUSES,
] as const;
export const CLIENT_API_LIMITS = {
  requestId: 128,
  input: 100_000,
  toolDescription: 1_200,
  toolResultText: 8_192,
  toolCatalogEntries: 512,
  responseBytes: 1024 * 1024,
} as const;

export const AGENT_TOOL_INVOCATION_STATES = [
  'executed',
  'business_rejected',
  'awaiting_approval',
  'denied',
  'rejected_before_dispatch',
  'reconciliation_required',
  'in_progress',
] as const;

export type AgentToolInvocationState =
  (typeof AGENT_TOOL_INVOCATION_STATES)[number];

export type AgentToolCatalogEntry = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  scope: string;
  risk: 'low' | 'medium' | 'high';
  approval_required: boolean;
  readonly: boolean;
  idempotent: boolean;
};

export type AgentToolCatalog = {
  schema_version: 'bailing.agent-tool-catalog.v1';
  route: string;
  capability_revision: string;
  tools: AgentToolCatalogEntry[];
};

export type AgentToolInvocation = {
  schema_version: 'bailing.agent-tool-invocation.v1';
  invocation_id: string;
  route: string;
  tool: string;
  state: AgentToolInvocationState;
  ok: boolean;
  auto_retry_allowed: boolean;
  text: string;
  business_status?: number;
  approval_id?: number;
};

export type InvokeAgentToolInput = {
  invocationId: string;
  capabilityRevision: string;
  agentRunId: string;
  tool: string;
  arguments: Record<string, unknown>;
};

const TERMINAL_STATUS_SET = new Set<string>(TERMINAL_STATUSES);
const KNOWN_STATUS_SET = new Set<string>(KNOWN_STATUSES);
const AGENT_TOOL_INVOCATION_STATE_SET = new Set<string>(
  AGENT_TOOL_INVOCATION_STATES,
);
const JOB_ID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;
const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;
const INVOCATION_ID_PATTERN = /^[0-9a-f]{64}$/;
const TOOL_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const CAPABILITY_REVISION_PATTERN = /^[a-f0-9]{64}$/;
const TOOL_RISK_SET = new Set<string>(['low', 'medium', 'high']);

const PUBLIC_AGENT_ERROR_CODES = new Set([
  'agent_direct_disabled',
  'agent_tools_unavailable',
  'arguments_too_large',
  'audience_not_allowed',
  'capability_changed',
  'hub_paused',
  'invalid_route',
  'invalid_request',
  'invocation_conflict',
  'invocation_not_found',
  'route_not_allowed',
  'route_unavailable',
  'tool_not_found',
]);

export type BailingHubClientErrorDisposition =
  | 'accepted_unknown'
  | 'definitive_rejection'
  | 'refresh_required';

function isAgentConfig(
  config: BailingHubRuntimeConfig,
): config is AgentBailingHubMcpConfig {
  return config.mode === 'agent';
}

export type BailingHubJob = Record<string, unknown> & {
  job_id: string;
  request_id: string;
  status: string;
  terminal: boolean;
};

export class BailingHubClientError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
    public readonly retryable = false,
    public readonly publicCode?: string,
    public readonly disposition: BailingHubClientErrorDisposition =
      'definitive_rejection',
  ) {
    super(message);
    this.name = 'BailingHubClientError';
  }
}

function requiredText(value: unknown, name: string, maximumLength: number): string {
  if (typeof value !== 'string') throw new Error(`${name} must be a string.`);
  const text = value.trim();
  if (!text) throw new Error(`${name} is required.`);
  if (text.length > maximumLength) {
    throw new Error(`${name} must not exceed ${maximumLength} characters.`);
  }
  return text;
}

function asObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new BailingHubClientError('BailingHub returned a non-object JSON response.');
  }
  return value as Record<string, unknown>;
}

function optionalObject(
  body: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const value = body[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new BailingHubClientError(`BailingHub returned an invalid ${key} value.`);
  }
  return value as Record<string, unknown>;
}

function requiredResponseText(
  body: Record<string, unknown>,
  key: string,
  maximumLength: number,
): string {
  const value = body[key];
  if (typeof value !== 'string' || !value.trim() || value.length > maximumLength) {
    throw new BailingHubClientError(`BailingHub returned an invalid ${key} value.`);
  }
  return value;
}

function requiredResponseBoolean(
  body: Record<string, unknown>,
  key: string,
): boolean {
  const value = body[key];
  if (typeof value !== 'boolean') {
    throw new BailingHubClientError(`BailingHub returned an invalid ${key} value.`);
  }
  return value;
}

function boundedResponseText(
  body: Record<string, unknown>,
  key: string,
  maximumLength: number,
): string {
  const value = body[key];
  if (typeof value !== 'string' || value.length > maximumLength) {
    throw new BailingHubClientError(`BailingHub returned an invalid ${key} value.`);
  }
  return value;
}

function normalizeInputSchema(value: unknown): Record<string, unknown> {
  const schema = asObject(value);
  if (schema.type !== 'object') {
    throw new BailingHubClientError(
      'BailingHub returned a tool input_schema that is not an object schema.',
    );
  }
  return schema;
}

function normalizeAgentToolCatalog(value: unknown, expectedRoute: string): AgentToolCatalog {
  const body = asObject(value);
  if (body.schema_version !== 'bailing.agent-tool-catalog.v1') {
    throw new BailingHubClientError(
      'BailingHub returned an unsupported Agent tool catalog.',
    );
  }
  const route = requiredResponseText(body, 'route', 128);
  if (route !== expectedRoute) {
    throw new BailingHubClientError(
      'BailingHub returned an Agent tool catalog for a different route.',
    );
  }
  const capabilityRevision = requiredResponseText(
    body,
    'capability_revision',
    128,
  );
  if (!CAPABILITY_REVISION_PATTERN.test(capabilityRevision)) {
    throw new BailingHubClientError(
      'BailingHub returned an invalid capability_revision value.',
    );
  }
  if (
    !Array.isArray(body.tools) ||
    body.tools.length > CLIENT_API_LIMITS.toolCatalogEntries
  ) {
    throw new BailingHubClientError('BailingHub returned an invalid Agent tool list.');
  }

  const tools = body.tools.map((value): AgentToolCatalogEntry => {
    const tool = asObject(value);
    const name = requiredResponseText(tool, 'name', 128);
    const description = requiredResponseText(
      tool,
      'description',
      CLIENT_API_LIMITS.toolDescription,
    );
    const scope = requiredResponseText(tool, 'scope', 256);
    const risk = requiredResponseText(tool, 'risk', 16);
    if (!TOOL_NAME_PATTERN.test(name) || !TOOL_RISK_SET.has(risk)) {
      throw new BailingHubClientError(
        'BailingHub returned an invalid Agent tool definition.',
      );
    }
    return {
      name,
      description,
      input_schema: normalizeInputSchema(tool.input_schema),
      scope,
      risk: risk as AgentToolCatalogEntry['risk'],
      approval_required: requiredResponseBoolean(tool, 'approval_required'),
      readonly: requiredResponseBoolean(tool, 'readonly'),
      idempotent: requiredResponseBoolean(tool, 'idempotent'),
    };
  });

  return {
    schema_version: 'bailing.agent-tool-catalog.v1',
    route,
    capability_revision: capabilityRevision,
    tools,
  };
}

function normalizeAgentToolInvocation(
  value: unknown,
  expected: { invocationId: string; route: string; tool?: string },
): AgentToolInvocation {
  const body = asObject(value);
  if (body.schema_version !== 'bailing.agent-tool-invocation.v1') {
    throw new BailingHubClientError(
      'BailingHub returned an unsupported Agent tool invocation.',
    );
  }
  const invocationId = requiredResponseText(body, 'invocation_id', 64);
  const route = requiredResponseText(body, 'route', 128);
  const tool = requiredResponseText(body, 'tool', 128);
  const state = requiredResponseText(body, 'state', 64);
  if (
    invocationId !== expected.invocationId ||
    route !== expected.route ||
    (expected.tool !== undefined && tool !== expected.tool) ||
    !INVOCATION_ID_PATTERN.test(invocationId) ||
    !TOOL_NAME_PATTERN.test(tool) ||
    !AGENT_TOOL_INVOCATION_STATE_SET.has(state)
  ) {
    throw new BailingHubClientError(
      'BailingHub returned an invalid Agent tool invocation.',
    );
  }

  const normalized: AgentToolInvocation = {
    schema_version: 'bailing.agent-tool-invocation.v1',
    invocation_id: invocationId,
    route,
    tool,
    state: state as AgentToolInvocationState,
    ok: requiredResponseBoolean(body, 'ok'),
    auto_retry_allowed: requiredResponseBoolean(body, 'auto_retry_allowed'),
    text: boundedResponseText(body, 'text', CLIENT_API_LIMITS.toolResultText),
  };
  if (body.business_status !== undefined) {
    if (
      !Number.isInteger(body.business_status) ||
      Number(body.business_status) < 100 ||
      Number(body.business_status) > 599
    ) {
      throw new BailingHubClientError(
        'BailingHub returned an invalid business_status value.',
      );
    }
    normalized.business_status = Number(body.business_status);
  }
  if (body.approval_id !== undefined) {
    if (!Number.isInteger(body.approval_id) || Number(body.approval_id) < 1) {
      throw new BailingHubClientError(
        'BailingHub returned an invalid approval_id value.',
      );
    }
    normalized.approval_id = Number(body.approval_id);
  }
  return normalized;
}

function normalizeJob(value: unknown, requireRequestId = false): BailingHubJob {
  const body = asObject(value);
  const jobId = String(body.job_id ?? body.id ?? '').trim();
  const requestId = String(body.request_id ?? '').trim();
  const status = String(body.status ?? '').trim();

  if (!JOB_ID_PATTERN.test(jobId) || !KNOWN_STATUS_SET.has(status)) {
    throw new BailingHubClientError('BailingHub returned an invalid job response.');
  }
  if (requireRequestId && !requestId) {
    throw new BailingHubClientError('BailingHub returned a job without request_id.');
  }
  if (requestId.length > CLIENT_API_LIMITS.requestId) {
    throw new BailingHubClientError('BailingHub returned an invalid request_id.');
  }

  const normalized: BailingHubJob = {
    job_id: jobId,
    request_id: requestId,
    status,
    terminal: TERMINAL_STATUS_SET.has(status),
  };

  for (const key of ['report', 'result', 'usage']) {
    const objectValue = optionalObject(body, key);
    if (objectValue !== undefined) normalized[key] = objectValue;
  }
  if (body.raw_result !== undefined && body.raw_result !== null) {
    if (typeof body.raw_result !== 'string') {
      throw new BailingHubClientError('BailingHub returned an invalid raw_result value.');
    }
    normalized.raw_result = body.raw_result;
  }
  if (body.error !== undefined && body.error !== null) {
    if (typeof body.error !== 'string') {
      throw new BailingHubClientError('BailingHub returned an invalid error value.');
    }
    normalized.error = body.error.slice(0, 1000);
  }
  for (const key of ['created_at', 'updated_at']) {
    const timestamp = body[key];
    if (timestamp !== undefined && timestamp !== null) {
      if (typeof timestamp !== 'string' || timestamp.length > 100) {
        throw new BailingHubClientError(`BailingHub returned an invalid ${key} value.`);
      }
      normalized[key] = timestamp;
    }
  }

  return normalized;
}

async function readJsonWithLimit(response: Response): Promise<unknown> {
  const contentLength = Number(response.headers.get('content-length'));
  if (
    Number.isFinite(contentLength) &&
    contentLength > CLIENT_API_LIMITS.responseBytes
  ) {
    throw new BailingHubClientError('BailingHub response exceeded the 1 MiB safety limit.');
  }
  if (!response.body) {
    throw new BailingHubClientError('BailingHub returned an empty response.');
  }

  const chunks: Uint8Array[] = [];
  const reader = response.body.getReader();
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > CLIENT_API_LIMITS.responseBytes) {
      await reader.cancel();
      throw new BailingHubClientError(
        'BailingHub response exceeded the 1 MiB safety limit.',
      );
    }
    chunks.push(value);
  }

  const text = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8');
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new BailingHubClientError('BailingHub returned invalid JSON.');
  }
}

function publicHttpError(
  statusCode: number,
  mode: 'client' | 'agent',
  publicCode?: string,
  acceptedUnknownOnFailure = false,
): BailingHubClientError {
  let message = `BailingHub rejected the request (HTTP ${statusCode}).`;
  if (statusCode === 400) message = 'BailingHub rejected the request as invalid.';
  else if (statusCode === 401) {
    message =
      mode === 'agent'
        ? 'BailingHub rejected the Agent Session.'
        : 'BailingHub rejected the Client Token.';
  }
  else if (statusCode === 403) {
    message = `The BailingHub ${mode} is not allowed to perform this operation.`;
  } else if (statusCode === 404) {
    message = `The BailingHub job was not found or is not owned by this ${mode}.`;
  } else if (statusCode === 409) {
    message = 'BailingHub rejected the request because of an idempotency conflict.';
  } else if (statusCode === 413) {
    message = 'BailingHub rejected the request because it is too large.';
  } else if (statusCode === 429) {
    message = 'The BailingHub client rate limit was exceeded. Retry the same request_id later.';
  } else if (statusCode >= 500) {
    message = 'BailingHub is temporarily unavailable.';
  }

  return new BailingHubClientError(
    message,
    statusCode,
    statusCode === 408 || statusCode === 425 || statusCode === 429 || statusCode >= 500,
    publicCode,
    publicCode === 'capability_changed'
      ? 'refresh_required'
      : publicCode
        ? 'definitive_rejection'
        : acceptedUnknownOnFailure &&
          (statusCode === 408 || statusCode === 425 || statusCode >= 500)
        ? 'accepted_unknown'
        : 'definitive_rejection',
  );
}

async function publicErrorCode(response: Response): Promise<string | undefined> {
  try {
    const body = asObject(await readJsonWithLimit(response));
    const code = typeof body.error === 'string' ? body.error.trim() : '';
    return PUBLIC_AGENT_ERROR_CODES.has(code) ? code : undefined;
  } catch {
    return undefined;
  }
}

function acceptedUnknownResponse(error: unknown): BailingHubClientError {
  if (error instanceof BailingHubClientError) {
    return new BailingHubClientError(
      error.message,
      error.statusCode,
      error.retryable,
      error.publicCode,
      'accepted_unknown',
    );
  }
  return new BailingHubClientError(
    'BailingHub returned an invalid governed invocation response.',
    undefined,
    true,
    undefined,
    'accepted_unknown',
  );
}

export class BailingHubClient {
  constructor(
    private readonly config: BailingHubRuntimeConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async submitJob(requestIdValue: unknown, inputValue: unknown): Promise<BailingHubJob> {
    if (isAgentConfig(this.config)) {
      throw new Error(
        'Agent Session mode does not support delegated BailingHub jobs. Use a projected business tool.',
      );
    }
    const requestId = requiredText(
      requestIdValue,
      'request_id',
      CLIENT_API_LIMITS.requestId,
    );
    const input = requiredText(inputValue, 'input', CLIENT_API_LIMITS.input);
    const response = await this.request(
      'POST',
      '/run',
      202,
      {
        request_id: requestId,
        route: this.config.route,
        input,
      },
    );
    return normalizeJob(response, true);
  }

  async getAgentToolCatalog(): Promise<AgentToolCatalog> {
    if (!isAgentConfig(this.config)) {
      throw new Error('Agent tool discovery requires an Agent Session.');
    }
    const response = await this.request(
      'GET',
      `/agent-api/v1/tools?route=${encodeURIComponent(this.config.route)}`,
      200,
    );
    return normalizeAgentToolCatalog(response, this.config.route);
  }

  async invokeAgentTool(input: InvokeAgentToolInput): Promise<AgentToolInvocation> {
    if (!isAgentConfig(this.config)) {
      throw new Error('Agent tool invocation requires an Agent Session.');
    }
    const invocationId = requiredText(input.invocationId, 'invocation_id', 64);
    const capabilityRevision = requiredText(
      input.capabilityRevision,
      'capability_revision',
      128,
    );
    const agentRunId = requiredText(input.agentRunId, 'agent_run_id', 36);
    const tool = requiredText(input.tool, 'tool', 128);
    if (
      !INVOCATION_ID_PATTERN.test(invocationId) ||
      !CAPABILITY_REVISION_PATTERN.test(capabilityRevision) ||
      !UUID_PATTERN.test(agentRunId) ||
      !TOOL_NAME_PATTERN.test(tool)
    ) {
      throw new Error('The Agent tool invocation identifiers are invalid.');
    }
    if (
      typeof input.arguments !== 'object' ||
      input.arguments === null ||
      Array.isArray(input.arguments)
    ) {
      throw new Error('Agent tool arguments must be an object.');
    }
    const response = await this.request(
      'POST',
      '/agent-api/v1/tool-invocations',
      200,
      {
        invocation_id: invocationId,
        route: this.config.route,
        capability_revision: capabilityRevision,
        agent_run_id: agentRunId,
        tool,
        arguments: input.arguments,
      },
      { acceptedUnknownOnFailure: true },
    );
    try {
      return normalizeAgentToolInvocation(response, {
        invocationId,
        route: this.config.route,
        tool,
      });
    } catch (error) {
      throw acceptedUnknownResponse(error);
    }
  }

  async resumeAgentToolInvocation(
    invocationIdValue: unknown,
  ): Promise<AgentToolInvocation> {
    if (!isAgentConfig(this.config)) {
      throw new Error('Agent tool invocation recovery requires an Agent Session.');
    }
    const invocationId = requiredText(
      invocationIdValue,
      'invocation_id',
      64,
    );
    if (!INVOCATION_ID_PATTERN.test(invocationId)) {
      throw new Error('The Agent tool invocation identifiers are invalid.');
    }
    const response = await this.request(
      'POST',
      `/agent-api/v1/tool-invocations/${encodeURIComponent(invocationId)}/resume`,
      200,
      undefined,
      { acceptedUnknownOnFailure: true },
    );
    try {
      return normalizeAgentToolInvocation(response, {
        invocationId,
        route: this.config.route,
      });
    } catch (error) {
      throw acceptedUnknownResponse(error);
    }
  }

  async getJob(jobIdValue: unknown): Promise<BailingHubJob> {
    const jobId = requiredText(jobIdValue, 'job_id', 36);
    if (!JOB_ID_PATTERN.test(jobId)) {
      throw new Error('job_id must be a UUID returned by BailingHub.');
    }
    const response = await this.request(
      'GET',
      isAgentConfig(this.config)
        ? `/agent-api/v1/jobs/${encodeURIComponent(jobId)}`
        : `/jobs/${encodeURIComponent(jobId)}`,
      200,
    );
    return normalizeJob(response);
  }

  async waitForJob(
    jobIdValue: unknown,
    maxWaitSecondsValue: unknown = 20,
    options: {
      pollIntervalMilliseconds?: number;
      now?: () => number;
      sleep?: (milliseconds: number) => Promise<void>;
    } = {},
  ): Promise<BailingHubJob> {
    const maxWaitSeconds = Number(maxWaitSecondsValue);
    if (
      !Number.isInteger(maxWaitSeconds) ||
      maxWaitSeconds < 1 ||
      maxWaitSeconds > 60
    ) {
      throw new Error('max_wait_seconds must be an integer between 1 and 60.');
    }

    const now = options.now ?? Date.now;
    const sleep =
      options.sleep ??
      ((milliseconds: number) =>
        new Promise<void>((resolve) => {
          setTimeout(resolve, milliseconds);
        }));
    const interval = options.pollIntervalMilliseconds ?? 2000;
    const startedAt = now();
    const deadline = startedAt + maxWaitSeconds * 1000;
    let pollCount = 1;
    let latest = await this.getJob(jobIdValue);

    while (!latest.terminal) {
      const remaining = deadline - now();
      if (remaining <= 0) break;
      await sleep(Math.min(interval, remaining));
      latest = await this.getJob(jobIdValue);
      pollCount += 1;
    }

    return {
      ...latest,
      wait_timed_out: !latest.terminal,
      poll_count: pollCount,
      elapsed_ms: Math.max(0, now() - startedAt),
    };
  }

  private async request(
    method: 'GET' | 'POST',
    path: string,
    expectedStatus: number,
    body?: Record<string, unknown>,
    options: { acceptedUnknownOnFailure?: boolean } = {},
  ): Promise<unknown> {
    const mode = isAgentConfig(this.config) ? 'agent' : 'client';
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      let response = await this.send(method, path, body, false, controller.signal);
      if (response.status === 401 && isAgentConfig(this.config)) {
        response = await this.send(method, path, body, true, controller.signal);
      }
      if (response.status !== expectedStatus) {
        const code = await publicErrorCode(response);
        throw publicHttpError(
          response.status,
          mode,
          code,
          options.acceptedUnknownOnFailure === true,
        );
      }
      try {
        return await readJsonWithLimit(response);
      } catch (error) {
        if (options.acceptedUnknownOnFailure) throw acceptedUnknownResponse(error);
        throw error;
      }
    } catch (error) {
      if (error instanceof BailingHubClientError) throw error;
      if (error instanceof Error && error.name === 'AbortError') {
        throw new BailingHubClientError(
          'BailingHub request timed out.',
          408,
          true,
          undefined,
          options.acceptedUnknownOnFailure
            ? 'accepted_unknown'
            : 'definitive_rejection',
        );
      }
      throw new BailingHubClientError(
        'Could not connect to BailingHub.',
        undefined,
        true,
        undefined,
        options.acceptedUnknownOnFailure
          ? 'accepted_unknown'
          : 'definitive_rejection',
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
  ): Promise<Response> {
    let token: string;
    if (isAgentConfig(this.config)) {
      try {
        token = await this.config.accessTokenProvider.getAccessToken(forceRefresh);
      } catch {
        throw new BailingHubClientError(
          'The BailingHub Agent login could not be refreshed. Run login again.',
          401,
        );
      }
    } else {
      token = (this.config as BailingHubMcpConfig).clientToken;
    }
    const requestInit: RequestInit = {
      method,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': `bailinghub-mcp-server/${PACKAGE_VERSION}`,
      },
      redirect: 'error',
      signal,
    };
    if (body !== undefined) requestInit.body = JSON.stringify(body);
    return await this.fetchImpl(`${this.config.baseUrl}${path}`, requestInit);
  }
}

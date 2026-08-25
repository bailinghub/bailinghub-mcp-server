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
  responseBytes: 1024 * 1024,
} as const;

const TERMINAL_STATUS_SET = new Set<string>(TERMINAL_STATUSES);
const KNOWN_STATUS_SET = new Set<string>(KNOWN_STATUSES);
const JOB_ID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;

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
  );
}

export class BailingHubClient {
  constructor(
    private readonly config: BailingHubRuntimeConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async submitJob(requestIdValue: unknown, inputValue: unknown): Promise<BailingHubJob> {
    const requestId = requiredText(
      requestIdValue,
      'request_id',
      CLIENT_API_LIMITS.requestId,
    );
    const input = requiredText(inputValue, 'input', CLIENT_API_LIMITS.input);
    const response = await this.request(
      'POST',
      isAgentConfig(this.config) ? '/agent-api/v1/run' : '/run',
      202,
      {
        request_id: requestId,
        route: this.config.route,
        input,
      },
    );
    return normalizeJob(response, true);
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
        throw publicHttpError(response.status, mode);
      }
      return await readJsonWithLimit(response);
    } catch (error) {
      if (error instanceof BailingHubClientError) throw error;
      if (error instanceof Error && error.name === 'AbortError') {
        throw new BailingHubClientError('BailingHub request timed out.', 408, true);
      }
      throw new BailingHubClientError('Could not connect to BailingHub.', undefined, true);
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

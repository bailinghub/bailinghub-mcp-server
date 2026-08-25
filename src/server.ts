import { createHash, randomUUID } from 'node:crypto';

import {
  McpServer,
  type RegisteredTool,
} from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import {
  BailingHubClient,
  BailingHubClientError,
  type AgentToolCatalog,
  type AgentToolCatalogEntry,
} from './client.js';
import type {
  AgentBailingHubMcpConfig,
  BailingHubRuntimeConfig,
} from './runtime-config.js';
import { PACKAGE_VERSION } from './version.js';

const STATIC_TOOL_NAMES = new Set([
  'submit_governed_job',
  'get_governed_job',
  'wait_for_governed_job',
  'resume_governed_tool_invocation',
]);
const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;
const CAPABILITY_REVISION_PATTERN = /^[a-f0-9]{64}$/;
const DEFAULT_CATALOG_POLL_INTERVAL_MS = 30_000;
const MIN_CATALOG_POLL_INTERVAL_MS = 10;
const MAX_CATALOG_POLL_INTERVAL_MS = 300_000;

type ServerContext = {
  client: BailingHubClient;
};

type PreparedAgentTool = {
  tool: AgentToolCatalogEntry;
  inputSchema: z.ZodType;
  signature: string;
};

type PreparedAgentCatalog = {
  revision: string;
  signature: string;
  tools: Map<string, PreparedAgentTool>;
};

type AgentToolProjectionState = {
  server: McpServer;
  client: BailingHubClient;
  config: AgentBailingHubMcpConfig;
  agentRunId: string;
  revision: string;
  catalogSignature: string;
  tools: Map<string, PreparedAgentTool>;
  handles: Map<string, RegisteredTool>;
  refreshPromise: Promise<boolean> | undefined;
  timer: NodeJS.Timeout | undefined;
  closed: boolean;
};

export type BailingHubMcpAgentProjection = {
  refresh(): Promise<boolean>;
  close(): void;
  revision(): string;
};

export type BailingHubMcpInitializationOptions = {
  client?: BailingHubClient;
  agentRunId?: string;
  catalogPollIntervalMs?: number;
};

const SERVER_CONTEXTS = new WeakMap<McpServer, ServerContext>();
const INITIALIZED_AGENT_SERVERS = new WeakSet<McpServer>();

function success(value: Record<string, unknown>) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

function failure(error: unknown) {
  const message =
    error instanceof Error ? error.message : 'The BailingHub operation failed.';
  return {
    isError: true,
    content: [{ type: 'text' as const, text: message }],
  };
}

function failureText(message: string) {
  return {
    isError: true,
    content: [{ type: 'text' as const, text: message }],
  };
}

function safeClientError(error: unknown): string {
  return error instanceof BailingHubClientError
    ? error.message
    : 'The BailingHub operation failed before a confirmed outcome was returned.';
}

function invocationFailure(error: unknown, invocationId: string) {
  if (
    error instanceof BailingHubClientError &&
    error.disposition === 'accepted_unknown'
  ) {
    return failureText(
      `${safeClientError(error)} invocation_id=${invocationId}. The Hub may have accepted this ` +
        'exact invocation. Do not call the business tool again. Call ' +
        'resume_governed_tool_invocation with this invocation_id to recover its governed outcome.',
    );
  }
  const code =
    error instanceof BailingHubClientError && error.publicCode
      ? ` code=${error.publicCode}.`
      : '';
  return failureText(
    `${safeClientError(error)}${code} invocation_id=${invocationId}. The Hub explicitly rejected ` +
      'this invocation before a confirmed dispatch. Do not call resume for this invocation. ' +
      'Re-evaluate the request and the currently listed tools.',
  );
}

function resumeFailure(error: unknown, invocationId: string) {
  if (
    error instanceof BailingHubClientError &&
    error.disposition === 'accepted_unknown'
  ) {
    return failureText(
      `${safeClientError(error)} invocation_id=${invocationId}. Retrying ` +
        'resume_governed_tool_invocation with this exact invocation_id is safe and does not ' +
        'create a replacement business invocation.',
    );
  }
  const code =
    error instanceof BailingHubClientError && error.publicCode
      ? ` code=${error.publicCode}.`
      : '';
  return failureText(
    `${safeClientError(error)}${code} invocation_id=${invocationId}. The Hub explicitly rejected ` +
      'this recovery request. Do not create a replacement business invocation.',
  );
}

function normalizeJsonSchemaForMcp(value: unknown, depth = 0): unknown {
  if (Array.isArray(value)) {
    return value.map((child) => normalizeJsonSchemaForMcp(child, depth + 1));
  }
  if (typeof value !== 'object' || value === null) return value;
  const normalized = Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== 'default' && key !== 'nullable')
      .map(([key, child]) => [key, normalizeJsonSchemaForMcp(child, depth + 1)]),
  );
  if (depth === 0 || (value as Record<string, unknown>).nullable !== true) {
    return normalized;
  }
  const currentType = normalized.type;
  if (typeof currentType === 'string') {
    normalized.type = [currentType, 'null'];
  } else if (Array.isArray(currentType)) {
    normalized.type = currentType.includes('null')
      ? currentType
      : [...currentType, 'null'];
  } else {
    return { anyOf: [normalized, { type: 'null' }] };
  }
  return normalized;
}

function stableJson(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function dynamicToolDescription(tool: AgentToolCatalogEntry): string {
  const access = tool.readonly
    ? 'read-only'
    : 'may change business data';
  const approval = tool.approval_required
    ? 'human approval required before dispatch'
    : 'no route-level human approval required';
  const idempotency = tool.idempotent
    ? 'declared idempotent'
    : 'not declared idempotent';
  return (
    `${tool.description}\n\nBailingHub governance: risk=${tool.risk}; access=${access}; ` +
    `approval=${approval}; idempotency=${idempotency}. The local Agent chooses and ` +
    'sequences this capability. BailingHub still enforces the authorized route, acting identity, ' +
    'audit, approval, and dispatch controls. After an uncertain transport error, never call this ' +
    'tool again; use resume_governed_tool_invocation with the returned invocation_id.'
  );
}

export function createAgentToolInvocationId(
  sessionId: string,
  agentRunId: string,
  requestId: unknown,
): string {
  if (
    !sessionId ||
    sessionId.length > 128 ||
    /[\u0000-\u001f\u007f]/.test(sessionId) ||
    !UUID_PATTERN.test(agentRunId)
  ) {
    throw new Error('The Agent invocation identity is invalid.');
  }
  let normalizedRequestId: string;
  if (typeof requestId === 'string') {
    if (!requestId || requestId.length > 256 || /[\u0000-\u001f\u007f]/.test(requestId)) {
      throw new Error('The MCP request id is invalid.');
    }
    normalizedRequestId = `string:${requestId}`;
  } else if (typeof requestId === 'number' && Number.isSafeInteger(requestId)) {
    normalizedRequestId = `number:${requestId}`;
  } else {
    throw new Error('The MCP request id is invalid.');
  }
  return createHash('sha256')
    .update('bailinghub.mcp.agent-tool-invocation.v1\0')
    .update(sessionId)
    .update('\0')
    .update(agentRunId)
    .update('\0')
    .update(normalizedRequestId)
    .digest('hex');
}

function asToolArguments(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('The dynamic Agent tool arguments must be an object.');
  }
  return value as Record<string, unknown>;
}

function catalogPollInterval(value: number | undefined): number {
  const interval = value ?? DEFAULT_CATALOG_POLL_INTERVAL_MS;
  if (
    !Number.isInteger(interval) ||
    interval < MIN_CATALOG_POLL_INTERVAL_MS ||
    interval > MAX_CATALOG_POLL_INTERVAL_MS
  ) {
    throw new Error(
      `catalogPollIntervalMs must be an integer from ${MIN_CATALOG_POLL_INTERVAL_MS} ` +
        `to ${MAX_CATALOG_POLL_INTERVAL_MS}.`,
    );
  }
  return interval;
}

function prepareAgentCatalog(
  catalog: AgentToolCatalog,
  config: AgentBailingHubMcpConfig,
): PreparedAgentCatalog {
  if (
    catalog.schema_version !== 'bailing.agent-tool-catalog.v1' ||
    catalog.route !== config.route ||
    !CAPABILITY_REVISION_PATTERN.test(catalog.capability_revision) ||
    !Array.isArray(catalog.tools) ||
    catalog.tools.length > 512
  ) {
    throw new Error('BailingHub rejected an invalid Agent tool catalog before projection.');
  }

  const tools = new Map<string, PreparedAgentTool>();
  for (const tool of [...catalog.tools].sort((a, b) => a.name.localeCompare(b.name))) {
    if (STATIC_TOOL_NAMES.has(tool.name)) {
      throw new Error(
        `BailingHub rejected the Agent tool catalog because ${tool.name} conflicts with a reserved MCP tool.`,
      );
    }
    if (tools.has(tool.name)) {
      throw new Error(
        `BailingHub rejected the Agent tool catalog because ${tool.name} is duplicated.`,
      );
    }
    try {
      const normalizedSchema = normalizeJsonSchemaForMcp(tool.input_schema);
      const inputSchema = z.fromJSONSchema(
        normalizedSchema as Parameters<typeof z.fromJSONSchema>[0],
      );
      tools.set(tool.name, {
        tool,
        inputSchema,
        signature: stableJson({ tool, input_schema: normalizedSchema }),
      });
    } catch {
      throw new Error(
        `BailingHub rejected the Agent tool catalog because ${tool.name} has an unsupported input schema.`,
      );
    }
  }

  return {
    revision: catalog.capability_revision,
    signature: stableJson(
      [...tools.entries()].map(([name, prepared]) => [name, prepared.signature]),
    ),
    tools,
  };
}

function capabilityChangedFailure(
  invocationId: string,
  refreshed: boolean,
  refreshFailed: boolean,
) {
  const catalogState = refreshed
    ? 'The local MCP tool catalog was refreshed.'
    : refreshFailed
      ? 'The local MCP tool catalog could not be refreshed yet.'
      : 'The local MCP catalog was checked but the Hub returned no newer revision.';
  return failureText(
    `BailingHub rejected invocation_id=${invocationId} before dispatch because the capability ` +
      `catalog changed. ${catalogState} Do not resume or repeat this invocation. Re-list the MCP ` +
      'tools and let the local Agent choose again from the current catalog.',
  );
}

function registerProjectedTool(
  state: AgentToolProjectionState,
  prepared: PreparedAgentTool,
): RegisteredTool {
  const { tool, inputSchema } = prepared;
  return state.server.registerTool(
    tool.name,
    {
      title: tool.name,
      description: dynamicToolDescription(tool),
      inputSchema,
      annotations: {
        readOnlyHint: tool.readonly,
        destructiveHint: !tool.readonly,
        idempotentHint: tool.idempotent,
        openWorldHint: true,
      },
    },
    async (argumentsValue, extra) => {
      let invocationId: string;
      try {
        invocationId = createAgentToolInvocationId(
          state.config.sessionId,
          state.agentRunId,
          extra.requestId,
        );
      } catch {
        return failureText(
          'The MCP host supplied an invalid request id. No BailingHub invocation was created.',
        );
      }

      const capabilityRevision = state.revision;
      try {
        return success(
          await state.client.invokeAgentTool({
            invocationId,
            capabilityRevision,
            agentRunId: state.agentRunId,
            tool: tool.name,
            arguments: asToolArguments(argumentsValue),
          }),
        );
      } catch (error) {
        if (
          error instanceof BailingHubClientError &&
          error.publicCode === 'capability_changed'
        ) {
          let refreshed = false;
          let refreshFailed = false;
          try {
            refreshed = await refreshAgentToolCatalog(state);
          } catch {
            refreshFailed = true;
          }
          return capabilityChangedFailure(invocationId, refreshed, refreshFailed);
        }
        return invocationFailure(error, invocationId);
      }
    },
  );
}

function applyAgentCatalog(
  state: AgentToolProjectionState,
  next: PreparedAgentCatalog,
  notify: boolean,
): void {
  const replacedNames = new Set<string>();
  for (const [name, current] of state.tools) {
    const replacement = next.tools.get(name);
    if (!replacement || replacement.signature !== current.signature) {
      state.handles.get(name)?.remove();
      state.handles.delete(name);
      replacedNames.add(name);
    }
  }

  state.revision = next.revision;
  state.catalogSignature = next.signature;
  for (const [name, prepared] of next.tools) {
    if (!state.handles.has(name) || replacedNames.has(name)) {
      state.handles.set(name, registerProjectedTool(state, prepared));
    }
  }
  state.tools = next.tools;
  if (notify) state.server.sendToolListChanged();
}

async function refreshAgentToolCatalog(
  state: AgentToolProjectionState,
): Promise<boolean> {
  if (state.closed) return false;
  if (state.refreshPromise) return await state.refreshPromise;

  const refreshPromise = (async () => {
    const catalog = await state.client.getAgentToolCatalog();
    const next = prepareAgentCatalog(catalog, state.config);
    if (state.closed) return false;
    if (next.revision === state.revision) {
      if (next.signature !== state.catalogSignature) {
        throw new Error(
          'BailingHub returned different Agent tools under the same capability revision.',
        );
      }
      return false;
    }
    applyAgentCatalog(state, next, true);
    return true;
  })();
  state.refreshPromise = refreshPromise;
  try {
    return await refreshPromise;
  } finally {
    if (state.refreshPromise === refreshPromise) state.refreshPromise = undefined;
  }
}

export function createBailingHubMcpServer(
  config: BailingHubRuntimeConfig,
  client = new BailingHubClient(config),
): McpServer {
  const server = new McpServer(
    {
      name: 'bailinghub-mcp-server',
      version: PACKAGE_VERSION,
    },
    {
      instructions:
        config.mode === 'agent'
          ? 'This Agent Session server exposes only route-authorized business tools. The local ' +
            'Agent chooses and sequences them; it must not delegate task planning back to the ' +
            'BailingHub /run endpoint. BailingHub retains identity, route, approval, audit, and ' +
            'dispatch governance. Never treat tool arguments as an authenticated acting subject, ' +
            'an approval decision, or final business authorization.'
          : 'This Client Token server submits untrusted task text to one operator-configured ' +
            'BailingHub route. Reuse the exact request_id when retrying the same business request. ' +
            'Never include credentials or secrets in task text. Preserve the returned job_id for ' +
            'status checks and bounded waits.',
    },
  );

  SERVER_CONTEXTS.set(server, { client });

  if (config.mode === 'agent') return server;

  server.registerTool(
    'submit_governed_job',
    {
      title: 'Submit Governed Job',
      description:
        'Submit a business-system action through an operator-configured BailingHub route. ' +
        'BailingHub applies its configured reach, risk, approval-intent, rate-limit, and audit ' +
        'controls. The downstream business system still performs final authorization.',
      inputSchema: {
        request_id: z
          .string()
          .trim()
          .min(1)
          .max(128)
          .describe(
            'Stable client-scoped idempotency key. Reuse it unchanged when retrying the same request.',
          ),
        input: z
          .string()
          .trim()
          .min(1)
          .max(100_000)
          .describe(
            'Untrusted business task text. Never include tokens, acting-subject credentials, or secrets.',
          ),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ request_id, input }) => {
      try {
        return success(await client.submitJob(request_id, input));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    'get_governed_job',
    {
      title: 'Get Governed Job',
      description:
        'Read the current public state and result of a BailingHub job owned by this client.',
      inputSchema: {
        job_id: z
          .string()
          .uuid()
          .describe('Exact job_id returned by submit_governed_job. Never invent it.'),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ job_id }) => {
      try {
        return success(await client.getJob(job_id));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    'wait_for_governed_job',
    {
      title: 'Wait for Governed Job',
      description:
        'Poll one BailingHub job for a bounded period. A timeout returns the latest state and ' +
        'never resubmits the business action.',
      inputSchema: {
        job_id: z
          .string()
          .uuid()
          .describe('Exact job_id returned by submit_governed_job. Never invent it.'),
        max_wait_seconds: z
          .number()
          .int()
          .min(1)
          .max(60)
          .default(20)
          .describe('Maximum bounded wait from 1 to 60 seconds.'),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ job_id, max_wait_seconds }) => {
      try {
        return success(await client.waitForJob(job_id, max_wait_seconds));
      } catch (error) {
        return failure(error);
      }
    },
  );

  return server;
}

export async function initializeBailingHubMcpServer(
  server: McpServer,
  config: BailingHubRuntimeConfig,
  options: BailingHubMcpInitializationOptions = {},
): Promise<BailingHubMcpAgentProjection | undefined> {
  if (config.mode !== 'agent') return undefined;
  if (INITIALIZED_AGENT_SERVERS.has(server)) {
    throw new Error('The BailingHub Agent tool projection was already initialized.');
  }

  const client =
    options.client ?? SERVER_CONTEXTS.get(server)?.client ?? new BailingHubClient(config);
  const agentRunId = options.agentRunId ?? randomUUID();
  if (!UUID_PATTERN.test(agentRunId)) {
    throw new Error('agentRunId must be a UUID.');
  }
  const pollIntervalMs = catalogPollInterval(options.catalogPollIntervalMs);
  const catalog = await client.getAgentToolCatalog();
  const initial = prepareAgentCatalog(catalog, config);
  const state: AgentToolProjectionState = {
    server,
    client,
    config,
    agentRunId,
    revision: initial.revision,
    catalogSignature: initial.signature,
    tools: new Map(),
    handles: new Map(),
    refreshPromise: undefined,
    timer: undefined,
    closed: false,
  };

  server.registerTool(
    'resume_governed_tool_invocation',
    {
      title: 'Resume Governed Tool Invocation',
      description:
        'Safely recover the exact governed business-tool invocation after an uncertain HTTP ' +
        'outcome, pending approval, or in-progress response. Use only the exact invocation_id ' +
        'returned earlier. This never creates a replacement business invocation.',
      inputSchema: {
        invocation_id: z
          .string()
          .regex(/^[0-9a-f]{64}$/)
          .describe(
            'Exact 64-character lowercase invocation_id returned by a dynamic BailingHub tool.',
          ),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ invocation_id }) => {
      try {
        return success(await client.resumeAgentToolInvocation(invocation_id));
      } catch (error) {
        return resumeFailure(error, invocation_id);
      }
    },
  );

  applyAgentCatalog(state, initial, false);

  const projection: BailingHubMcpAgentProjection = {
    refresh: () => refreshAgentToolCatalog(state),
    close: () => {
      if (state.closed) return;
      state.closed = true;
      if (state.timer) clearInterval(state.timer);
      state.timer = undefined;
    },
    revision: () => state.revision,
  };

  const previousOnClose = server.server.onclose;
  server.server.onclose = () => {
    projection.close();
    previousOnClose?.();
  };
  const originalClose = server.close.bind(server);
  server.close = async () => {
    projection.close();
    await originalClose();
  };

  state.timer = setInterval(() => {
    if (state.closed || !server.isConnected()) return;
    void refreshAgentToolCatalog(state).catch(() => {
      if (!state.closed) {
        console.error('BailingHub Agent tool catalog refresh failed; the last valid catalog remains active.');
      }
    });
  }, pollIntervalMs);
  state.timer.unref();

  INITIALIZED_AGENT_SERVERS.add(server);
  return projection;
}

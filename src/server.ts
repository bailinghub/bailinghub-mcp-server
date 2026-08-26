import { createHash, randomUUID } from 'node:crypto';

import {
  McpServer,
  type RegisteredTool,
} from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import {
  BailingHubClient,
  BailingHubClientError,
  type AgentToolCatalogEntry,
} from './client.js';
import {
  BailingHubAgentClient,
  type AgentCapabilitySearchResult,
  type AgentRunCompletion,
  type AgentRuntimeProfile,
  type AgentTurnContext,
  type CompleteAgentRunInput,
  type StartAgentTurnInput,
} from './agent-client.js';
import type {
  AgentBailingHubMcpConfig,
  BailingHubRuntimeConfig,
} from './runtime-config.js';
import { PACKAGE_VERSION } from './version.js';

const STATIC_TOOL_NAMES = new Set([
  'submit_governed_job',
  'get_governed_job',
  'wait_for_governed_job',
  'start_business_turn',
  'search_business_capabilities',
  'invoke_business_capability',
  'complete_business_run',
  'resume_governed_tool_invocation',
]);
const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;
const CAPABILITY_REVISION_PATTERN = /^[a-f0-9]{64}$/;
const DEFAULT_CATALOG_POLL_INTERVAL_MS = 60_000;
const MIN_CATALOG_POLL_INTERVAL_MS = 10;
const MAX_CATALOG_POLL_INTERVAL_MS = 300_000;

type ServerContext = {
  client: BailingHubClient;
};

type AgentClientContract = Pick<
  BailingHubAgentClient,
  | 'bootstrapWorkspace'
  | 'startTurn'
  | 'searchCapabilities'
  | 'invoke'
  | 'resume'
  | 'completeRun'
>;

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
  client: AgentClientContract;
  config: AgentBailingHubMcpConfig;
  clientConversationId: string;
  runId: string | undefined;
  profileRevision: string;
  revision: string;
  profileEtag: string | undefined;
  catalogSignature: string;
  tools: Map<string, PreparedAgentTool>;
  handles: Map<string, RegisteredTool>;
  refreshPromise: Promise<boolean> | undefined;
  timer: NodeJS.Timeout | undefined;
  pollIntervalMs: number;
  pollDelayMs: number;
  closed: boolean;
  lastCompletion: {
    inputSignature: string;
    result: AgentRunCompletion;
  } | undefined;
};

export type BailingHubMcpAgentProjection = {
  refresh(): Promise<boolean>;
  close(): void;
  revision(): string;
  activeToolNames(): string[];
};

export type BailingHubMcpInitializationOptions = {
  client?: BailingHubClient;
  agentClient?: AgentClientContract;
  clientConversationId?: string;
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

function normalizedMcpRequestId(requestId: unknown): string {
  if (typeof requestId === 'string') {
    if (!requestId || requestId.length > 256 || /[\u0000-\u001f\u007f]/.test(requestId)) {
      throw new Error('The MCP request id is invalid.');
    }
    return `string:${requestId}`;
  }
  if (typeof requestId === 'number' && Number.isSafeInteger(requestId)) {
    return `number:${requestId}`;
  }
  throw new Error('The MCP request id is invalid.');
}

function stableAgentMessageId(
  kind: 'turn' | 'user' | 'assistant',
  ...parts: string[]
): string {
  const hash = createHash('sha256').update(`bailinghub.mcp.${kind}.v1\0`);
  for (const part of parts) hash.update(part).update('\0');
  return `mcp_${kind}:${hash.digest('hex')}`;
}

export function createAgentTurnMessageIds(
  sessionId: string,
  clientConversationId: string,
  requestId: unknown,
  visibleInput: unknown,
): { clientTurnId: string; userMessageId: string } {
  for (const [label, value] of [
    ['sessionId', sessionId],
    ['clientConversationId', clientConversationId],
  ] as const) {
    if (!value || value.length > 128 || /[\u0000-\u001f\u007f]/.test(value)) {
      throw new Error(`${label} is invalid.`);
    }
  }
  const normalizedRequestId = normalizedMcpRequestId(requestId);
  const payload = stableJson(visibleInput);
  return {
    clientTurnId: stableAgentMessageId(
      'turn', sessionId, clientConversationId, normalizedRequestId, payload,
    ),
    userMessageId: stableAgentMessageId(
      'user', sessionId, clientConversationId, normalizedRequestId, payload,
    ),
  };
}

function dynamicToolDescription(tool: AgentToolCatalogEntry): string {
  // Shared governance and recovery rules live once in server instructions. Repeating them on
  // every active tool made large catalogs dominate the model context.
  return tool.description;
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
  const normalizedRequestId = normalizedMcpRequestId(requestId);
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
  capabilityRevision: string,
  activeTools: AgentToolCatalogEntry[],
): PreparedAgentCatalog {
  if (
    !CAPABILITY_REVISION_PATTERN.test(capabilityRevision) ||
    !Array.isArray(activeTools) ||
    activeTools.length > 12
  ) {
    throw new Error('BailingHub rejected an invalid active Agent tool set before projection.');
  }

  const tools = new Map<string, PreparedAgentTool>();
  for (const tool of [...activeTools].sort((a, b) => a.name.localeCompare(b.name))) {
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
    revision: capabilityRevision,
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

async function invokeActiveTool(
  state: AgentToolProjectionState,
  tool: AgentToolCatalogEntry,
  argumentsValue: Record<string, unknown>,
  requestId: unknown,
) {
  if (!state.runId) {
    return failureText(
      'No Agent run is active. Call start_business_turn before invoking a business capability.',
    );
  }
  let invocationId: string;
  try {
    invocationId = createAgentToolInvocationId(
      state.config.sessionId,
      state.runId,
      requestId,
    );
  } catch {
    return failureText(
      'The MCP host supplied an invalid request id. No BailingHub invocation was created.',
    );
  }
  try {
    return success(
      await state.client.invoke({
        invocationId,
        capabilityRevision: state.revision,
        agentRunId: state.runId,
        tool: tool.name,
        arguments: argumentsValue,
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
        refreshed = await refreshAgentRuntimeProfile(state);
      } catch {
        refreshFailed = true;
      }
      return capabilityChangedFailure(invocationId, refreshed, refreshFailed);
    }
    return invocationFailure(error, invocationId);
  }
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
      try {
        return await invokeActiveTool(
          state,
          tool,
          asToolArguments(argumentsValue),
          extra.requestId,
        );
      } catch {
        return failureText(
          'The MCP host supplied invalid business-tool arguments. No BailingHub invocation was created.',
        );
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
    const profile = await state.client.bootstrapWorkspace({
      ...(state.profileEtag ? { ifNoneMatch: state.profileEtag } : {}),
    });
    if (state.closed) return false;
    if (profile.not_modified) {
      if (profile.etag) state.profileEtag = profile.etag;
      return false;
    }
    const profileChanged = profile.profile.revision !== state.profileRevision;
    const capabilitiesChanged = profile.capabilities.revision !== state.revision;
    state.profileRevision = profile.profile.revision;
    state.profileEtag = profile.etag;
    if (capabilitiesChanged) {
      applyAgentCatalog(
        state,
        prepareAgentCatalog(profile.capabilities.revision, []),
        true,
      );
    }
    return profileChanged || capabilitiesChanged;
  })();
  state.refreshPromise = refreshPromise;
  try {
    return await refreshPromise;
  } finally {
    if (state.refreshPromise === refreshPromise) state.refreshPromise = undefined;
  }
}

const refreshAgentRuntimeProfile = refreshAgentToolCatalog;

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
          ? 'This Agent Session server lets the local Agent plan and sequence work while BailingHub ' +
            'provides a route-authorized runtime profile, knowledge context, a replaceable active ' +
            'tool set, identity binding, approval, audit, and dispatch governance. Start each user ' +
            'turn with start_business_turn; use search_business_capabilities when the active tools ' +
            'are insufficient. Never treat tool arguments as identity, approval, or final business ' +
            'authorization. After an uncertain invocation outcome, never repeat the business tool; ' +
            'recover only with resume_governed_tool_invocation and the exact invocation_id.'
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

  const client: AgentClientContract = options.agentClient ?? new BailingHubAgentClient({
    baseUrl: config.baseUrl,
    clientAppId: config.clientAppId,
    workspace: config.route,
    sessionId: config.sessionId,
    accessTokenProvider: config.accessTokenProvider,
  }, {
    allowInsecureHttp: config.allowInsecureHttp,
  });
  const clientConversationId = options.clientConversationId ?? randomUUID();
  if (!clientConversationId || clientConversationId.length > 128 || /[\u0000-\u001f\u007f]/.test(clientConversationId)) {
    throw new Error('clientConversationId is invalid.');
  }
  const pollIntervalMs = catalogPollInterval(options.catalogPollIntervalMs);
  const profile = await client.bootstrapWorkspace();
  const initial = prepareAgentCatalog(profile.capabilities.revision, []);
  const state: AgentToolProjectionState = {
    server,
    client,
    config,
    clientConversationId,
    runId: undefined,
    profileRevision: profile.profile.revision,
    revision: initial.revision,
    profileEtag: profile.etag,
    catalogSignature: initial.signature,
    tools: new Map(),
    handles: new Map(),
    refreshPromise: undefined,
    timer: undefined,
    pollIntervalMs,
    pollDelayMs: pollIntervalMs,
    closed: false,
    lastCompletion: undefined,
  };

  server.registerTool(
    'start_business_turn',
    {
      title: 'Start Business Turn',
      description:
        'Start one local-Agent turn, retrieve the governed runtime context, and replace the ' +
        'active business-tool set with the capabilities relevant to this user request.',
      inputSchema: {
        user_input: z.string().min(1).max(64_000),
        page_context: z.record(z.string(), z.unknown()).refine(
          (value) => Buffer.byteLength(JSON.stringify(value), 'utf8') <= 16 * 1024,
          'page_context must not exceed 16 KiB.',
        ).optional(),
        renderers: z.array(z.string().min(1).max(64)).max(20).optional(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ user_input, page_context, renderers }, extra) => {
      let clientTurnId: string;
      let userMessageId: string;
      try {
        ({ clientTurnId, userMessageId } = createAgentTurnMessageIds(
          state.config.sessionId,
          state.clientConversationId,
          extra.requestId,
          { user_input, page_context: page_context ?? null, renderers: renderers ?? [] },
        ));
      } catch {
        return failureText('The MCP host supplied an invalid request id. No Agent turn was created.');
      }
      const input: StartAgentTurnInput = {
        clientConversationId: state.clientConversationId,
        clientTurnId,
        userMessageId,
        userInput: user_input,
        ...(page_context ? { pageContext: page_context } : {}),
        ...(renderers ? { renderers } : {}),
      };
      try {
        const turn: AgentTurnContext = await state.client.startTurn(input);
        state.runId = turn.run_id;
        state.lastCompletion = undefined;
        state.profileRevision = turn.profile_revision;
        applyAgentCatalog(
          state,
          prepareAgentCatalog(turn.capability_revision, turn.active_tools),
          server.isConnected(),
        );
        return success({
          schema: turn.schema,
          run_id: turn.run_id,
          profile_revision: turn.profile_revision,
          capability_revision: turn.capability_revision,
          context: turn.context,
          active_tools: turn.active_tools.map((tool) => ({
            name: tool.name,
            scope: tool.scope,
            risk: tool.risk,
            approval_required: tool.approval_required,
          })),
        });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    'search_business_capabilities',
    {
      title: 'Search Business Capabilities',
      description:
        'Search within the authorized workspace and replace the current active tool set with up ' +
        'to 12 capabilities relevant to the query or current turn. This grants no new authority.',
      inputSchema: {
        query: z.string().max(2_000).optional(),
        limit: z.number().int().min(1).max(12).default(12),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ query, limit }) => {
      const hasQuery = typeof query === 'string' && Boolean(query.trim());
      if (!hasQuery && !state.runId) {
        return failureText(
          'A non-empty query or an active Agent run is required to search business capabilities.',
        );
      }
      try {
        const result: AgentCapabilitySearchResult = await state.client.searchCapabilities({
          ...(hasQuery ? { query } : {}),
          limit,
          ...(state.runId ? { runId: state.runId } : {}),
        });
        applyAgentCatalog(
          state,
          prepareAgentCatalog(result.capability_revision, result.tools),
          server.isConnected(),
        );
        return success({
          schema: result.schema,
          capability_revision: result.capability_revision,
          active_tools: result.tools.map((tool) => ({
            name: tool.name,
            scope: tool.scope,
            risk: tool.risk,
            approval_required: tool.approval_required,
          })),
        });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    'invoke_business_capability',
    {
      title: 'Invoke Active Business Capability',
      description:
        'Invoke one capability from the current active set. Prefer its dynamically listed typed ' +
        'tool when the MCP host supports tools/list_changed.',
      inputSchema: {
        tool: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/),
        arguments: z.record(z.string(), z.unknown()),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ tool, arguments: argumentsValue }, extra) => {
      const prepared = state.tools.get(tool);
      if (!prepared) {
        return failureText(
          'The requested capability is not in the current active set. Start the turn or search capabilities first.',
        );
      }
      return await invokeActiveTool(state, prepared.tool, argumentsValue, extra.requestId);
    },
  );

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
        return success(await client.resume(invocation_id));
      } catch (error) {
        return resumeFailure(error, invocation_id);
      }
    },
  );

  server.registerTool(
    'complete_business_run',
    {
      title: 'Complete Business Run',
      description:
        'Synchronize only the visible final assistant message and public usage metadata for the ' +
        'current local-Agent run. Hidden reasoning must never be submitted.',
      inputSchema: {
        content: z.string().min(1).max(64_000),
        status: z.enum(['completed', 'failed', 'cancelled']).default('completed'),
        model: z.string().min(1).max(191).regex(/^[^\u0000-\u001f\u007f]+$/).optional(),
        runtime: z.string().min(1).max(191).regex(/^[^\u0000-\u001f\u007f]+$/).optional(),
        usage: z.object({
          input_tokens: z.number().nonnegative().optional(),
          cached_input_tokens: z.number().nonnegative().optional(),
          output_tokens: z.number().nonnegative().optional(),
          total_tokens: z.number().nonnegative().optional(),
          tool_calls: z.number().nonnegative().optional(),
          cost_usd: z.number().nonnegative().optional(),
        }).strict().optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ content, status, model, runtime, usage }) => {
      const inputSignature = stableJson({ content, status, model: model ?? null, runtime: runtime ?? null, usage: usage ?? null });
      if (!state.runId) {
        return state.lastCompletion?.inputSignature === inputSignature
          ? success(state.lastCompletion.result)
          : failureText('No Agent run is active.');
      }
      const runId = state.runId;
      const input: CompleteAgentRunInput = {
        assistantMessageId: stableAgentMessageId('assistant', runId, inputSignature),
        content,
        status,
        ...(model ? { model } : {}),
        ...(runtime ? { runtime } : {}),
        ...(usage ? { usage } : {}),
      };
      try {
        const completed = await state.client.completeRun(runId, input);
        state.lastCompletion = { inputSignature, result: completed };
        state.runId = undefined;
        applyAgentCatalog(state, prepareAgentCatalog(state.revision, []), server.isConnected());
        return success(completed);
      } catch (error) {
        return failure(error);
      }
    },
  );

  applyAgentCatalog(state, initial, false);

  const projection: BailingHubMcpAgentProjection = {
    refresh: () => refreshAgentRuntimeProfile(state),
    close: () => {
      if (state.closed) return;
      state.closed = true;
      if (state.timer) clearTimeout(state.timer);
      state.timer = undefined;
    },
    revision: () => state.revision,
    activeToolNames: () => [...state.tools.keys()].sort(),
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

  const scheduleRefresh = () => {
    if (state.closed) return;
    state.timer = setTimeout(async () => {
      if (state.closed) return;
      if (!server.isConnected()) {
        state.pollDelayMs = state.pollIntervalMs;
        scheduleRefresh();
        return;
      }
      try {
        await refreshAgentRuntimeProfile(state);
        // If the Hub supplied an ETag, every poll is a cheap conditional request. Without an
        // ETag, back off to avoid repeatedly downloading even the compact bootstrap document.
        state.pollDelayMs = state.profileEtag
          ? state.pollIntervalMs
          : Math.min(MAX_CATALOG_POLL_INTERVAL_MS, Math.max(state.pollIntervalMs, state.pollDelayMs * 2));
      } catch {
        state.pollDelayMs = Math.min(MAX_CATALOG_POLL_INTERVAL_MS, Math.max(state.pollIntervalMs, state.pollDelayMs * 2));
        if (!state.closed) {
          console.error('BailingHub Agent runtime profile refresh failed; the last valid profile remains active.');
        }
      }
      scheduleRefresh();
    }, state.pollDelayMs);
    state.timer.unref();
  };
  scheduleRefresh();

  INITIALIZED_AGENT_SERVERS.add(server);
  return projection;
}

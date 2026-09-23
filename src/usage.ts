import { normalizeBaseUrl } from './config.js';
import { usageFrames } from './usage-stream.js';
import { MODEL_GATEWAY_PATHS, type ModelDirectory, type BillingSummary, type ModelRequest, type ModelOperation, type ModelStreamEvent, type ModelRecoveryOptions, type ModelTools, type ModelToolRequest } from './model-usage.js';
export * from './model-usage.js';

export const USAGE_V1_PATHS = { capabilities: '/usage/v1/capabilities' } as const;
export type UsageBinding = { hubUrl: string; userId: string; accountId: string; serviceId: string };
export type UsageCapabilities = {
  schema: 'bailing.usage.v1'; supported: true; modes: ('credits' | 'periodic')[];
  streaming: true; orchestration: 'host';
  model_gateway: { schema: 'bailing.model-gateway.v1'; supported: true; orchestration: 'host'; streaming: true; requests_path: string; models_path: string; summary_path: string; billing_unit: 'USD'; turn_required: false; provider_response: 'bailing.provider-response.v1'; settlement: 'asynchronous'; model_tools?: { schema: 'bailing.model-tools.v1'; directory: boolean; execution: boolean; tools_path: string; requests_path?: string } };
};
export type UsageModelDescriptor = {
  schema: 'bailing.usage-model.v1'; service_id: string; service_revision: number; label: string; model: string;
  billing_rate?: { multiplier: number };
  state: string; orchestration: 'host'; streaming: true; input_formats: string[];
  model_modalities: ('text' | 'image')[] | null; context_window_tokens: number | null; max_input_bytes: number;
  input_limit_scope: 'serialized_provider_request'; max_messages: number; max_tools: number;
  max_output_tokens: number; timeout_ms: number; provider_options: string[];
};
export type UsageInputLimit = { kind: 'serialized_provider_bytes'; actual: number; allowed: number; message_count: number; tool_count: number };
export type UsageRequestOptions = { signal?: AbortSignal };
export type UsageClientOptions = {
  hubUrl: string; userId: string; accountId: string; serviceId: string;
  /** A short-lived Usage session token from the trusted product backend, never an Agent/Client/issuer token. */
  accessTokenProvider: () => string | Promise<string>;
  allowInsecureHttp?: boolean; fetchImpl?: typeof fetch; timeoutMs?: number;
};
export type UsageFeedback = {
  schema: 'bailing.usage-feedback.v1'; code: string; dispatch: 'not_dispatched' | 'unknown';
  next_action: 'wait_for_capacity' | 'upgrade_required' | 'reauthenticate' | 'authenticate' | 'contact_operator' | 'wait_for_reset' | 'retry_original' | 'inspect_original' | 'upgrade' | 'resolve_error' | 'select_model';
  retryable: boolean;
  input_limit?: UsageInputLimit;
};
const LOCAL_NEXT_ACTIONS: Record<string, UsageFeedback['next_action']> = {
  USAGE_UNSUPPORTED: 'upgrade_required',
  USAGE_CREDENTIAL_UNAVAILABLE: 'reauthenticate', USAGE_CREDENTIAL_INVALID: 'reauthenticate',
  USAGE_TRANSPORT_UNAVAILABLE: 'retry_original',
  USAGE_OPERATION_NOT_FOUND: 'contact_operator',
};
const NEXT_ACTIONS = new Set<UsageFeedback['next_action']>([
  'wait_for_capacity', 'upgrade_required', 'reauthenticate', 'authenticate', 'contact_operator',
  'wait_for_reset', 'retry_original', 'inspect_original', 'upgrade', 'resolve_error', 'select_model',
]);
const UNKNOWN_SAFE_ACTIONS = new Set<UsageFeedback['next_action']>([
  'inspect_original', 'contact_operator', 'reauthenticate', 'authenticate', 'upgrade_required', 'upgrade', 'resolve_error',
]);

/** Sanitized transport failure. Original request identifiers stay available for read-only recovery. */
export class BailingHubUsageError extends Error {
  readonly feedback: UsageFeedback;
  constructor(readonly code: string, readonly status: number | undefined,
    readonly dispatch: UsageFeedback['dispatch'], readonly operationId?: string,
    readonly turnId?: string, readonly resetAt?: string | number, serverFeedback?: Partial<UsageFeedback>) {
    super(`BailingHub usage request failed (${code}).`);
    this.name = 'BailingHubUsageError';
    const localNext = LOCAL_NEXT_ACTIONS[code];
    const next = dispatch === 'unknown' ? localNext && UNKNOWN_SAFE_ACTIONS.has(localNext) ? localNext : 'inspect_original'
      : localNext ?? 'resolve_error';
    this.feedback = { schema: 'bailing.usage-feedback.v1', code, dispatch, next_action: next,
      retryable: next === 'retry_original' || next === 'inspect_original' };
    if (serverFeedback && serverFeedback.next_action && NEXT_ACTIONS.has(serverFeedback.next_action)
      && (dispatch !== 'unknown' || UNKNOWN_SAFE_ACTIONS.has(serverFeedback.next_action))) {
      this.feedback.next_action = serverFeedback.next_action;
      this.feedback.retryable = typeof serverFeedback.retryable === 'boolean' ? serverFeedback.retryable
        : serverFeedback.next_action === 'retry_original' || serverFeedback.next_action === 'inspect_original';
    }
    const limit = serverFeedback?.input_limit;
    if (limit?.kind === 'serialized_provider_bytes' && ['actual', 'allowed', 'message_count', 'tool_count'].every(k =>
      Number.isSafeInteger(limit[k as keyof UsageInputLimit]) && Number(limit[k as keyof UsageInputLimit]) >= 0)) this.feedback.input_limit = { kind: limit.kind, actual: limit.actual, allowed: limit.allowed, message_count: limit.message_count, tool_count: limit.tool_count };

  }
}
function text(value: unknown, name: string, maximum = 191): string {
  if (typeof value !== 'string' || !value.length || value.length > maximum || value.trim() !== value
    || /[\u0000-\u001f\u007f]/.test(value)) throw new TypeError(`${name} must be an exact nonempty identifier.`);
  return value;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BailingHubUsageError('USAGE_RESPONSE_INVALID', undefined, 'not_dispatched');
  return value as Record<string, unknown>;
}
function assert(condition: unknown, code = 'USAGE_RESPONSE_INVALID'): asserts condition {
  if (!condition) throw new BailingHubUsageError(code, undefined, 'not_dispatched');
}
/** Exact twelve-place accounting values; provider usage counts use the separate integer validator. */
function allowanceMicros(value: unknown): bigint | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) return null;
  const parts = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/.exec(String(value));
  if (!parts) return null;
  let units = BigInt(parts[1]! + (parts[2] ?? ''));
  const shift = 12 + Number(parts[3] ?? 0) - (parts[2]?.length ?? 0);
  if (shift >= 0) units *= 10n ** BigInt(shift);
  else {
    const divisor = 10n ** BigInt(-shift);
    if (units % divisor !== 0n) return null;
    units /= divisor;
  }
  const decimal = `${units / 1_000_000_000_000n}.${String(units % 1_000_000_000_000n).padStart(12, '0')}`;
  return Number(decimal) === value ? units : null;
}
function rateValue(value: unknown): boolean {
  return typeof value === 'number' && value >= 0.000001 && value <= 1000 && allowanceMicros(value) !== null;
}
const SHARED_USAGE_CODES = new Set(['MODEL_TOOL_ADAPTER_NOT_READY', 'METERING_UNAVAILABLE', 'METERING_REQUIRED', 'SERVICE_NOT_ENTITLED', 'RECONCILIATION_REQUIRED', 'ALLOWANCE_INSUFFICIENT', 'QUOTA_WINDOW_EXHAUSTED', 'SUBSCRIPTION_EXPIRED']);
function publicCode(value: unknown, fallback: string): string {
  return typeof value === 'string' && (/^USAGE_[A-Z0-9_]{1,80}$/.test(value) || SHARED_USAGE_CODES.has(value)) ? value : fallback;
}

/**
 * Optional host API; no management tools and no automatic retries. This client only meters
 * requests sent through the controlled service. Direct BYOK/model requests remain outside it.
 */
export class BailingHubUsageClient {
  readonly binding: Readonly<UsageBinding>;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  constructor(private readonly options: UsageClientOptions) {
    this.binding = Object.freeze({ hubUrl: normalizeBaseUrl(options.hubUrl, options.allowInsecureHttp),
      userId: text(options.userId, 'userId'), accountId: text(options.accountId, 'accountId'),
      serviceId: text(options.serviceId, 'serviceId') });
    if (typeof options.accessTokenProvider !== 'function') throw new TypeError('A Usage accessTokenProvider is required.');
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 120_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 660_000) throw new TypeError('timeoutMs is invalid.');
  }
  private async open(path: string, method = 'GET', body?: unknown, options: UsageRequestOptions = {},
    identity: { operationId?: string; turnId?: string } = {}): Promise<Response> {
    // A failed GET says nothing about whether the original model POST executed.
    const recovering = method === 'GET' && identity.operationId !== undefined;
    const preflightDispatch = recovering ? 'unknown' : 'not_dispatched';
    if (options.signal?.aborted) throw new BailingHubUsageError('USAGE_CANCELLED', 499, preflightDispatch, identity.operationId, identity.turnId);
    let token: string;
    try { token = await this.options.accessTokenProvider(); }
    catch { throw new BailingHubUsageError('USAGE_CREDENTIAL_UNAVAILABLE', 401, preflightDispatch, identity.operationId, identity.turnId); }
    if (typeof token !== 'string' || !/^bhu_s_[A-Za-z0-9_-]{16,512}$/.test(token)) {
      throw new BailingHubUsageError('USAGE_CREDENTIAL_INVALID', 401, preflightDispatch, identity.operationId, identity.turnId);
    }
    if (options.signal?.aborted) throw new BailingHubUsageError('USAGE_CANCELLED', 499, preflightDispatch, identity.operationId, identity.turnId);
    let response: Response;
    const unknown = method === 'POST' && [MODEL_GATEWAY_PATHS.requests, MODEL_GATEWAY_PATHS.stream, MODEL_GATEWAY_PATHS.toolRequests].includes(path as typeof MODEL_GATEWAY_PATHS.requests);
    const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(this.timeoutMs)]) : AbortSignal.timeout(this.timeoutMs);
    try {
      response = await this.fetchImpl(`${this.binding.hubUrl}${path}`, {
        method, headers: { authorization: `Bearer ${token}`, accept: path === MODEL_GATEWAY_PATHS.stream ? 'text/event-stream' : 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'error', signal,
      });
    } catch {
      throw new BailingHubUsageError(options.signal?.aborted ? 'USAGE_CANCELLED' : 'USAGE_TRANSPORT_UNAVAILABLE', undefined,
        unknown || recovering ? 'unknown' : 'not_dispatched', identity.operationId, identity.turnId);
    }
    return response;
  }
  private async request(path: string, method = 'GET', body?: unknown, options: UsageRequestOptions = {},
    identity: { operationId?: string; turnId?: string } = {}): Promise<Record<string, unknown>> {
    return this.decode(await this.open(path, method, body, options, identity), method, path, identity);
  }
  private async decode(response: Response, method: string, path: string,
    identity: { operationId?: string; turnId?: string }): Promise<Record<string, unknown>> {
    const recovering = method === 'GET' && identity.operationId !== undefined;
    const unknown = method === 'POST' && [MODEL_GATEWAY_PATHS.requests, MODEL_GATEWAY_PATHS.stream, MODEL_GATEWAY_PATHS.toolRequests].includes(path as typeof MODEL_GATEWAY_PATHS.requests);
    let result: Record<string, unknown>;
    try {
      if (!response.body) throw new Error();
      const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
      try {
        while (true) {
          const part = await reader.read(); if (part.done) break;
          size += part.value.byteLength; if (size > (identity.operationId ? 32 : 4) * 1024 * 1024) throw new Error(); chunks.push(part.value);
        }
      } finally { await reader.cancel().catch(() => {}); }
      result = object(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    } catch {
      throw new BailingHubUsageError(response.status === 404 ? 'USAGE_UNSUPPORTED' : 'USAGE_RESPONSE_INVALID', response.status,
        recovering || unknown && response.status !== 404 ? 'unknown' : 'not_dispatched', identity.operationId, identity.turnId);
    }
    if (!response.ok) {
      const detail = result.error && typeof result.error === 'object' ? object(result.error) : result;
      const feedback = result.feedback && typeof result.feedback === 'object' ? object(result.feedback) : undefined;
      const fallback = response.status === 404 || response.status === 501 ? 'USAGE_UNSUPPORTED'
        : response.status === 401 ? 'USAGE_CREDENTIAL_INVALID' : 'USAGE_REQUEST_REJECTED';
      const dispatch = recovering || unknown && (feedback?.dispatch === 'unknown' || detail.dispatch === 'unknown' || result.dispatch === 'unknown'
        || (response.status >= 500 && feedback?.dispatch !== 'not_dispatched'))
        ? 'unknown' : 'not_dispatched';
      throw new BailingHubUsageError(publicCode(feedback?.code ?? detail.code ?? detail.error ?? result.code, fallback), response.status, dispatch,
        identity.operationId, identity.turnId, typeof (feedback?.resetAt ?? feedback?.reset_at ?? detail.reset_at) === 'number' || typeof (feedback?.resetAt ?? feedback?.reset_at ?? detail.reset_at) === 'string'
          ? (feedback?.resetAt ?? feedback?.reset_at ?? detail.reset_at) as string | number : undefined, feedback as Partial<UsageFeedback> | undefined);
    }
    return result;
  }
  async capabilities(options?: UsageRequestOptions): Promise<UsageCapabilities> {
    const value = await this.request(USAGE_V1_PATHS.capabilities, 'GET', undefined, options);
    assert(value.schema === 'bailing.usage.v1' && value.supported === true && value.streaming === true
      && value.orchestration === 'host', 'USAGE_UNSUPPORTED');
    assert(Array.isArray(value.modes) && value.modes.length > 0 && value.modes.every(mode => ['credits', 'periodic'].includes(String(mode))));
    assert(value.model_gateway && typeof value.model_gateway === 'object', 'USAGE_UNSUPPORTED');
    const gateway = object(value.model_gateway);
    assert(gateway.schema === 'bailing.model-gateway.v1' && gateway.supported === true && gateway.orchestration === 'host'
      && gateway.streaming === true && gateway.turn_required === false && gateway.billing_unit === 'USD'
      && gateway.requests_path === MODEL_GATEWAY_PATHS.requests && gateway.models_path === MODEL_GATEWAY_PATHS.models
      && gateway.summary_path === MODEL_GATEWAY_PATHS.summary
      && gateway.provider_response === 'bailing.provider-response.v1' && gateway.settlement === 'asynchronous', 'USAGE_UNSUPPORTED');
    return value as UsageCapabilities;
  }
  private validateModel(result: Record<string, unknown>): void {
    assert(typeof result.label === 'string' && result.label.trim().length > 0 && result.label.length <= 191
      && !/[\u0000-\u001f\u007f]/.test(result.label));
    assert(typeof result.model === 'string' && ['service_revision', 'max_input_bytes', 'max_messages', 'max_tools', 'max_output_tokens', 'timeout_ms']
      .every(key => Number.isSafeInteger(result[key]) && Number(result[key]) > 0));
    assert(result.context_window_tokens === null || Number.isSafeInteger(result.context_window_tokens) && Number(result.context_window_tokens) > 0);
    assert(result.model_modalities === null || Array.isArray(result.model_modalities) && result.model_modalities.length > 0
      && result.model_modalities.every(item => ['text', 'image'].includes(String(item))));
    if (result.billing_rate !== undefined) {
      const rate = object(result.billing_rate);
      assert(rateValue(rate.multiplier));
    }
    assert(Array.isArray(result.input_formats) && Array.isArray(result.provider_options) && result.provider_options.every(item => typeof item === 'string'));
  }
  /** Read the live plan/credential intersection. Labels are display text, not model identity. */
  async modelModels(options?: UsageRequestOptions): Promise<ModelDirectory> {
    const value = await this.request(MODEL_GATEWAY_PATHS.models, 'GET', undefined, options);
    assert(value.schema === 'bailing.model-models.v1');
    assert(value.account_id === this.binding.accountId && value.user_id === this.binding.userId, 'USAGE_BINDING_MISMATCH');
    assert(value.selection === 'plan'
      && (value.plan_id === null && value.plan_revision === null
        || typeof value.plan_id === 'string' && value.plan_id.length > 0 && Number.isSafeInteger(value.plan_revision) && Number(value.plan_revision) > 0));
    assert(Array.isArray(value.items));
    const ids = new Set<string>();
    for (const item of value.items) {
      const descriptor = object(item);
      assert(descriptor.schema === 'bailing.usage-model.v1' && descriptor.orchestration === 'host' && descriptor.streaming === true
        && typeof descriptor.service_id === 'string' && descriptor.service_id.length > 0 && !ids.has(descriptor.service_id));
      this.validateModel(descriptor); ids.add(descriptor.service_id as string);
    }
    assert(value.default_service_id === null || typeof value.default_service_id === 'string' && ids.has(value.default_service_id));
    assert(value.items.length > 0 || value.default_service_id === null);
    assert(value.plan_id !== null || value.items.length === 0);
    return value as ModelDirectory;
  }
  /** Only the authenticated account's plan tools; reading this catalog performs no generation. */
  async modelTools(options?: UsageRequestOptions): Promise<ModelTools> {
    const value = await this.request(MODEL_GATEWAY_PATHS.tools, 'GET', undefined, options);
    assert(value.schema === 'bailing.model-tools.v1');
    assert(value.account_id === this.binding.accountId && value.user_id === this.binding.userId, 'USAGE_BINDING_MISMATCH');
    assert(Array.isArray(value.items));
    const ids = new Set<string>();
    for (const raw of value.items) {
      const item = object(raw), tool = object(item.tool), rate = object(item.billing_rate);
      assert(item.schema === 'bailing.model-tool.v1' && typeof item.service_id === 'string' && item.service_id.length > 0
        && !ids.has(item.service_id) && Number.isSafeInteger(item.service_revision) && Number(item.service_revision) > 0
        && typeof item.label === 'string' && typeof item.capability === 'string' && typeof item.callable === 'boolean'
        && typeof item.state === 'string' && (item.reason === undefined || item.reason === null || typeof item.reason === 'string')
        && item.orchestration === 'host' && item.billing_unit === 'USD' && item.billing_scope === 'shared_plan'
        && rateValue(rate.multiplier) && Array.isArray(item.outputs) && item.outputs.every(v => typeof v === 'string')
        && typeof tool.name === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(tool.name)
        && typeof tool.description === 'string' && object(tool.input_schema).type === 'object');
      ids.add(item.service_id);
    }
    return value as ModelTools;
  }
  /** One generation operation. Unknown transport outcomes must be inspected by this original ID. */
  async runModelTool(input: ModelToolRequest, options?: UsageRequestOptions): Promise<ModelOperation> {
    if (!input || Object.keys(input).some(k => !['operation_id', 'service_id', 'arguments', 'conversation_id', 'turn_id'].includes(k))
      || !objectOrNull(input.arguments)) throw new TypeError('Invalid model tool request.');
    const identity = { operationId: text(input.operation_id, 'operation_id'), serviceId: text(input.service_id, 'service_id'),
      ...(input.turn_id === undefined ? {} : {turnId: text(input.turn_id, 'turn_id')}),
      ...(input.conversation_id === undefined ? {} : {conversationId: text(input.conversation_id, 'conversation_id')}) };
    return this.modelOperation(await this.request(MODEL_GATEWAY_PATHS.toolRequests, 'POST', input, options, identity), identity.operationId,
      { ...identity, turnId: input.turn_id ?? null, conversationId: input.conversation_id ?? null });
  }
  async modelSummary(options?: UsageRequestOptions): Promise<BillingSummary> {
    const value = await this.request(MODEL_GATEWAY_PATHS.summary, 'GET', undefined, options);
    assert(value.schema === 'bailing.billing-summary.v1');
    assert(value.accountId === this.binding.accountId && value.user_id === this.binding.userId
      && value.service_id === this.binding.serviceId, 'USAGE_BINDING_MISMATCH');
    assert(['availableUsd', 'consumedUsd', 'currentPeriodConsumedUsd', 'overageUsd']
      .every(key => allowanceMicros(value[key]) !== null));
    assert(Number.isSafeInteger(value.pendingRequests) && Number(value.pendingRequests) >= 0);
    assert(['resetAt', 'expiresAt'].every(key => value[key] === null || Number.isSafeInteger(value[key]) && Number(value[key]) >= 0));
    if (value.grant !== null) {
      const grant = object(value.grant), config = object(grant.config), duration = object(config.duration);
      assert(grant.accountId === this.binding.accountId, 'USAGE_BINDING_MISMATCH');
      assert(['id', 'planId', 'label', 'sourceOwner'].every(key => typeof grant[key] === 'string')
        && ['revision', 'planRevision'].every(key => Number.isSafeInteger(grant[key]) && Number(grant[key]) >= 0)
        && ['active', 'suspended'].includes(String(grant.state)) && Number.isSafeInteger(grant.startsAt)
        && (grant.expiresAt === null || Number.isSafeInteger(grant.expiresAt)));
      assert(['credits', 'periodic'].includes(String(config.mode)) && Object.keys(config).every(key => ['mode', 'priceUsd', 'periodAllowanceUsd', 'periodUnit', 'duration'].includes(key))
        && allowanceMicros(config.priceUsd) !== null && Number(config.priceUsd) > 0
        && !Object.hasOwn(config, 'displayUnit') && ['day', 'month', 'forever'].includes(String(duration.unit))
        && Number.isSafeInteger(duration.count) && Number(duration.count) >= 0
        && (config.mode === 'periodic'
          ? allowanceMicros(config.periodAllowanceUsd) !== null && Number(config.periodAllowanceUsd) > 0 && ['day', 'week', 'month'].includes(String(config.periodUnit))
          : !Object.hasOwn(config, 'periodAllowanceUsd') && !Object.hasOwn(config, 'periodUnit')));
    }
    assert(Object.hasOwn(value, 'plan'));
    if (value.plan !== null) {
      const plan = object(value.plan);
      assert(value.grant !== null && plan.id === object(value.grant).planId
        && typeof plan.label === 'string' && plan.label.trim().length > 0 && plan.label.length <= 191
        && Number.isSafeInteger(plan.revision) && Number(plan.revision) > 0
        && Array.isArray(plan.serviceIds) && plan.serviceIds.every(id => typeof id === 'string' && id.length > 0)
        && new Set(plan.serviceIds as string[]).size === plan.serviceIds.length);
      assert(rateValue(plan.multiplier));
    }
    this.validatePresentation(value);
    return value as BillingSummary;
  }
  private validatePresentation(summary: Record<string, unknown>): void {
    const presentation = object(summary.presentation);
    assert(presentation.schema === 'bailing.usage-presentation.v1'
      && ['credits', 'percentage', 'none'].includes(String(presentation.kind))
      && ['active', 'depleted', 'not_started', 'expired', 'suspended', 'unavailable'].includes(String(presentation.state))
      && ['remaining', 'total'].every(key => presentation[key] === null
        || typeof presentation[key] === 'number' && Number.isFinite(presentation[key]) && Number(presentation[key]) >= 0)
      && (presentation.displayValue === null || typeof presentation.displayValue === 'string'));
    if (summary.grant === null) {
      assert(presentation.kind === 'none' && presentation.state === 'unavailable'
        && presentation.remaining === null && presentation.total === null && presentation.displayValue === null);
      return;
    }
    const grant = object(summary.grant), config = object(grant.config);
    const credits = config.mode === 'credits', usable = ['active', 'depleted'].includes(String(presentation.state));
    assert(presentation.kind === (credits ? 'credits' : 'percentage'));
    if (!usable) {
      assert(['not_started', 'expired', 'suspended'].includes(String(presentation.state))
        && presentation.remaining === null && presentation.displayValue === null);
      return;
    }
    assert(grant.state === 'active' && typeof presentation.total === 'number' && presentation.total > 0
      && typeof presentation.remaining === 'number' && presentation.remaining >= 0
      && presentation.state === (Number(summary.availableUsd) > 0 ? 'active' : 'depleted')
      && typeof presentation.displayValue === 'string' && /^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,2})?$|^<(?:1|0\.01)$/.test(presentation.displayValue));
    assert(presentation.state !== 'active' || presentation.remaining > 0);
    assert(presentation.state !== 'depleted' || presentation.remaining === 0 && presentation.displayValue === '0');
    if (!credits) assert(presentation.total === 100 && presentation.remaining <= 100);
    // Presentation is authoritative. Hosts never infer balances from raw provider tokens or local prices.
  }

  private modelInput(input: ModelRequest): { operationId: string; turnId?: string; serviceId: string; conversationId?: string } {
    if (!input || Object.keys(input).some(key => !['operation_id', 'service_id', 'conversation_id', 'turn_id', 'messages', 'tools', 'tool_choice', 'temperature', 'provider_options'].includes(key))) {
      throw new TypeError('Model requests cannot select another account or billing policy.');
    }
    // Provider capacity is authoritative. Do not introduce an SDK-only message/tool/turn count budget.
    if (!Array.isArray(input.messages) || !input.messages.length || input.tools !== undefined && !Array.isArray(input.tools)) throw new TypeError('Invalid model gateway request.');
    return { operationId: text(input.operation_id, 'operation_id'), serviceId: input.service_id === undefined ? this.binding.serviceId : text(input.service_id, 'service_id'),
      ...(input.turn_id === undefined ? {} : { turnId: text(input.turn_id, 'turn_id') }),
      ...(input.conversation_id === undefined ? {} : { conversationId: text(input.conversation_id, 'conversation_id') }) };
  }
  async modelComplete(input: ModelRequest, options?: UsageRequestOptions): Promise<ModelOperation> {
    const identity = this.modelInput(input);
    return this.modelOperation(await this.request(MODEL_GATEWAY_PATHS.requests, 'POST', input, options, identity), identity.operationId, { ...identity, turnId: input.turn_id ?? null, conversationId: input.conversation_id ?? null });
  }
  async *modelStream(input: ModelRequest, options: UsageRequestOptions = {}): AsyncGenerator<ModelStreamEvent> {
    const identity = this.modelInput(input);
    const response = await this.open(MODEL_GATEWAY_PATHS.stream, 'POST', input, options, identity);
    if (!response.ok) { await this.decode(response, 'POST', MODEL_GATEWAY_PATHS.stream, identity); return; }
    let sequence = 0, terminal: ModelStreamEvent | undefined;
    try {
      for await (const raw of usageFrames(response)) {
        const frame = object(raw);
        if (terminal || frame.schema !== 'bailing.model-stream.v1' || frame.operation_id !== identity.operationId || frame.seq !== ++sequence) throw new Error();
        if (frame.type === 'operation') terminal = { ...frame, operation: this.modelOperation(object(frame.operation), identity.operationId, { ...identity, turnId: input.turn_id ?? null, conversationId: input.conversation_id ?? null }) } as ModelStreamEvent;
        else if (frame.type === 'started' && sequence === 1) yield frame as ModelStreamEvent;
        else if (frame.type === 'provider' && sequence > 1 && providerEnvelope(frame.provider, 'data')) yield frame as ModelStreamEvent;
        else if (frame.type === 'delta' && sequence > 1 && frame.delta && typeof frame.delta === 'object' && !Array.isArray(frame.delta)) yield frame as ModelStreamEvent;
        else throw new Error();
      }
      if (!terminal || options.signal?.aborted) throw new Error();
    } catch {
      throw new BailingHubUsageError(options.signal?.aborted ? 'USAGE_CANCELLED' : 'USAGE_STREAM_INCOMPLETE', response.status, 'unknown', identity.operationId, identity.turnId);
    }
    yield terminal;
  }
  async inspectModelRequest(operationId: string, options: ModelRecoveryOptions = {}): Promise<ModelOperation> {
    const id = text(operationId, 'operation_id');
    return this.modelOperation(await this.request(`${MODEL_GATEWAY_PATHS.requests}/${encodeURIComponent(id)}`, 'GET', undefined, options, { operationId: id }), id, options);
  }
  async cancelModelRequest(operationId: string, options: ModelRecoveryOptions = {}): Promise<ModelOperation> {
    const id = text(operationId, 'operation_id');
    try {
      return this.modelOperation(await this.request(`${MODEL_GATEWAY_PATHS.requests}/${encodeURIComponent(id)}/cancel`, 'POST', {}, options, { operationId: id }), id, options);
    } catch (error) {
      // A cancellation transport failure never proves that the original model request was not sent.
      if (error instanceof BailingHubUsageError) throw new BailingHubUsageError(error.code, error.status, 'unknown', id, options.turnId, error.resetAt, error.feedback);
      throw error;
    }
  }
  private modelOperation(value: Record<string, unknown>, id: string, expected: { serviceId?: string; turnId?: string | null; conversationId?: string | null } = {}): ModelOperation {
    const count = (item: unknown) => Number.isSafeInteger(item) && Number(item) >= 0;
    const coordinates = (key: string, wanted?: string | null) => wanted === undefined ? value[key] === null || typeof value[key] === 'string' : value[key] === wanted;
    const usage = value.usage;
    const diagnostic = objectOrNull(value.error);
    const diagnosticValid = diagnostic && Object.keys(diagnostic).every(key => ['code','message','http_status','provider_code','provider_request_id','retryable','next_action'].includes(key))
      && ['USAGE_PROVIDER_REJECTED','USAGE_PROVIDER_ERROR','USAGE_TRANSPORT_UNCERTAIN','USAGE_PROVIDER_INVALID'].includes(String(diagnostic.code))
      && typeof diagnostic.message === 'string' && diagnostic.message.length <= 240 && diagnostic.retryable === false
      && ['contact_operator','inspect_original'].includes(String(diagnostic.next_action))
      && (diagnostic.http_status === undefined || (Number.isInteger(diagnostic.http_status) && Number(diagnostic.http_status) >= 100 && Number(diagnostic.http_status) <= 599))
      && ['provider_code','provider_request_id'].every(key => diagnostic[key] === undefined || (typeof diagnostic[key] === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(String(diagnostic[key]))));
    const rate = value.billing_rate && typeof value.billing_rate === 'object' && !Array.isArray(value.billing_rate)
      ? value.billing_rate as Record<string, unknown> : null;
    const rateValid = rate && typeof rate.planId === 'string' && rate.planId.length > 0
      && rateValue(rate.multiplier) && count(rate.planRevision) && Number(rate.planRevision) > 0
      && objectOrNull(rate.price) !== null;
    if (value.schema !== 'bailing.model-operation.v1' || value.operation_id !== id
      || value.account_id !== this.binding.accountId || value.user_id !== this.binding.userId
      || value.service_id !== (expected.serviceId ?? this.binding.serviceId)
      || !coordinates('conversation_id', expected.conversationId) || !coordinates('turn_id', expected.turnId)
      || !['admitted', 'dispatch_committed', 'completed', 'unknown', 'cancelled', 'failed'].includes(String(value.state))
      || !['pending', 'complete', 'unknown', 'cancelled', 'failed'].includes(String(value.result_state))
      || !['pending', 'settled'].includes(String(value.billing_state)) || !count(value.revision)
      || !['not_dispatched', 'completed', 'unknown', 'rejected'].includes(String(value.dispatch))
      || !['none', 'inspect_original', 'contact_operator'].includes(String(value.next_action))
      || (value.error !== undefined && !diagnosticValid)
      || (value.result_state === 'failed' && (value.state !== 'failed' || value.dispatch !== 'rejected' || !diagnosticValid || diagnostic?.code !== 'USAGE_PROVIDER_REJECTED' || value.next_action !== 'contact_operator' || value.response !== undefined))
      || !rateValid || ![value.billed_usd, value.reference_cost_usd, value.overage_usd].every(item => item === null || allowanceMicros(item) !== null)
      || (value.response !== undefined && (!value.response || typeof value.response !== 'object' || Array.isArray(value.response)))
      || (objectOrNull(value.response)?.schema === 'bailing.provider-response.v1' && !providerEnvelope(value.response, 'body'))
      || (value.response_expired !== undefined && value.response_expired !== true)
      || (value.result_state === 'complete' && !value.response && value.response_expired !== true)
      || (value.raw_usage !== undefined && value.raw_usage !== null && objectOrNull(value.raw_usage) === null)
      || (usage !== undefined && usage !== null && (!usage || typeof usage !== 'object' || Array.isArray(usage)
        || !['inputTokens', 'outputTokens', 'totalTokens'].every(key => count((usage as Record<string, unknown>)[key]))
        || Number((usage as Record<string, number>).inputTokens) + Number((usage as Record<string, number>).outputTokens) !== (usage as Record<string, number>).totalTokens))) {
      throw new BailingHubUsageError('USAGE_RESPONSE_INVALID', undefined, 'unknown', id, expected.turnId ?? undefined);
    }
    return value as ModelOperation;
  }

}
export function createUsageClient(options: UsageClientOptions): BailingHubUsageClient { return new BailingHubUsageClient(options); }

function objectOrNull(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
/** Envelope validation only. Provider content is interpreted by the local model adapter. */
function providerEnvelope(value: unknown, body: 'data' | 'body'): boolean {
  const v = objectOrNull(value);
  return Boolean(v && v.schema === 'bailing.provider-response.v1' && ['sse', 'json'].includes(String(v.format))
    && v.content_type === (v.format === 'sse' ? 'text/event-stream' : 'application/json')
    && Number.isInteger(v.status) && Number(v.status) >= 200 && Number(v.status) <= 599
    && typeof v[body] === 'string');
}

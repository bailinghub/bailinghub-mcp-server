/** USD model gateway. Supplier tokens remain raw usage, never an allowance balance. */
import type { UsageModelDescriptor } from './usage.js';
export type BillingAllowanceConfig = {
  mode: 'credits' | 'periodic'; priceUsd: number;
  periodAllowanceUsd?: number;
  periodUnit?: 'day' | 'week' | 'month'; duration: { unit: 'day' | 'month' | 'forever'; count: number };
};
/** Model membership is live plan policy, never a grant snapshot. Empty selection is valid. */
export type ModelRate = { multiplier: number };
export type BillingRate = ModelRate & { planId: string; planRevision: number; price: Record<string, unknown> };
export type BillingPlanConfig = BillingAllowanceConfig & { serviceIds: string[]; multiplier: number };
export type BillingPlanDirectory = { id: string; label: string; revision: number; serviceIds: string[]; multiplier: number };
export type BillingGrant = {
  id: string; accountId: string; planId: string; planRevision: number; label: string;
  revision: number; state: 'active' | 'suspended'; sourceOwner: string; startsAt: number;
  expiresAt: number | null; config: BillingAllowanceConfig;
};
/** Authoritative customer display. Raw accounting fields are never a customer-UI fallback. */
export type UsagePresentation = {
  schema: 'bailing.usage-presentation.v1'; kind: 'credits' | 'percentage' | 'none';
  state: 'active' | 'depleted' | 'not_started' | 'expired' | 'suspended' | 'unavailable';
  remaining: number | null; total: number | null; displayValue: string | null;
};
export type BillingSummary = {
  schema: 'bailing.billing-summary.v1'; accountId: string; user_id: string; service_id: string;
  grant: BillingGrant | null; plan: BillingPlanDirectory | null; availableUsd: number; consumedUsd: number;
  currentPeriodConsumedUsd: number; overageUsd: number; resetAt: number | null;
  expiresAt: number | null; pendingRequests: number; presentation: UsagePresentation;
};
export type ModelDirectory = {
  schema: 'bailing.model-models.v1'; account_id: string; user_id: string;
  plan_id: string | null; plan_revision: number | null; selection: 'plan';
  default_service_id: string | null; items: UsageModelDescriptor[];
};
/** Coordinates are audit metadata only. The local host owns its loop; no Hub turn is opened. */
export type ModelRequest = {
  operation_id: string; service_id?: string; conversation_id?: string; turn_id?: string;
  messages: Record<string, unknown>[]; tools?: Record<string, unknown>[];
  tool_choice?: unknown; temperature?: number; provider_options?: Record<string, unknown>;
};
export type ModelOperation = {
  schema: 'bailing.model-operation.v1'; operation_id: string; account_id: string; user_id: string;
  service_id: string; conversation_id: string | null; turn_id: string | null;
  state: 'admitted' | 'dispatch_committed' | 'completed' | 'unknown' | 'cancelled' | 'failed';
  result_state: 'pending' | 'complete' | 'unknown' | 'cancelled' | 'failed'; billing_state: 'pending' | 'settled';
  dispatch: 'not_dispatched' | 'completed' | 'unknown' | 'rejected'; next_action: 'none' | 'inspect_original' | 'contact_operator';
  error?: {code: string; message: string; http_status?: number; provider_code?: string; provider_request_id?: string; retryable: false; next_action: 'contact_operator' | 'inspect_original'};
  revision: number; response?: Record<string, unknown>; response_expired?: true;
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number } | null;
  /** USD debit, up to twelve decimal places; actual usage remains integer supplier counts. */
  billed_usd: number | null; overage_usd: number | null;
  reference_cost_usd: number | null; raw_usage?: Record<string, unknown> | null;
  billing_rate: BillingRate;
};
export type ProviderResponse = {
  schema: 'bailing.provider-response.v1'; format: 'sse' | 'json'; status: number;
  content_type: 'text/event-stream' | 'application/json'; body: string;
};
export type ProviderPacket = Omit<ProviderResponse, 'body'> & { data: string };
export type ModelStreamEvent = { schema: 'bailing.model-stream.v1'; operation_id: string; seq: number }
  & ({ type: 'started' } | { type: 'provider'; provider: ProviderPacket } | { type: 'delta'; delta: Record<string, unknown> } | { type: 'operation'; operation: ModelOperation });
export type ModelRecoveryOptions = { signal?: AbortSignal; serviceId?: string; conversationId?: string; turnId?: string };
export const MODEL_GATEWAY_PATHS = {
  models: '/usage/v1/model/models', summary: '/usage/v1/model/summary',
  tools: '/usage/v1/model/tools', toolRequests: '/usage/v1/model/tools/requests',
  requests: '/usage/v1/model/requests', stream: '/usage/v1/model/requests/stream',
} as const;

export type ModelToolDescriptor = {
  schema: 'bailing.model-tool.v1'; service_id: string; service_revision: number; label: string;
  capability: string; outputs: string[]; callable: boolean; state: string; reason?: string | null;
  orchestration: 'host'; billing_unit: 'USD'; billing_scope: 'shared_plan'; billing_rate: ModelRate;
  tool: { name: string; description: string; input_schema: Record<string, unknown> };
};
export type ModelTools = {
  schema: 'bailing.model-tools.v1'; account_id: string; user_id: string;
  items: ModelToolDescriptor[];
};
export type ModelToolRequest = {
  operation_id: string; service_id: string; arguments: Record<string, unknown>;
  conversation_id?: string; turn_id?: string;
};

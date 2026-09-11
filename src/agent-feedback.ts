/** Public, host-neutral failure guidance. Messages and codes never contain server error bodies. */
export type AgentFailureCategory =
  | 'tool_not_loaded' | 'capability_changed' | 'transport_unavailable'
  | 'authorization_unavailable' | 'unsupported' | 'invocation_outcome_unknown'
  | 'unknown_failure' | 'cancelled' | 'invalid_request';
export type AgentFailureOperation = 'search' | 'invoke' | 'resume' | 'authorize' | 'scope' | 'tool_dispatch';
export type AgentFailureOrigin = 'core' | 'sdk' | 'mcp' | 'dsh' | 'host';
export type AgentFailureDispatch = 'not_dispatched' | 'attempted' | 'unknown';
export type AgentFailureNextAction = 'rediscover' | 'retry_discovery' | 'restore_scope' | 'reauthorize'
  | 'check_compatibility' | 'resume_original' | 'inspect_original' | 'none';
export type AgentFailureFeedback = {
  schema: 'bailing.agent-feedback.v1';
  category: AgentFailureCategory;
  code: string;
  origin: AgentFailureOrigin;
  operation: AgentFailureOperation;
  dispatch: AgentFailureDispatch;
  /** Applies only to next_action, never permission to create another business invocation. */
  retryable: boolean;
  next_action: AgentFailureNextAction;
  invocation_id?: string;
  disposition?: 'accepted_unknown' | 'definitive_rejection' | 'refresh_required';
  message: string;
};
export type AgentFailureContext = {
  operation: AgentFailureOperation;
  origin?: AgentFailureOrigin;
  dispatch?: AgentFailureDispatch;
  invocationId?: string;
};

const CODES = new Set([
  'agent_client_disabled', 'agent_direct_disabled', 'agent_runtime_unavailable', 'agent_tools_unavailable',
  'arguments_too_large', 'assistant_message_conflict', 'audience_not_allowed', 'capability_changed',
  'hub_paused', 'invalid_request', 'invalid_route', 'invocation_conflict', 'invocation_not_found',
  'page_context_too_large', 'route_not_allowed', 'route_unavailable', 'run_completion_conflict',
  'run_not_found', 'tool_not_found', 'turn_conflict', 'conversation_audit_conflict',
  'conversation_audit_not_found', 'conversation_audit_not_ready', 'conversation_audit_authorization_invalid',
  'conversation_audit_limit', 'conversation_audit_unavailable', 'conversation_audit_internal_error',
  'conversation_audit_cross_binding_unavailable', 'system_info_unsupported', 'agent_binding_changed',
  'agent_request_cancelled', 'agent_transport_unavailable', 'agent_request_timeout',
  'agent_authorization_unavailable', 'agent_schema_unsupported', 'agent_invalid_response',
  'tool_not_loaded', 'reconciliation_required', 'unknown_failure',
]);
const AUTH_CODES = new Set(['agent_binding_changed', 'agent_authorization_unavailable', 'audience_not_allowed',
  'route_not_allowed', 'conversation_audit_authorization_invalid']);
const TRANSPORT_CODES = new Set(['agent_transport_unavailable', 'agent_request_timeout']);
const INVALID_CODES = new Set(['invalid_request', 'invalid_route', 'arguments_too_large', 'page_context_too_large']);
const MESSAGES: Record<AgentFailureCategory, string> = {
  tool_not_loaded: 'This business tool is no longer loaded. Rediscover capabilities for the original target.',
  capability_changed: 'The capability declaration changed. Rediscover capabilities before choosing a tool.',
  transport_unavailable: 'The service could not return a confirmed response. Follow the indicated recovery action.',
  authorization_unavailable: 'The original authorization is unavailable. Do not select another authorization automatically.',
  unsupported: 'This response or operation requires a compatible version.',
  invocation_outcome_unknown: 'The original invocation outcome is uncertain. Do not repeat the business operation.',
  unknown_failure: 'The operation failed without a classified outcome. Do not infer that the system lacks this capability.',
  cancelled: 'The request was cancelled. Cancellation does not undo a dispatched business operation.',
  invalid_request: 'The request could not be accepted. Review the current tool and its arguments.',
};

/** Classify only stable codes, typed status, and dispatch facts supplied by the producing layer. */
export function describeAgentFailure(error: unknown, context: AgentFailureContext): AgentFailureFeedback {
  const value = error && typeof error === 'object' ? error as Record<string, unknown> : {};
  const code = typeof value.publicCode === 'string' && CODES.has(value.publicCode)
    ? value.publicCode : error instanceof TypeError ? 'invalid_request' : 'unknown_failure';
  const disposition = value.disposition === 'accepted_unknown' || value.disposition === 'definitive_rejection'
    || value.disposition === 'refresh_required' ? value.disposition : undefined;
  const original = context.invocationId ?? value.invocationId;
  const invocationId = typeof original === 'string' && /^[a-f0-9]{64}$/.test(original) ? original : undefined;
  const dispatch = context.dispatch ?? 'unknown';
  let category: AgentFailureCategory = 'unknown_failure';
  if (code === 'tool_not_loaded') category = 'tool_not_loaded';
  else if (code === 'capability_changed') category = 'capability_changed';
  else if (code === 'agent_request_cancelled') category = 'cancelled';
  else if (AUTH_CODES.has(code) || value.statusCode === 401 || value.statusCode === 403) category = 'authorization_unavailable';
  else if (code === 'agent_schema_unsupported' || code === 'system_info_unsupported'
    || code === 'conversation_audit_cross_binding_unavailable') category = 'unsupported';
  else if (TRANSPORT_CODES.has(code)) category = 'transport_unavailable';
  else if (INVALID_CODES.has(code)) category = 'invalid_request';

  // A new error must not erase the unresolved outcome of an already attempted write.
  const uncertainInvocation = disposition === 'accepted_unknown'
    || (context.operation === 'invoke' && dispatch !== 'not_dispatched');
  if (uncertainInvocation && (context.operation === 'invoke' || context.operation === 'resume')) {
    category = 'invocation_outcome_unknown';
  }
  let nextAction: AgentFailureNextAction = 'none';
  if ((code === 'invocation_conflict' || code === 'reconciliation_required') && invocationId) nextAction = 'inspect_original';
  else if (category === 'invocation_outcome_unknown') nextAction = invocationId ? 'resume_original' : 'inspect_original';
  else if (context.operation === 'resume') {
    nextAction = category === 'transport_unavailable' && invocationId ? 'resume_original' : 'inspect_original';
  } else if (category === 'tool_not_loaded' || category === 'capability_changed') {
    nextAction = dispatch === 'not_dispatched' ? 'rediscover' : 'none';
  } else if (category === 'transport_unavailable' && context.operation === 'search') {
    nextAction = 'retry_discovery';
  } else if (category === 'transport_unavailable' && (context.operation === 'authorize' || context.operation === 'scope')) {
    nextAction = 'restore_scope';
  } else if (category === 'authorization_unavailable') {
    nextAction = code === 'agent_binding_changed' ? 'restore_scope' : 'reauthorize';
  } else if (category === 'unsupported') nextAction = 'check_compatibility';
  return {
    schema: 'bailing.agent-feedback.v1', category, code,
    origin: context.origin ?? 'sdk', operation: context.operation, dispatch,
    retryable: nextAction === 'retry_discovery' || nextAction === 'rediscover'
      || nextAction === 'restore_scope' || nextAction === 'resume_original',
    next_action: nextAction,
    ...(invocationId ? { invocation_id: invocationId } : {}),
    ...(disposition ? { disposition } : {}),
    message: MESSAGES[category],
  };
}

/** Attach the same sanitized value consumed by the MCP adapter and other client hosts. */
export function attachAgentFailure(error: unknown, context: AgentFailureContext): Error & { feedback: AgentFailureFeedback } {
  const target = error instanceof Error ? error : new Error('The Agent operation failed.');
  return Object.assign(target, { feedback: describeAgentFailure(error, context) });
}

/** An HTTP success can still carry an unresolved business result. Keep its existing state and ID. */
export function reconciliationFeedback(invocationId: string, operation: 'invoke' | 'resume' = 'invoke'): AgentFailureFeedback {
  return describeAgentFailure({ publicCode: 'reconciliation_required', disposition: 'accepted_unknown', invocationId },
    { operation, origin: 'core', dispatch: 'attempted', invocationId });
}

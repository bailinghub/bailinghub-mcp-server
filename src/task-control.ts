import { BailingHubClientError } from './client.js';

export type AgentTaskBinding = {
  schema_version: 'bailing.agent-task-binding.v1';
  task_id: string;
  scope_hash: string;
};

export type AgentTaskControlCapabilities = {
  schema_version: 'bailing.agent-task-control-capabilities.v1';
  supported: boolean;
  mode: 'optional' | 'required';
  task_schema: 'bailing.agent-task.v1';
  metering: 'write_invocation';
  same_hub_only: true;
  controls: ['pause', 'resume', 'cancel'];
  inspect_invocation: boolean;
};

export type AgentTaskMember = {
  session_id: string;
  client_app_id: string;
  workspace: string;
  client_conversation_id: string;
  allowed_tools: string[];
};

/** A shared task observation, never a dispatch permit or business result. */
export type AgentTaskSnapshot = {
  schema_version: 'bailing.agent-task.v1';
  task_id: string;
  state: 'active' | 'paused' | 'blocked' | 'cancelled';
  revision: number;
  ledger_sequence: number;
  scope_hash: string;
  member_count: number;
  member: AgentTaskMember;
  policy: { max_write_calls: number | null; max_concurrent: number; expires_at: string | null };
  counters: { write_reserved: number; write_consumed: number; active_permits: number };
  metering: 'write_invocation';
  snapshot_is_dispatch_permission: false;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DIGEST = /^[a-f0-9]{64}$/;
const TOOL = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const ROUTE = /^[a-z0-9][a-z0-9_-]{1,63}$/;
const INVALID_UNICODE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

export function taskError(code: string): BailingHubClientError {
  return new BailingHubClientError('The governed task contract could not be validated.', undefined, false, code,
    'definitive_rejection', undefined, { operation: 'scope', origin: 'sdk', dispatch: 'not_dispatched' });
}

function check(condition: unknown, code = 'TASK_RECORD_INVALID'): asserts condition {
  if (!condition) throw taskError(code);
}
function object(value: unknown): Record<string, unknown> {
  check(value && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}
function text(value: unknown, maximum: number): string {
  check(typeof value === 'string' && value.length > 0 && value.length <= maximum && value.trim() === value
    && !/[\u0000-\u001f\u007f]/.test(value) && !INVALID_UNICODE.test(value));
  return value;
}
function integer(value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
  check(typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum);
  return value;
}
function uuid(value: unknown): string {
  check(typeof value === 'string' && UUID.test(value));
  return value.toLowerCase();
}

export function taskIdInput(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw new TypeError('taskId must be a UUID.');
  return value.toLowerCase();
}
export function taskConversationInput(value: unknown): string {
  try { const result = text(value, 128); check(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(result)); return result; }
  catch { throw new TypeError('clientConversationId must be an exact nonempty identifier of at most 128 characters.'); }
}

export function taskBinding(value: unknown, input = false): AgentTaskBinding {
  try {
    const body = object(value);
    check(body.schema_version === 'bailing.agent-task-binding.v1', 'TASK_UNSUPPORTED');
    if (input) check(Object.keys(body).every((key) => ['schema_version', 'task_id', 'scope_hash'].includes(key)));
    check(typeof body.scope_hash === 'string' && DIGEST.test(body.scope_hash));
    return { schema_version: 'bailing.agent-task-binding.v1', task_id: uuid(body.task_id), scope_hash: body.scope_hash };
  } catch (error) {
    if (input) throw new TypeError('taskBinding must contain the exact supported schema, task_id, and scope_hash.');
    throw error;
  }
}

export function taskCapabilities(value: unknown): AgentTaskControlCapabilities {
  const body = object(value);
  check(body.schema_version === 'bailing.agent-task-control-capabilities.v1'
    && body.task_schema === 'bailing.agent-task.v1', 'TASK_UNSUPPORTED');
  check(typeof body.supported === 'boolean' && typeof body.mode === 'string' && ['optional', 'required'].includes(body.mode)
    && body.metering === 'write_invocation' && body.same_hub_only === true
    && Array.isArray(body.controls) && body.controls.length === 3
    && body.controls.every((item) => ['pause', 'resume', 'cancel'].includes(item)) && new Set(body.controls).size === 3
    && typeof body.inspect_invocation === 'boolean' && (!body.supported || body.inspect_invocation));
  return { schema_version: 'bailing.agent-task-control-capabilities.v1', supported: body.supported,
    mode: body.mode as AgentTaskControlCapabilities['mode'], task_schema: 'bailing.agent-task.v1',
    metering: 'write_invocation', same_hub_only: true, controls: ['pause', 'resume', 'cancel'], inspect_invocation: body.inspect_invocation };
}

export function taskSnapshot(value: unknown, expected: {
  taskId: string; sessionId: string; clientAppId: string; workspace: string; clientConversationId: string;
}): AgentTaskSnapshot {
  const body = object(value);
  check(body.schema_version === 'bailing.agent-task.v1', 'TASK_UNSUPPORTED');
  const taskId = uuid(body.task_id);
  check(taskId === expected.taskId, 'TASK_BINDING_CONFLICT');
  check(typeof body.scope_hash === 'string' && DIGEST.test(body.scope_hash));
  check(typeof body.state === 'string' && ['active', 'paused', 'blocked', 'cancelled'].includes(body.state)
    && body.metering === 'write_invocation' && body.snapshot_is_dispatch_permission === false);
  const member = object(body.member);
  const sessionId = uuid(member.session_id);
  const clientAppId = text(member.client_app_id, 64);
  const workspace = text(member.workspace, 64);
  const conversation = text(member.client_conversation_id, 128);
  check(ROUTE.test(workspace) && workspace !== 'auto');
  check(sessionId === expected.sessionId.toLowerCase() && clientAppId === expected.clientAppId
    && workspace === expected.workspace && conversation === expected.clientConversationId, 'TASK_MEMBER_MISMATCH');
  check(Array.isArray(member.allowed_tools) && member.allowed_tools.length > 0 && member.allowed_tools.length <= 256
    && member.allowed_tools.every((tool) => typeof tool === 'string' && TOOL.test(tool))
    && new Set(member.allowed_tools).size === member.allowed_tools.length);
  const policy = object(body.policy);
  const expiresAt = policy.expires_at;
  if (expiresAt !== null) {
    check(typeof expiresAt === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(expiresAt)
      && Number.isFinite(Date.parse(expiresAt)) && Number(expiresAt.slice(0, 4)) >= 1000);
    check(new Date(expiresAt).toISOString() === expiresAt.replace(/(?:\.(\d{1,3}))?Z$/,
      (_match, digits) => `.${String(digits ?? '').padEnd(3, '0')}Z`));
  }
  const maxWriteCalls = policy.max_write_calls === null ? null : integer(policy.max_write_calls, 0, 1_000_000_000);
  const maxConcurrent = integer(policy.max_concurrent, 1, 10_000);
  const counters = object(body.counters);
  const writeReserved = integer(counters.write_reserved);
  const writeConsumed = integer(counters.write_consumed);
  const activePermits = integer(counters.active_permits, 0, maxConcurrent);
  check(maxWriteCalls === null || writeReserved + writeConsumed <= maxWriteCalls);
  const revision = integer(body.revision, 1);
  return { schema_version: 'bailing.agent-task.v1', task_id: taskId,
    state: body.state as AgentTaskSnapshot['state'], revision, ledger_sequence: integer(body.ledger_sequence, revision),
    scope_hash: body.scope_hash, member_count: integer(body.member_count, 1, 64),
    member: { session_id: sessionId, client_app_id: clientAppId, workspace, client_conversation_id: conversation,
      allowed_tools: [...member.allowed_tools] as string[] },
    policy: { max_write_calls: maxWriteCalls, max_concurrent: maxConcurrent, expires_at: expiresAt },
    counters: { write_reserved: writeReserved, write_consumed: writeConsumed, active_permits: activePermits },
    metering: 'write_invocation', snapshot_is_dispatch_permission: false };
}

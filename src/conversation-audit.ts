import { BailingHubClientError } from './client.js';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const STATUSES = new Set(['completed', 'failed', 'cancelled']);
export const CONVERSATION_BATCH_BYTES = 192 * 1024;

export type ConversationAuditEvent = {
  event_id: string;
  sequence: number;
  client_turn_id: string;
  kind: 'turn_start' | 'user_message' | 'assistant_message' | 'run_link' | 'turn_end';
  content?: string;
  run_id?: string;
  member_session_id?: string;
  status?: 'completed' | 'failed' | 'cancelled';
};
export type ConversationAudit = {
  schema: 'bailing.agent-conversation-audit.v1';
  conversation_id: string;
  state: 'enrolling' | 'ready';
  member_count: number;
  confirmed_count: number;
  last_sequence: number;
};
export type ConversationAuditAck = {
  schema: 'bailing.agent-conversation-audit-ack.v1';
  conversation_id: string;
  last_sequence: number;
};
export type CreateConversationAuditInput = {
  clientArchiveId: string;
  clientConversationId: string;
  memberSessionIds: string[];
  memberLabels?: Record<string, string>;
};

export function auditUuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw new TypeError('Conversation identifier must be a UUID.');
  return value.toLowerCase();
}
export function auditId(value: unknown): string {
  if (typeof value !== 'string' || !ID.test(value)) throw new TypeError('Conversation event identifier is invalid.');
  return value;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Conversation payload must be an object.');
  return value as Record<string, unknown>;
}
export function auditEvents(value: unknown): ConversationAuditEvent[] {
  if (!Array.isArray(value) || value.length > 20_000) throw new TypeError('Conversation events must be a bounded array.');
  const ids = new Set<string>();
  let previous: number | undefined;
  return value.map((raw) => {
    const item = object(raw);
    const event: ConversationAuditEvent = {
      event_id: auditId(item.event_id),
      sequence: Number(item.sequence),
      client_turn_id: auditId(item.client_turn_id),
      kind: item.kind as ConversationAuditEvent['kind'],
    };
    if (typeof item.sequence !== 'number' || !Number.isSafeInteger(event.sequence) || event.sequence < 1 ||
        (previous !== undefined && event.sequence !== previous + 1) || ids.has(event.event_id)) {
      throw new TypeError('Conversation events require unique IDs and consecutive positive sequences.');
    }
    previous = event.sequence;
    ids.add(event.event_id);
    if (event.kind === 'user_message' || event.kind === 'assistant_message') {
      if (typeof item.content !== 'string' || !item.content.trim() || item.content.length > 64_000 ||
          /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(item.content)) {
        throw new TypeError('Conversation visible text is invalid or too large.');
      }
      event.content = item.content;
    } else if (event.kind === 'run_link') {
      event.run_id = auditUuid(item.run_id);
      event.member_session_id = auditUuid(item.member_session_id);
    } else if (event.kind === 'turn_end') {
      if (!STATUSES.has(String(item.status))) throw new TypeError('Conversation turn status is invalid.');
      event.status = item.status as NonNullable<ConversationAuditEvent['status']>;
    } else if (event.kind !== 'turn_start') {
      throw new TypeError('Unsupported visible conversation event.');
    }
    // Project visible text and governed references only. Extra host fields cannot enter HTTP.
    if (Buffer.byteLength(JSON.stringify({ events: [event] })) > CONVERSATION_BATCH_BYTES) {
      throw new TypeError('Conversation event exceeds the transport byte limit.');
    }
    return event;
  });
}

export function auditCreateBody(input: CreateConversationAuditInput, route: string): Record<string, unknown> {
  if (!Array.isArray(input.memberSessionIds) || input.memberSessionIds.length < 1 || input.memberSessionIds.length > 64) {
    throw new TypeError('Conversation requires 1 to 64 frozen members.');
  }
  const members = input.memberSessionIds.map(auditUuid);
  if (new Set(members).size !== members.length) throw new TypeError('Conversation members must be unique.');
  const labels: Record<string, string> = {};
  if (input.memberLabels !== undefined) {
    for (const [id, label] of Object.entries(object(input.memberLabels))) {
      const normalizedId = auditUuid(id);
      if (!members.includes(normalizedId) || typeof label !== 'string' || !label.trim() || label.length > 128 ||
          /[\u0000-\u001f\u007f]/.test(label)) throw new TypeError('Conversation member label is invalid.');
      labels[normalizedId] = label;
    }
  }
  return {
    client_archive_id: auditUuid(input.clientArchiveId),
    client_conversation_id: auditId(input.clientConversationId), route,
    member_session_ids: members,
    ...(input.memberLabels !== undefined ? { member_labels: labels } : {}),
  };
}

export function auditReceipt(value: unknown, expectedId?: string): ConversationAuditAck {
  try {
    const item = object(value);
    const id = auditUuid(item.conversation_id);
    if (item.schema !== 'bailing.agent-conversation-audit-ack.v1' ||
        (expectedId !== undefined && id !== expectedId) ||
        !Number.isSafeInteger(item.last_sequence) || Number(item.last_sequence) < 0) throw new Error();
    return { schema: item.schema, conversation_id: id, last_sequence: Number(item.last_sequence) };
  } catch {
    throw new BailingHubClientError('BailingHub returned an invalid conversation audit acknowledgement.', undefined, true, undefined, 'accepted_unknown');
  }
}
export function auditView(value: unknown, expectedId?: string): ConversationAudit {
  try {
    const item = object(value);
    const receipt = auditReceipt({ ...item, schema: 'bailing.agent-conversation-audit-ack.v1' }, expectedId);
    if (item.schema !== 'bailing.agent-conversation-audit.v1' ||
        !['enrolling', 'ready'].includes(String(item.state)) ||
        !Number.isInteger(item.member_count) || Number(item.member_count) < 1 || Number(item.member_count) > 64 ||
        !Number.isInteger(item.confirmed_count) || Number(item.confirmed_count) < 1 ||
        Number(item.confirmed_count) > Number(item.member_count) ||
        (item.state === 'ready' && item.member_count !== item.confirmed_count)) throw new Error();
    return { ...receipt, schema: item.schema, state: item.state as ConversationAudit['state'],
      member_count: Number(item.member_count), confirmed_count: Number(item.confirmed_count) };
  } catch {
    throw new BailingHubClientError('BailingHub returned an invalid conversation audit registration.', undefined, true, undefined, 'accepted_unknown');
  }
}

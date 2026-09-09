import { BailingHubClientError } from './client.js';

/** Product positioning only; neither an instruction nor an authorization/tool grant. */
export type AgentSystemInfo = {
  schema_version: 'bailing.agent-system-info.v1';
  binding: { client_app_id: string; session_id: string; workspace: string };
  metadata_status: 'configured' | 'missing';
  revision: string | null;
  system: { name: string; summary: string; domains: string[]; boundaries: string[] } | null;
  tool_status: 'not_loaded';
  availability: 'unknown' | 'unavailable';
  unavailable_reason?: 'agent_client_disabled' | 'agent_direct_disabled';
};

function invalid(): never {
  throw new BailingHubClientError('BailingHub returned invalid system information.',
    502, false, 'system_info_invalid', 'definitive_rejection');
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}

function text(value: unknown, maximum: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum ||
      /[\u0000-\u001f\u007f]/.test(value)) return invalid();
  return value.trim();
}

function list(value: unknown, maximum: number): string[] {
  if (!Array.isArray(value) || value.length > 6) return invalid();
  return value.map((entry) => text(entry, maximum));
}

/** Explicit projection prevents credentials, instructions, and arbitrary response fields escaping. */
export function normalizeAgentSystemInfo(value: unknown, expected: {
  clientAppId: string; sessionId: string; workspace: string;
}): AgentSystemInfo {
  const input = object(value);
  if (input.schema_version !== 'bailing.agent-system-info.v1') return invalid();
  const binding = object(input.binding);
  const clientAppId = text(binding.client_app_id, 64);
  const sessionId = text(binding.session_id, 128);
  const workspace = text(binding.workspace, 64);
  if (clientAppId !== expected.clientAppId || sessionId !== expected.sessionId || workspace !== expected.workspace) {
    throw new BailingHubClientError('The system information belongs to a different Agent binding.',
      403, false, 'agent_binding_changed', 'definitive_rejection');
  }
  if ((input.metadata_status !== 'configured' && input.metadata_status !== 'missing') ||
      input.tool_status !== 'not_loaded' ||
      (input.availability !== 'unknown' && input.availability !== 'unavailable')) return invalid();
  let system: AgentSystemInfo['system'] = null;
  let revision: string | null = null;
  if (input.metadata_status === 'configured') {
    const description = object(input.system);
    revision = text(input.revision, 128);
    system = {
      name: text(description.name, 120), summary: text(description.summary, 400),
      domains: list(description.domains, 120), boundaries: list(description.boundaries, 160),
    };
  } else if (input.system !== null || input.revision !== null) return invalid();
  let reason: AgentSystemInfo['unavailable_reason'];
  if (input.availability === 'unavailable') {
    if (input.unavailable_reason !== 'agent_client_disabled' && input.unavailable_reason !== 'agent_direct_disabled') return invalid();
    reason = input.unavailable_reason;
  } else if (input.unavailable_reason !== undefined) return invalid();
  return {
    schema_version: 'bailing.agent-system-info.v1',
    binding: { client_app_id: clientAppId, session_id: sessionId, workspace },
    metadata_status: input.metadata_status, revision, system,
    tool_status: 'not_loaded', availability: input.availability,
    ...(reason ? { unavailable_reason: reason } : {}),
  };
}

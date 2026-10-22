import { BailingHubClientError } from './client.js';

export const AGENT_KNOWLEDGE_PROTOCOL = 'bailing.agent-knowledge.v1' as const;
export type AgentKnowledgeStatus = 'ok' | 'disabled' | 'unavailable' | 'partial';
export type AgentKnowledgeHint = { ref: string; title: string; summary: string; revision: string; score: number; expires_at: string };
export type AgentKnowledgeCapabilities = {
  schema_version: 'bailing.agent-knowledge-capabilities.v1'; protocol: typeof AGENT_KNOWLEDGE_PROTOCOL;
  supported: boolean; route: string; enabled?: boolean; knowledge_scope_revision?: string;
  delivery_modes?: ('inline' | 'on_demand')[]; limits?: Record<string, number>;
};
export type AgentKnowledgeDelivery = {
  schema_version: 'bailing.agent-knowledge-delivery.v1'; mode: 'on_demand'; protocol: typeof AGENT_KNOWLEDGE_PROTOCOL;
  knowledge_scope_revision: string; status: AgentKnowledgeStatus; hints: AgentKnowledgeHint[];
};
export type SearchAgentKnowledgeInput = { query: string; limit?: number; runId?: string };
export type ReadAgentKnowledgeInput = { ref: string; runId?: string; cursor?: string; maxBytes?: number };
export type AgentKnowledgeSearch = {
  schema_version: 'bailing.agent-knowledge-search.v1'; route: string; run_id?: string;
  knowledge_scope_revision: string; status: AgentKnowledgeStatus; trust: 'reference_only';
  hints: AgentKnowledgeHint[]; truncated: boolean;
};
export type AgentKnowledgeRead = {
  schema_version: 'bailing.agent-knowledge-read.v1'; route: string; run_id?: string;
  knowledge_scope_revision: string; ref: string; revision: string; title: string; content: string;
  trust: 'reference_only'; next_cursor: string | null; truncated: boolean;
  budget_exhausted?: boolean; total_content_bytes?: number; read_chain_max_bytes?: number;
};
const REVISION = /^[a-f0-9]{64}$/;
const STATUS = new Set(['ok', 'disabled', 'unavailable', 'partial']);
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const fail = (): never => { throw new BailingHubClientError('BailingHub returned invalid or mismatched knowledge data.', undefined, false, 'agent_invalid_response'); };
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : fail();
const text = (value: unknown, max: number, empty = false): string => typeof value === 'string' && (empty || Boolean(value.trim())) && !CONTROL.test(value) && Buffer.byteLength(value, 'utf8') <= max ? value : fail();
const rev = (value: unknown): string => typeof value === 'string' && REVISION.test(value) ? value : fail();
function bounded(value: unknown, max: number): Record<string, unknown> { const result = object(value); if (Buffer.byteLength(JSON.stringify(value), 'utf8') > max) fail(); return result; }
function hints(value: unknown): AgentKnowledgeHint[] {
  if (!Array.isArray(value) || value.length > 3) fail();
  return (value as unknown[]).map(raw => { const item = object(raw);
    if (typeof item.score !== 'number' || !Number.isFinite(item.score) || item.score < 0 || item.score > 1 || typeof item.expires_at !== 'string' || !Number.isFinite(Date.parse(item.expires_at))) fail();
    return { ref: text(item.ref, 4096), title: text(item.title, 2048), summary: text(item.summary, 3072, true), revision: rev(item.revision), score: item.score as number, expires_at: item.expires_at as string };
  });
}
export function normalizeKnowledgeCapabilities(value: unknown, route: string): AgentKnowledgeCapabilities {
  const body = bounded(value, 4096);
  if (body.schema_version !== 'bailing.agent-knowledge-capabilities.v1' || body.protocol !== AGENT_KNOWLEDGE_PROTOCOL || typeof body.supported !== 'boolean' || body.route !== route) fail();
  if (!body.supported) return { schema_version: 'bailing.agent-knowledge-capabilities.v1', protocol: AGENT_KNOWLEDGE_PROTOCOL, supported: false, route };
  if (typeof body.enabled !== 'boolean' || !Array.isArray(body.delivery_modes) || body.delivery_modes.length !== 2 || !body.delivery_modes.includes('inline') || !body.delivery_modes.includes('on_demand')) fail();
  const limits = object(body.limits);
  const expected = { search_max_results: 3, search_max_bytes: 4096, read_default_bytes: 16384, read_max_bytes: 32768, reference_ttl_seconds: 300, read_chain_max_bytes: 131072 };
  if (Object.entries(expected).some(([key, count]) => limits[key] !== count)) fail();
  if (Object.keys(limits).length > 20 || Object.values(limits).some(n => !Number.isSafeInteger(n) || Number(n) < 1 || Number(n) > 1048576)) fail();
  return { schema_version: 'bailing.agent-knowledge-capabilities.v1', protocol: AGENT_KNOWLEDGE_PROTOCOL, supported: true, route, enabled: body.enabled as boolean, knowledge_scope_revision: rev(body.knowledge_scope_revision), delivery_modes: ['inline', 'on_demand'], limits: limits as Record<string, number> };
}
export function normalizeKnowledgeDelivery(value: unknown): AgentKnowledgeDelivery {
  const body = bounded(value, 4096);
  if (body.schema_version !== 'bailing.agent-knowledge-delivery.v1' || body.mode !== 'on_demand' || body.protocol !== AGENT_KNOWLEDGE_PROTOCOL || !STATUS.has(String(body.status))) fail();
  return { schema_version: 'bailing.agent-knowledge-delivery.v1', mode: 'on_demand', protocol: AGENT_KNOWLEDGE_PROTOCOL, knowledge_scope_revision: rev(body.knowledge_scope_revision), status: body.status as AgentKnowledgeStatus, hints: hints(body.hints) };
}
function boundRun(body: Record<string, unknown>, route: string, runId?: string): void { if (body.route !== route || body.run_id !== runId) fail(); }
export function normalizeKnowledgeSearch(value: unknown, route: string, runId?: string): AgentKnowledgeSearch {
  const body = bounded(value, 4096); boundRun(body, route, runId);
  if (body.schema_version !== 'bailing.agent-knowledge-search.v1' || body.trust !== 'reference_only' || !STATUS.has(String(body.status)) || typeof body.truncated !== 'boolean') fail();
  return { schema_version: 'bailing.agent-knowledge-search.v1', route, ...(runId ? { run_id: runId } : {}), knowledge_scope_revision: rev(body.knowledge_scope_revision), status: body.status as AgentKnowledgeStatus, trust: 'reference_only', hints: hints(body.hints), truncated: body.truncated as boolean };
}
export function normalizeKnowledgeRead(value: unknown, route: string, input: ReadAgentKnowledgeInput): AgentKnowledgeRead {
  const body = bounded(value, input.maxBytes ?? 16384); boundRun(body, route, input.runId);
  if (body.schema_version !== 'bailing.agent-knowledge-read.v1' || body.trust !== 'reference_only' || body.ref !== input.ref || typeof body.truncated !== 'boolean' || !(body.next_cursor === null || typeof body.next_cursor === 'string') || (!body.truncated && body.next_cursor !== null) || (body.truncated && body.next_cursor === null && body.budget_exhausted !== true)) fail();
  if (body.budget_exhausted !== undefined && typeof body.budget_exhausted !== 'boolean') fail();
  if (body.read_chain_max_bytes !== undefined && body.read_chain_max_bytes !== 131072) fail();
  if (body.total_content_bytes !== undefined && (!Number.isSafeInteger(body.total_content_bytes) || Number(body.total_content_bytes) < 0)) fail();
  if (body.budget_exhausted === true && (body.truncated !== true || body.next_cursor !== null || (body.total_content_bytes !== undefined && Number(body.total_content_bytes) <= 131072))) fail();
  return { schema_version: 'bailing.agent-knowledge-read.v1', route, ...(input.runId ? { run_id: input.runId } : {}), knowledge_scope_revision: rev(body.knowledge_scope_revision), ref: input.ref, revision: rev(body.revision), title: text(body.title, 2048), content: text(body.content, 32768, true), trust: 'reference_only', next_cursor: body.next_cursor === null ? null : text(body.next_cursor, 4096), truncated: body.truncated as boolean,
    ...(body.budget_exhausted === undefined ? {} : { budget_exhausted: body.budget_exhausted as boolean }),
    ...(body.total_content_bytes === undefined ? {} : { total_content_bytes: body.total_content_bytes as number }),
    ...(body.read_chain_max_bytes === undefined ? {} : { read_chain_max_bytes: body.read_chain_max_bytes as number }) };
}

export type InvocationRateLimit = {
  level: 'tool' | 'provider'; count: number; window_sec: number;
  scope: 'tool_provider_shared'; source: 'declaration' | 'tool_override' | 'provider_default' | 'provider_total';
};
export type InvocationRateLimitFields = { retry_after_ms?: number; rate_limit?: InvocationRateLimit };

/** Additive v1 fields. Missing fields keep compatibility with older Core responses. */
export function parseInvocationRateLimit(body: Record<string, unknown>): InvocationRateLimitFields | null {
  const fields: InvocationRateLimitFields = {};
  if (body.retry_after_ms === undefined && body.rate_limit === undefined) return fields;
  if (body.state !== 'rejected_before_dispatch' || body.auto_retry_allowed !== true) return null;
  if (body.retry_after_ms !== undefined) {
    if (!Number.isSafeInteger(body.retry_after_ms) || Number(body.retry_after_ms) < 1 || Number(body.retry_after_ms) > 86_400_000) return null;
    fields.retry_after_ms = Number(body.retry_after_ms);
  }
  if (body.rate_limit !== undefined) {
    const r = body.rate_limit as Record<string, unknown>;
    if (!r || typeof r !== 'object' || Array.isArray(r) || !['tool', 'provider'].includes(String(r.level))
      || !Number.isSafeInteger(r.count) || Number(r.count) < 1 || ![1, 60, 3600, 86400].includes(Number(r.window_sec))
      || r.scope !== 'tool_provider_shared' || !['declaration', 'tool_override', 'provider_default', 'provider_total'].includes(String(r.source))) return null;
    fields.rate_limit = { level: r.level as InvocationRateLimit['level'], count: Number(r.count), window_sec: Number(r.window_sec), scope: r.scope, source: r.source as InvocationRateLimit['source'] };
  }
  return fields;
}

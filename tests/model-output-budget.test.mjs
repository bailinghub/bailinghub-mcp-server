import assert from 'node:assert/strict';
import test from 'node:test';
import { BailingHubUsageClient, resolveModelOutputBudget, modelOutputOptions } from '../dist/usage.js';

const descriptor = (changes = {}) => ({
  schema: 'bailing.usage-model.v1', service_id: 'service', service_revision: 1, label: 'Synthetic model', model: 'synthetic',
  state: 'active', orchestration: 'host', streaming: true, input_formats: ['text', 'image_url'], model_modalities: ['text'],
  context_window_tokens: 1000000, max_input_bytes: 8388608, input_limit_scope: 'serialized_provider_request', max_messages: 1024,
  max_tools: 128, max_output_tokens: 65536, timeout_ms: 120000, provider_options: ['max_tokens', 'max_completion_tokens'], ...changes,
});
const explicit = (changes = {}) => descriptor({ default_output_tokens: 16384, output_token_parameter: 'max_completion_tokens',
  output_budget_scope: 'completion_total', model_max_output_tokens: 131072, provider_options: ['max_completion_tokens', 'temperature'], ...changes });
const directory = (item) => ({ schema: 'bailing.model-models.v1', user_id: 'user', account_id: 'account', selection: 'plan',
  plan_id: 'plan', plan_revision: 1, default_service_id: 'service', items: [item] });
const client = value => new BailingHubUsageClient({ hubUrl: 'https://hub.example.invalid', userId: 'user', accountId: 'account', serviceId: 'service',
  accessTokenProvider: () => `bhu_s_${'x'.repeat(32)}`, fetchImpl: async () => new Response(JSON.stringify(value)) });

test('explicit directory distinguishes default, service ceiling and verified supplier limit', async () => {
  const item = explicit();
  assert.deepEqual((await client(directory(item)).modelModels()).items[0], item);
  assert.deepEqual(resolveModelOutputBudget(item), { mode: 'explicit', defaultTokens: 16384, maxTokens: 65536,
    parameter: 'max_completion_tokens', scope: 'completion_total', modelMaxTokens: 131072 });
  assert.deepEqual(modelOutputOptions(item), { max_completion_tokens: 16384 });
  assert.deepEqual(modelOutputOptions(item, { tokens: 65536 }), { max_completion_tokens: 65536 });
  assert.deepEqual(modelOutputOptions(item, { tokens: 1024 }), { max_completion_tokens: 1024 });
});

test('legacy metadata retains old ceiling fallback without inventing parameter scope or supplier maximum', async () => {
  const item = descriptor({ max_output_tokens: 8192 });
  assert.deepEqual((await client(directory(item)).modelModels()).items[0], item);
  assert.deepEqual(resolveModelOutputBudget(item), { mode: 'legacy', defaultTokens: 8192, maxTokens: 8192,
    parameter: null, scope: null, modelMaxTokens: null });
  assert.deepEqual(modelOutputOptions(item), { max_tokens: 8192 });
  assert.deepEqual(modelOutputOptions(item, { tokens: 2048, parameter: 'max_completion_tokens' }), { max_completion_tokens: 2048 });
});

test('explicit service can declare max_tokens as total or final without guessing from model name', async () => {
  for (const scope of ['completion_total', 'final_answer']) {
    const item = explicit({ model: 'not-a-known-provider-name', output_token_parameter: 'max_tokens', output_budget_scope: scope,
      provider_options: ['max_tokens'], model_max_output_tokens: undefined });
    assert.equal(resolveModelOutputBudget(item).scope, scope);
    assert.equal(resolveModelOutputBudget(item).modelMaxTokens, null);
    assert.deepEqual(modelOutputOptions(item), { max_tokens: 16384 });
    await client(directory(item)).modelModels();
  }
});

test('partial, null, invalid and inconsistent directory policies are rejected instead of falling back', async () => {
  const cases = [
    descriptor({ default_output_tokens: 1024 }), descriptor({ output_token_parameter: 'max_tokens' }),
    descriptor({ output_budget_scope: 'completion_total' }), descriptor({ model_max_output_tokens: 131072 }),
    explicit({ default_output_tokens: null }), explicit({ output_token_parameter: null }), explicit({ output_budget_scope: null }),
    explicit({ default_output_tokens: 0 }), explicit({ default_output_tokens: 1.5 }), explicit({ default_output_tokens: '16384' }),
    explicit({ default_output_tokens: 65537 }), explicit({ output_token_parameter: 'max_new_tokens' }),
    explicit({ output_budget_scope: 'model_defined' }), explicit({ output_budget_scope: 'final_answer' }),
    explicit({ model_max_output_tokens: null }), explicit({ model_max_output_tokens: 0 }), explicit({ model_max_output_tokens: 65535 }),
    explicit({ model_max_output_tokens: 131072.5 }), explicit({ provider_options: [] }),
    explicit({ provider_options: ['max_tokens', 'max_completion_tokens'] }),
  ];
  for (const item of cases) {
    assert.throws(() => resolveModelOutputBudget(item), { code: 'USAGE_RESPONSE_INVALID', dispatch: 'not_dispatched' });
    await assert.rejects(client(directory(item)).modelModels(), { code: 'USAGE_RESPONSE_INVALID', dispatch: 'not_dispatched' });
  }
});

test('SDK helpers return safe parameter/scope or byte-free limit diagnostics and never silently clamp', () => {
  const item = explicit();
  assert.throws(() => modelOutputOptions(item, { parameter: 'max_tokens' }), error => {
    assert.equal(error.code, 'USAGE_OUTPUT_PARAMETER_MISMATCH');
    assert.deepEqual(error.feedback.output_budget, { expected_parameter: 'max_completion_tokens', scope: 'completion_total' });
    return error.dispatch === 'not_dispatched';
  });
  assert.throws(() => modelOutputOptions(item, { tokens: 65537 }), error => {
    assert.equal(error.code, 'USAGE_OUTPUT_LIMIT');
    assert.deepEqual(error.feedback.output_limit, { actual: 65537, allowed: 65536, parameter: 'max_completion_tokens', scope: 'completion_total' });
    return error.dispatch === 'not_dispatched';
  });
  for (const tokens of [null, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '1024']) assert.throws(() => modelOutputOptions(item, { tokens }), TypeError);
  for (const options of [null, [], { parameter: null }, { max_tokens: 10 }, { tokens: 10, private_body: 'not copied' }]) {
    assert.throws(() => modelOutputOptions(item, options), TypeError);
  }
});

test('helper only builds fresh options and never mutates an original intent or the descriptor', () => {
  const item = Object.freeze(explicit());
  const oldIntent = Object.freeze({ operation_id: 'original', provider_options: Object.freeze({ max_tokens: 8192 }) });
  const before = JSON.stringify(oldIntent);
  const next = modelOutputOptions(item);
  assert.deepEqual(next, { max_completion_tokens: 16384 });
  assert.equal(JSON.stringify(oldIntent), before);
  assert.equal(item.default_output_tokens, 16384);
  assert.equal(item.max_output_tokens, 65536);
});

const caps = { schema: 'bailing.usage.v1', supported: true, modes: ['credits'], streaming: true, orchestration: 'host',
  model_gateway: { schema: 'bailing.model-gateway.v1', supported: true, streaming: true, orchestration: 'host', turn_required: false,
    billing_unit: 'USD', provider_response: 'bailing.provider-response.v1', settlement: 'asynchronous',
    requests_path: '/usage/v1/model/requests', models_path: '/usage/v1/model/models', summary_path: '/usage/v1/model/summary' } };
test('output-budget capability is optional for old gateways and validated when present', async () => {
  await client(caps).capabilities();
  const output_budget = { schema: 'bailing.model-output-budget.v1', separate_default: true, explicit_parameter: true, explicit_scope: true };
  assert.deepEqual((await client({ ...caps, model_gateway: { ...caps.model_gateway, output_budget } }).capabilities()).model_gateway.output_budget, output_budget);
  for (const bad of [null, { ...output_budget, schema: 'other' }, { ...output_budget, separate_default: false }, { explicit_parameter: true }]) {
    await assert.rejects(client({ ...caps, model_gateway: { ...caps.model_gateway, output_budget: bad } }).capabilities(), { code: 'USAGE_RESPONSE_INVALID' });
  }
});

test('server budget feedback keeps only valid non-sensitive scalar fields', async () => {
  const input = { operation_id: 'original', messages: [{ role: 'user', content: 'Synthetic' }] };
  for (const [code, status, feedback] of [
    ['USAGE_OUTPUT_PARAMETER_MISMATCH', 400, { output_budget: { expected_parameter: 'max_completion_tokens', scope: 'completion_total', private_text: 'never-copy' } }],
    ['USAGE_OUTPUT_LIMIT', 413, { output_limit: { actual: 65537, allowed: 65536, parameter: 'max_completion_tokens', scope: 'completion_total', prompt: 'never-copy' } }],
    ['USAGE_OUTPUT_LIMIT', 413, { output_limit: { actual: 8193, allowed: 8192, parameter: 'max_tokens', secret: 'never-copy' } }],
  ]) {
    const sdk = new BailingHubUsageClient({ hubUrl: 'https://hub.example.invalid', userId: 'user', accountId: 'account', serviceId: 'service',
      accessTokenProvider: () => `bhu_s_${'x'.repeat(32)}`, fetchImpl: async () => new Response(JSON.stringify({ error: code,
        feedback: { code, dispatch: 'not_dispatched', next_action: 'resolve_error', retryable: false, ...feedback } }), { status }) });
    await assert.rejects(sdk.modelComplete(input), error => {
      assert.equal(error.code, code); assert.equal(error.dispatch, 'not_dispatched');
      assert.ok(!JSON.stringify(error.feedback).includes('never-copy'));
      if (feedback.output_budget) assert.deepEqual(error.feedback.output_budget, { expected_parameter: 'max_completion_tokens', scope: 'completion_total' });
      else assert.equal(error.feedback.output_limit.allowed, feedback.output_limit.allowed);
      return true;
    });
  }
});

test('invalid budget feedback is omitted and original uncertainty remains intact', async () => {
  const sdk = new BailingHubUsageClient({ hubUrl: 'https://hub.example.invalid', userId: 'user', accountId: 'account', serviceId: 'service',
    accessTokenProvider: () => `bhu_s_${'x'.repeat(32)}`, fetchImpl: async () => new Response(JSON.stringify({ error: 'USAGE_OUTPUT_LIMIT',
      feedback: { code: 'USAGE_OUTPUT_LIMIT', dispatch: 'unknown', next_action: 'retry_original', output_budget: { expected_parameter: 'api_key', scope: 'other' },
        output_limit: { actual: -1, allowed: '65536', parameter: 'max_tokens', scope: 'other' } } }), { status: 503 }) });
  await assert.rejects(sdk.inspectModelRequest('original', { serviceId: 'service' }), error => {
    assert.equal(error.dispatch, 'unknown'); assert.equal(error.operationId, 'original');
    assert.equal(error.feedback.next_action, 'inspect_original');
    assert.equal(error.feedback.output_limit, undefined); assert.equal(error.feedback.output_budget, undefined);
    return true;
  });
});

test('feedback never labels max_completion_tokens as an answer-only amount', async () => {
  const sdk = new BailingHubUsageClient({ hubUrl: 'https://hub.example.invalid', userId: 'user', accountId: 'account', serviceId: 'service',
    accessTokenProvider: () => `bhu_s_${'x'.repeat(32)}`, fetchImpl: async () => new Response(JSON.stringify({ error: 'USAGE_OUTPUT_PARAMETER_MISMATCH',
      feedback: { code: 'USAGE_OUTPUT_PARAMETER_MISMATCH', dispatch: 'not_dispatched', next_action: 'resolve_error',
        output_budget: { expected_parameter: 'max_completion_tokens', scope: 'final_answer' },
        output_limit: { actual: 65537, allowed: 65536, parameter: 'max_completion_tokens', scope: 'final_answer' } } }), { status: 400 }) });
  await assert.rejects(sdk.modelComplete({ operation_id: 'original', messages: [{ role: 'user', content: 'Synthetic' }] }), error => {
    assert.equal(error.feedback.output_budget, undefined); assert.equal(error.feedback.output_limit, undefined);
    return error.dispatch === 'not_dispatched';
  });
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { BailingHubUsageClient, MODEL_GATEWAY_PATHS } from '../dist/usage.js';
const binding = { hubUrl: 'https://hub.example.com', userId: 'user', accountId: 'account', serviceId: 'base' };
const sdk = fetchImpl => new BailingHubUsageClient({ ...binding, accessTokenProvider: () => `bhu_s_${'x'.repeat(32)}`, fetchImpl });
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
const input = { operation_id: 'original', conversation_id: 'session', turn_id: 'message', service_id: 'second', messages: [{ role: 'user', content: 'Synthetic only' }] };
const operation = { schema: 'bailing.model-operation.v1', operation_id: 'original', account_id: 'account', user_id: 'user', service_id: 'second', conversation_id: 'session', turn_id: 'message', state: 'completed', result_state: 'complete', billing_state: 'pending', dispatch: 'completed', next_action: 'none', revision: 2, billing_rate: { planId: 'plan', planRevision: 1, multiplier: 1, price: {currency: 'USD'} }, reference_cost_usd: null, billed_usd: null, overage_usd: null, response: { choices: [{ message: { role: 'assistant', content: 'Done' }, finish_reason: 'stop' }] } };
const descriptor = id => ({ schema: 'bailing.usage-model.v1', service_id: id, service_revision: 1, label: `Synthetic ${id}`, model: 'synthetic', state: 'active', orchestration: 'host', streaming: true, input_formats: ['openai-chat'], model_modalities: ['text'], context_window_tokens: 128000, max_input_bytes: 4194304, input_limit_scope: 'serialized_provider_request', max_messages: 4096, max_tools: 256, max_output_tokens: 8192, timeout_ms: 120000, provider_options: [] });
const summary = { schema: 'bailing.billing-summary.v1', accountId: 'account', user_id: 'user', service_id: 'base', grant: null, plan: null, availableUsd: 0, consumedUsd: 0, currentPeriodConsumedUsd: 0, overageUsd: 0, resetAt: null, expiresAt: null, pendingRequests: 0, presentation: { schema: 'bailing.usage-presentation.v1', kind: 'none', state: 'unavailable', remaining: null, total: null, displayValue: null } };
const frame = (seq, type, data = {}) => `data: ${JSON.stringify({ schema: 'bailing.model-stream.v1', operation_id: 'original', seq, type, ...data })}\n\n`;
const stream = text => new Response(text, { headers: { 'content-type': 'text/event-stream' } });

test('Model metadata validates account/user binding and distinct permitted model descriptors', async () => {
  const client = sdk(async url => json(url.endsWith('/models') ? { schema: 'bailing.model-models.v1', account_id: 'account', user_id: 'user', selection: 'plan', plan_id: 'plan', plan_revision: 1, default_service_id: 'base', items: [descriptor('base'), descriptor('second')] } : summary));
  assert.equal((await client.modelModels()).items.length, 2);
  assert.equal((await client.modelSummary()).grant, null);
  await assert.rejects(sdk(async () => json({ ...summary, user_id: 'other' })).modelSummary(), { code: 'USAGE_BINDING_MISMATCH' });
  await assert.rejects(sdk(async () => json({ ...summary, availableUsd: -1 })).modelSummary(), { code: 'USAGE_RESPONSE_INVALID' });
});

test('Model requests have no turn admission and result completion does not depend on billing completion', async () => {
  const calls = [];
  const client = sdk(async (url, init) => { calls.push({ url, method: init.method }); assert.equal(url, binding.hubUrl + MODEL_GATEWAY_PATHS.requests); assert.deepEqual(JSON.parse(init.body), input); return json(operation); });
  const result = await client.modelComplete(input);
  assert.equal(result.result_state, 'complete'); assert.equal(result.billing_state, 'pending');
  assert.equal(calls.length, 1);
  await assert.rejects(client.modelComplete({ ...input, account_id: 'other' }), TypeError);
  assert.equal(calls.length, 1);
});

test('no SDK-only message or tool count cap on Model gateway inputs', async () => {
  const client = sdk(async () => json(operation));
  await client.modelComplete({ ...input, messages: Array.from({ length: 1300 }, () => ({ role: 'user', content: 'synthetic' })), tools: Array.from({ length: 150 }, () => ({ type: 'function' })) });
});

test('operation binding and usage integrity failures remain uncertain, not retryable as new dispatch', async () => {
  for (const override of [{ account_id: 'other' }, { user_id: 'other' }, { service_id: 'base' }, { turn_id: 'other' }, { conversation_id: 'other' }, { revision: -1 }, { usage: { inputTokens: 1, outputTokens: 2, totalTokens: 99 } }, { response: undefined }]) {
    await assert.rejects(sdk(async () => json({ ...operation, ...override })).modelComplete(input), { code: 'USAGE_RESPONSE_INVALID', dispatch: 'unknown', operationId: 'original' });
  }
});

test('stream is incremental, strictly sequenced and accepts complete result with pending usage', async () => {
  const client = sdk(async (_url, init) => { assert.equal(new Headers(init.headers).get('accept'), 'text/event-stream'); return stream(frame(1, 'started') + frame(2, 'delta', { delta: { content: 'Done' } }) + frame(3, 'operation', { operation })); });
  const events = []; for await (const event of client.modelStream(input)) events.push(event);
  assert.equal(events.length, 3); assert.equal(events[2].operation.billing_state, 'pending');
  for (const bad of [frame(1, 'started'), frame(1, 'started') + frame(3, 'delta', { delta: {} }), frame(1, 'operation', { operation: { ...operation, service_id: 'wrong' } })]) {
    await assert.rejects(async () => { for await (const _event of sdk(async () => stream(bad)).modelStream(input)) {} }, { code: 'USAGE_STREAM_INCOMPLETE', dispatch: 'unknown' });
  }
});

test('ACK loss only recovers original request and cancellation does not replay provider operation', async () => {
  const calls = [];
  const client = sdk(async (url, init) => { calls.push({ url, method: init.method }); if (url.endsWith('/requests')) throw new Error('synthetic offline'); return json(operation); });
  await assert.rejects(client.modelComplete(input), { dispatch: 'unknown', operationId: 'original' });
  const options = { serviceId: 'second', conversationId: 'session', turnId: 'message' };
  assert.equal((await client.inspectModelRequest('original', options)).result_state, 'complete');
  await client.cancelModelRequest('original', options);
  assert.deepEqual(calls.map(x => x.method), ['POST', 'GET', 'POST']);
  assert.ok(calls[2].url.endsWith('/original/cancel'));
  await assert.rejects(sdk(async () => { throw new Error('offline'); }).cancelModelRequest('original', options), { dispatch: 'unknown' });
});

test('expired, quota, upgrade and unsupported errors are stable without silent fallback', async () => {
  for (const [code, next_action, status] of [['QUOTA_WINDOW_EXHAUSTED', 'wait_for_reset', 429], ['ALLOWANCE_INSUFFICIENT', 'contact_operator', 409], ['USAGE_UNSUPPORTED', 'upgrade_required', 409], ['USAGE_CREDENTIAL_INVALID', 'reauthenticate', 401]]) {
    let count = 0;
    await assert.rejects(sdk(async () => { count++; return json({ error: code, feedback: { code, dispatch: 'not_dispatched', next_action, retryable: false, resetAt: 123456 } }, status); }).modelComplete(input), error => error.code === code && error.feedback.next_action === next_action && error.resetAt === 123456);
    assert.equal(count, 1);
  }
  await assert.rejects(sdk(async () => new Response('old', { status: 404 })).modelSummary(), { code: 'USAGE_UNSUPPORTED' });
});

test('explicit expired-result tombstone is accepted without inventing a response', async () => {
  const receipt = await sdk(async () => json({ ...operation, response: undefined, response_expired: true })).modelComplete(input);
  assert.equal(receipt.response, undefined); assert.equal(receipt.response_expired, true);
});

test('omitted audit coordinates must remain null and oversized coordinates are rejected before HTTP', async () => {
  const client = sdk(async () => json({ ...operation, service_id: 'base' }));
  await assert.rejects(client.modelComplete({ operation_id: 'original', messages: input.messages }), { code: 'USAGE_RESPONSE_INVALID' });
  await assert.rejects(client.modelComplete({ ...input, conversation_id: 'a'.repeat(192) }), TypeError);
});

const caps = { schema: 'bailing.usage.v1', supported: true, modes: ['credits', 'periodic'], streaming: true, orchestration: 'host',
  model_gateway: { schema: 'bailing.model-gateway.v1', supported: true, orchestration: 'host', streaming: true,
    requests_path: MODEL_GATEWAY_PATHS.requests, models_path: MODEL_GATEWAY_PATHS.models, summary_path: MODEL_GATEWAY_PATHS.summary, billing_unit: 'USD', turn_required: false, provider_response:'bailing.provider-response.v1',settlement:'asynchronous' } };
test('Model-only capability contract requires streaming and host orchestration', async () => {
  assert.deepEqual(await sdk(async () => json(caps)).capabilities(), caps);
  for (const value of [{ ...caps, streaming: false }, { ...caps, orchestration: 'server' }, { ...caps, model_gateway: { ...caps.model_gateway, turn_required: true } }]) {
    await assert.rejects(sdk(async () => json(value)).capabilities(), { code: 'USAGE_UNSUPPORTED' });
  }
});

test('only USD model request APIs are exposed by the model billing client', () => {
  const client = sdk(async () => json({}));
  for (const removed of ['tokenModels', 'tokenSummary', 'tokenComplete', 'tokenStream', 'inspectTokenRequest', 'cancelTokenRequest', 'summary', 'ledger', 'beginTurn', 'complete', 'stream', 'inspectOperation', 'endTurn', 'cancelTurn', 'model']) assert.equal(client[removed], undefined);
  for (const present of ['modelModels', 'modelSummary', 'modelComplete', 'modelStream', 'inspectModelRequest', 'cancelModelRequest']) assert.equal(typeof client[present], 'function');
});

test('wrong credential type, unavailable secure storage and cancelled preflight send zero requests', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return json(operation) };
  for (const token of ['business-credential', `bhu_i_${'x'.repeat(32)}`, '']) {
    const client = new BailingHubUsageClient({ ...binding, fetchImpl, accessTokenProvider: () => token });
    await assert.rejects(client.modelComplete(input), { code: 'USAGE_CREDENTIAL_INVALID', dispatch: 'not_dispatched' });
  }
  const failed = new BailingHubUsageClient({ ...binding, fetchImpl, accessTokenProvider: () => { throw Error('private storage path') } });
  await assert.rejects(failed.modelComplete(input), error => error.code === 'USAGE_CREDENTIAL_UNAVAILABLE' && !error.message.includes('private'));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(sdk(fetchImpl).modelComplete(input, { signal: controller.signal }), { code: 'USAGE_CANCELLED', dispatch: 'not_dispatched' });
  assert.equal(calls, 0);
});

test('failed original reads preserve uncertainty and never suggest new model dispatch', async () => {
  for (const response of [async () => { throw Error('offline') }, async () => new Response('bad', { status: 503 }), async () => json({ code: 'USAGE_OPERATION_NOT_FOUND' }, 404)]) {
    let calls = 0;
    await assert.rejects(sdk(async (_url, options) => { calls++; assert.equal(options.method, 'GET'); return response() }).inspectModelRequest('original', { serviceId: 'second' }), error => error.dispatch === 'unknown' && ['inspect_original', 'contact_operator'].includes(error.feedback.next_action));
    assert.equal(calls, 1);
  }
});

test('serialized input feedback remains measurable and does not leak additional server fields', async () => {
  const input_limit = { kind: 'serialized_provider_bytes', actual: 1000, allowed: 500, message_count: 2, tool_count: 4 };
  await assert.rejects(sdk(async () => json({ error: 'USAGE_INPUT_LIMIT', feedback: { code: 'USAGE_INPUT_LIMIT', dispatch: 'not_dispatched', next_action: 'resolve_error', retryable: false, input_limit: { ...input_limit, unknown_field: 'omit' } } }, 413)).modelComplete(input), error => {
    assert.deepEqual(error.feedback.input_limit, input_limit); return true;
  });
});

const grant = (mode = 'credits') => ({ id: 'grant', accountId: 'account', planId: 'plan', planRevision: 1, label: 'Synthetic plan', revision: 1, state: 'active', sourceOwner: 'operator', startsAt: 1, expiresAt: null,
  config: { mode, priceUsd: 100, ...(mode === 'periodic' ? {periodAllowanceUsd:20,periodUnit:'week',duration:{unit:'month',count:1}} : {duration:{unit:'forever',count:1}}) } });
function projected(mode, availableUsd = 99, displayValue = '99', state = availableUsd > 0 ? 'active' : 'depleted') {
  return { ...summary, grant: grant(mode), plan: { id: 'plan', label: 'Synthetic plan', revision: 1, serviceIds: ['base'], multiplier: 1.5 }, availableUsd,
    presentation: { schema: 'bailing.usage-presentation.v1', kind: mode === 'credits' ? 'credits' : 'percentage', state,
      remaining: availableUsd, total: 100, displayValue } };
}
test('USD summary validates explicit allowance and authoritative display, never derives it from provider tokens', async () => {
  const value = projected('periodic', 99.5, '99');
  assert.deepEqual(await sdk(async () => json(value)).modelSummary(), value);
  for (const availableUsd of [-1, 0.0000000000001, '1']) await assert.rejects(sdk(async () => json({...value, availableUsd})).modelSummary(), {code:'USAGE_RESPONSE_INVALID'});
  for (const presentation of [undefined, {...value.presentation, kind:'tokens'}, {...value.presentation, remaining: 101}, {...value.presentation, displayValue:'99 Tokens'}]) {
    await assert.rejects(sdk(async () => json({...value,presentation})).modelSummary(), {code:'USAGE_RESPONSE_INVALID'});
  }
});

const catalog = (ids, revision = 1) => ({ schema: 'bailing.model-models.v1', account_id: 'account', user_id: 'user',
  selection: 'plan', plan_id: 'plan', plan_revision: revision, default_service_id: ids[0] ?? null, items: ids.map(descriptor) });
test('live model catalogs retain labels, allow changed defaults and accept a normal empty selection', async () => {
  let value = catalog(['base']), calls = 0;
  const client = sdk(async () => { calls++; return json(value); });
  assert.equal((await client.modelModels()).items[0].label, 'Synthetic base');
  value = catalog(['second'], 2);
  const changed = await client.modelModels();
  assert.equal(changed.default_service_id, 'second'); assert.equal(changed.items[0].label, 'Synthetic second');
  assert.equal(client.binding.serviceId, 'base');
  value = catalog([], 3);
  assert.deepEqual(await client.modelModels(), value);
  value = { ...catalog([]), plan_id: null, plan_revision: null };
  assert.deepEqual(await client.modelModels(), value); assert.equal(calls, 4);
});
test('model catalog rejects missing plan metadata, missing labels, duplicate models and defaults outside its items', async () => {
  for (const value of [
    { ...catalog(['base']), selection: undefined }, { ...catalog(['base']), plan_revision: 0 },
    { ...catalog(['base']), plan_id: null, plan_revision: null }, { ...catalog(['base']), default_service_id: 'other' },
    { ...catalog([]), default_service_id: 'base' }, { ...catalog(['base']), items: [{ ...descriptor('base'), label: undefined }] },
    { ...catalog(['base']), items: [descriptor('base'), descriptor('base')] },
  ]) await assert.rejects(sdk(async () => json(value)).modelModels(), { code: 'USAGE_RESPONSE_INVALID' });
  await assert.rejects(sdk(async () => json({ ...catalog(['base']), account_id: 'other' })).modelModels(), { code: 'USAGE_BINDING_MISMATCH' });
});
test('summary separates frozen allowance from current plan membership, including an empty model plan', async () => {
  const original = projected('credits', 1150, '1.15');
  for (const plan of [{ ...original.plan, revision: 2, serviceIds: ['second'] }, { ...original.plan, revision: 3, serviceIds: [] }, null]) {
    const value = { ...original, plan };
    const result = await sdk(async () => json(value)).modelSummary();
    assert.deepEqual(result.plan, plan); assert.deepEqual(result.grant, original.grant); assert.equal(result.availableUsd, 1150);
  }
  for (const value of [{ ...original, plan: undefined }, { ...original, plan: { ...original.plan, id: 'wrong' } },
    { ...original, grant: { ...original.grant, config: { ...original.grant.config, serviceIds: ['base'] } } }]) {
    await assert.rejects(sdk(async () => json(value)).modelSummary(), { code: 'USAGE_RESPONSE_INVALID' });
  }
});
test('removed model instructs new selection only before dispatch; original recovery never switches model', async () => {
  const client = sdk(async () => json({ error: 'SERVICE_NOT_ENTITLED', feedback: { code: 'SERVICE_NOT_ENTITLED', dispatch: 'not_dispatched', next_action: 'select_model', retryable: false } }, 403));
  await assert.rejects(client.modelComplete(input), error => error.code === 'SERVICE_NOT_ENTITLED' && error.feedback.next_action === 'select_model');
  await assert.rejects(client.inspectModelRequest('original', { serviceId: 'second' }), error => error.dispatch === 'unknown' && error.feedback.next_action === 'inspect_original');
});


test('a missing allowance is not mislabeled as a removable model selection', async () => {
  const client = sdk(async () => json({ error: 'SERVICE_NOT_ENTITLED', feedback: { code: 'SERVICE_NOT_ENTITLED', dispatch: 'not_dispatched', next_action: 'contact_operator', retryable: false } }, 403));
  await assert.rejects(client.modelComplete(input), error => error.feedback.next_action === 'contact_operator');
  const absent = sdk(async () => json({ error: 'SERVICE_NOT_ENTITLED' }, 403));
  await assert.rejects(absent.modelComplete(input), error => error.feedback.next_action !== 'select_model');
});


test('one plan multiplier is retained in catalogs and admission snapshots with raw Token counts', async () => {
  const models = catalog(['base']); models.items[0].billing_rate = { multiplier: 1.5 };
  assert.deepEqual((await sdk(async () => json(models)).modelModels()).items[0].billing_rate, {multiplier:1.5});
  const receipt = { ...operation, billed_usd: 0.3, reference_cost_usd: 0.2, overage_usd: 0, billing_state:'settled',
    billing_rate:{planId:'plan',planRevision:1,multiplier:1.5,price:{currency:'USD'}}, usage:{inputTokens:20,outputTokens:5,totalTokens:25}};
  assert.deepEqual(await sdk(async () => json(receipt)).inspectModelRequest('original',{serviceId:'second'}), receipt);
  for (const change of [{billing_rate:{...receipt.billing_rate,multiplier:0}},{billing_rate:{...receipt.billing_rate,price:null}},{billed_usd:-1},{reference_cost_usd:'1'}]) {
    await assert.rejects(sdk(async () => json({...receipt,...change})).modelComplete(input),{code:'USAGE_RESPONSE_INVALID',dispatch:'unknown'});
  }
});

test('native provider packets and saved envelopes preserve content without semantic reconstruction', async () => {
  const provider = { schema: 'bailing.provider-response.v1', format: 'sse', status: 200, content_type: 'text/event-stream' };
  const body = 'data: {"choices":[{"delta":{"tool_calls":null},"finish_reason":"provider_extension"}],"extra":true}\r\n\r\ndata: [DONE]\r\n\r\n';
  const saved = { ...operation, response: { ...provider, body } };
  const client = sdk(async () => stream(frame(1, 'started') + frame(2, 'provider', { provider: { ...provider, data: body } }) + frame(3, 'operation', { operation: saved })));
  const events = []; for await (const event of client.modelStream(input)) events.push(event);
  assert.equal(events[1].provider.data, body); assert.deepEqual(events[2].operation.response, saved.response);
  assert.deepEqual((await sdk(async () => json(saved)).inspectModelRequest('original', { serviceId: 'second' })).response, saved.response);
  for (const status of [400, 429, 503]) {
    const result = await sdk(async () => json({ ...saved, response: { ...provider, format: 'json', content_type: 'application/json', status, body: '{"error":"synthetic"}' } })).modelComplete(input);
    assert.equal(result.result_state, 'complete'); assert.equal(result.response.status, status);
  }
  for (const providerBad of [{ ...provider, format: 'unknown', data: body }, { ...provider, status: 0, data: body }, { ...provider, data: 1 }]) {
    await assert.rejects(async () => { for await (const event of sdk(async () => stream(frame(1, 'started') + frame(2, 'provider', { provider: providerBad }))).modelStream(input)) {} }, { code: 'USAGE_STREAM_INCOMPLETE' });
  }
});

test('envelope escaping does not accidentally shrink the existing provider body capacity', async () => {
  const body = '\\'.repeat(2_200_000);
  const saved = { ...operation, response: { schema: 'bailing.provider-response.v1', format: 'json', status: 200, content_type: 'application/json', body } };
  assert.equal((await sdk(async () => json(saved)).modelComplete(input)).response.body.length, body.length);
});

const toolDescriptor = {schema:'bailing.model-tool.v1',service_id:'image',service_revision:1,label:'Image',capability:'image',outputs:['image'],callable:true,state:'ready',reason:null,orchestration:'host',billing_unit:'USD',billing_scope:'shared_plan',billing_rate:{multiplier:1.5},tool:{name:'create_image',description:'Generate an image.',input_schema:{type:'object',properties:{prompt:{type:'string'}},required:['prompt']}}};
test('model tool catalog is account-bound, separate from chat selection and contains executable schema',async()=>{
  const directory={schema:'bailing.model-tools.v1',account_id:'account',user_id:'user',items:[toolDescriptor]};
  assert.deepEqual(await sdk(async()=>json(directory)).modelTools(),directory);
  await assert.rejects(sdk(async()=>json({...directory,account_id:'other'})).modelTools(),{code:'USAGE_BINDING_MISMATCH'});
  await assert.rejects(sdk(async()=>json({...directory,items:[toolDescriptor,toolDescriptor]})).modelTools(),{code:'USAGE_RESPONSE_INVALID'});
});
test('image request uncertainty retains original ID and nullable Token usage does not invent tokens',async()=>{
  const request={operation_id:'original',service_id:'image',arguments:{prompt:'synthetic'},conversation_id:'session',turn_id:'message'};
  const receipt={...operation,service_id:'image',usage:null,raw_usage:{output_image_count:1},response:{schema:'bailing.model-tool-result.v1',outputs:[{type:'image',url:'https://assets.example.com/image.png'}]}};
  const calls=[];
  const client=sdk(async(url,init)=>{calls.push({url,method:init.method});if(init.method==='POST')throw Error('lost ACK');return json(receipt)});
  await assert.rejects(client.runModelTool(request),{dispatch:'unknown',operationId:'original'});
  const recovered=await client.inspectModelRequest('original',{serviceId:'image',conversationId:'session',turnId:'message'});
  assert.equal(recovered.usage,null);assert.equal(recovered.raw_usage.output_image_count,1);
  assert.equal(calls[0].url,binding.hubUrl+MODEL_GATEWAY_PATHS.toolRequests);assert.deepEqual(calls.map(c=>c.method),['POST','GET']);
});


test('model-tool adapter failure keeps its stable code without authorizing a replacement generation',async()=>{
 const client=sdk(async()=>json({code:'MODEL_TOOL_ADAPTER_NOT_READY',feedback:{code:'MODEL_TOOL_ADAPTER_NOT_READY',dispatch:'not_dispatched',next_action:'resolve_error',retryable:false}},400));
 await assert.rejects(client.runModelTool({operation_id:'original',service_id:'image',arguments:{prompt:'synthetic'}}),{code:'MODEL_TOOL_ADAPTER_NOT_READY',dispatch:'not_dispatched'});
});

test('failed operation carries bounded diagnostics without becoming unknown or repeating POST',async()=>{
 let calls=0;const failed={...operation,state:'failed',result_state:'failed',billing_state:'settled',dispatch:'rejected',next_action:'contact_operator',response:undefined,billed_usd:0,reference_cost_usd:0,overage_usd:0,error:{code:'USAGE_PROVIDER_REJECTED',message:'Provider rejected request.',http_status:404,provider_code:'NotFound',provider_request_id:'synthetic-id',retryable:false,next_action:'contact_operator'}};
 const client=sdk(async()=>{calls++;return json(failed);});
 assert.equal((await client.modelComplete(input)).result_state,'failed');assert.equal(calls,1);
 const opts={serviceId:'second',conversationId:'session',turnId:'message'};
 assert.equal((await client.inspectModelRequest('original',opts)).error.http_status,404);
 for(const error of [{...failed.error,raw_body:'private'}, {...failed.error,retryable:true}, {...failed.error,http_status:999}]) await assert.rejects(sdk(async()=>json({...failed,error})).modelComplete(input),{code:'USAGE_RESPONSE_INVALID'});
 await assert.rejects(sdk(async()=>json({...failed,dispatch:'unknown'})).modelComplete(input),{code:'USAGE_RESPONSE_INVALID'});
});

test('period allowance is explicit and independent from sale price', async () => {
  const value = projected('periodic', 20, '100');
  assert.equal((await sdk(async () => json(value)).modelSummary()).grant.config.periodAllowanceUsd,20);
  for (const amount of [undefined, null, 0, -1, '20']) {
    const invalid = structuredClone(value);
    invalid.grant.config.periodAllowanceUsd = amount;
    await assert.rejects(sdk(async () => json(invalid)).modelSummary(), {code:'USAGE_RESPONSE_INVALID'});
  }
  const invalid = projected('credits'); invalid.grant.config.periodAllowanceUsd = 20;
  await assert.rejects(sdk(async () => json(invalid)).modelSummary(), {code:'USAGE_RESPONSE_INVALID'});
});

import assert from 'node:assert/strict';
import test from 'node:test';
import {BailingHubUsageClient} from '../dist/usage.js';
const input={operation_id:'source',service_id:'model',conversation_id:'task',turn_id:'turn',messages:[{role:'user',content:'Synthetic continuation regression'}]};
const binding={hubUrl:'https://synthetic.invalid',accountId:'account',userId:'user',serviceId:'model',accessTokenProvider:()=>`bhu_s_${'x'.repeat(32)}`};
const envelope=(body,format='json')=>({schema:'bailing.provider-response.v1',format,status:200,content_type:format==='json'?'application/json':'text/event-stream',body});
const raw={choices:[{index:0,message:{role:'assistant',content:'已完成前半段，remaining…',reasoning_content:'synthetic reasoning',tool_calls:[{id:'partial',type:'function',function:{name:'never_execute_in_sdk',arguments:'{"x":'}}]},finish_reason:'length'}],usage:{prompt_tokens:2,completion_tokens:8,total_tokens:10,completion_tokens_details:{reasoning_tokens:5}}};
const operation=(id,response)=>({schema:'bailing.model-operation.v1',operation_id:id,account_id:'account',user_id:'user',service_id:'model',conversation_id:'task',turn_id:'turn',state:'completed',result_state:'complete',billing_state:'pending',dispatch:'completed',next_action:'none',revision:2,billing_rate:{planId:'plan',planRevision:1,multiplier:1,price:{currency:'USD'}},reference_cost_usd:null,billed_usd:null,overage_usd:null,response});
const json=value=>new Response(JSON.stringify(value));
const options={serviceId:'model',conversationId:'task',turnId:'turn'};
for(const format of ['json','sse'])test(`${format} length is complete provider exchange, not an SDK retry or finished Agent task`,async()=>{
 const body=format==='json'?JSON.stringify(raw):`data: ${JSON.stringify(raw)}\n\ndata: [DONE]\n\n`;
 const response=envelope(body,format),calls=[];
 const client=new BailingHubUsageClient({...binding,fetchImpl:async(url,init)=>{calls.push({method:init.method,path:new URL(url).pathname});return json(operation('source',response));}});
 const result=await client.modelComplete(input);assert.equal(result.result_state,'complete');assert.equal(result.billing_state,'pending');assert.deepEqual(result.response,response);
 assert.deepEqual((await client.inspectModelRequest('source',options)).response,response);
 assert.deepEqual(calls.map(c=>c.method),['POST','GET']);assert.equal(result.response.body,body);
});
test('only host-prepared continuation uses a new operation and preserved source partial/result facts',async()=>{
 const calls=[];const saved=new Map();
 const client=new BailingHubUsageClient({...binding,fetchImpl:async(url,init)=>{
  if(init.method==='GET')return json(saved.get('source'));
  const req=JSON.parse(init.body);calls.push(req);const response=envelope(JSON.stringify(req.operation_id==='source'?raw:{choices:[{message:{role:'assistant',content:'完成剩余部分'},finish_reason:'stop'}]}));
  const receipt=operation(req.operation_id,response);saved.set(req.operation_id,receipt);return json(receipt);
 }});
 const source=await client.modelComplete(input);await client.inspectModelRequest('source',options);assert.equal(calls.length,1);
 const next={...input,operation_id:'continuation',messages:[...input.messages,{role:'assistant',content:raw.choices[0].message.content},{role:'system',content:'Runtime continuation context: prior invocation action-A completed; continue remaining text only.'}]};
 // This SDK regression does not implement an Agent decision or invent a human input: the host supplies its new wire.
 await client.modelComplete(next);assert.equal(calls.length,2);assert.equal(calls[0].operation_id,'source');assert.equal(calls[1].operation_id,'continuation');assert.deepEqual(calls[0],input);assert.match(source.response.body,/length/);
});
test('missing final operation frame remains unknown and recovers original ID without replacement POST',async()=>{
 const provider={...envelope('', 'sse'),data:`data: ${JSON.stringify(raw)}\n\ndata: [DONE]\n\n`};delete provider.body;
 const frame={schema:'bailing.model-stream.v1',operation_id:'source',seq:1,type:'provider',provider};const methods=[];
 const client=new BailingHubUsageClient({...binding,fetchImpl:async(_url,init)=>{methods.push(init.method);return init.method==='POST'?new Response(`data: ${JSON.stringify(frame)}\n\n`,{headers:{'content-type':'text/event-stream'}}):json(operation('source',envelope(JSON.stringify(raw))));}});
 await assert.rejects(async()=>{for await(const _ of client.modelStream(input)){}},{code:'USAGE_STREAM_INCOMPLETE',dispatch:'unknown',operationId:'source'});
 await client.inspectModelRequest('source',options);assert.deepEqual(methods,['POST','GET']);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import phoneNaming, { normalizePhoneName, NAME_PROMPT, STATE_TYPE } from './index.ts';

const usage = {input:10,output:12,cacheRead:4096,cacheWrite:0,totalTokens:4118,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};
const model = {api:'openai-codex-responses',provider:'codex-test-account',id:'same-model',baseUrl:'https://example.invalid'};
const response = (stopReason='stop') => ({role:'assistant',provider:model.provider,model:model.id,api:model.api,stopReason,content:[{type:'text',text:'Completed task'}],usage,timestamp:1});
const parent = {model:'same-model',instructions:'Unchanged system instructions',tools:[{name:'read'}],input:[{role:'user',content:[{type:'input_text',text:'Task'}]}],prompt_cache_key:'parent-cache',reasoning:{effort:'high'}};
function fixture(options: {phone?:boolean, api?:string, hold?:boolean, invalidPrefix?:boolean, tool?:boolean}={}) {
  const handlers = new Map<string,Function[]>(), entries:any[]=[], requests:any[]=[], notices:any[]=[];
  let name='Phone',id='original';
  let release=()=>{};
  const held = new Promise<void>(resolve=>{release=resolve;});
  const pi:any={on(event:string,fn:Function){handlers.set(event,[...(handlers.get(event)||[]),fn]);},getSessionName:()=>name,appendEntry(customType:string,data:any){entries.push({type:'custom',customType,data});},setSessionName(value:string){name=value;void emit('session_info_changed',{});}};
  const ctx:any={mode:'tui',sessionManager:{getEntries:()=>entries,getSessionId:()=>id},ui:{notify:(...args:any[])=>notices.push(args)},model:{...model,api:options.api||model.api},modelRegistry:{getApiKeyAndHeaders:async()=>({ok:true,apiKey:'parent-account-token',env:{PARENT:'environment'}})}};
  const emit=async(event:string,value:any)=>{for(const h of handlers.get(event)||[])await h(value,ctx);};
  const run:any=(captured:any,context:any,settings:any)=>{
    requests.push({model:captured,context,settings});
    const candidate={...parent,input:[...(options.invalidPrefix?[]:parent.input),{role:'assistant',content:[]},{role:'user',content:[{type:'input_text',text:NAME_PROMPT}]}]};
    let error:string|undefined;
    const events=async function*(){
      if(options.hold)await held;
      try{requests.at(-1).payload=settings.onPayload(candidate);}catch(e:any){error=e.message;return;}
      if(options.tool)yield {type:'toolcall_start'};
      else yield {type:'text_delta',delta:'Phone-shared-shell-job-control'};
    };
    const stream:any=events();
    stream.result=async()=>({...response(error?'error':'stop'),errorMessage:error,content:[{type:'text',text:'Phone-shared-shell-job-control'}]});
    return stream;
  };
  const previous=process.env.PI_PHONE_CHAT;
  process.env.PI_PHONE_CHAT=options.phone===false?'0':'1';phoneNaming(pi,run);
  const start=async(reason='startup')=>{
    await emit('session_start',{reason});
    if(previous===undefined)delete process.env.PI_PHONE_CHAT;else process.env.PI_PHONE_CHAT=previous;
  };
  const capture=async()=>{
    await emit('context_with_system',{messages:[{role:'user',content:[{type:'text',text:'Task'}],timestamp:1}]});
    await emit('before_provider_headers',{headers:{'Authorization':'captured-parent-header','chatgpt-account-id':'same-account'}});
    await emit('before_provider_request',{payload:parent});
  };
  return {start,capture,emit,entries,requests,notices,release,get name(){return name;},rename(value:string){pi.setSessionName(value);},switchSession(){id='different';}};
}
const tick=()=>new Promise(resolve=>setTimeout(resolve,10));

test('normalization enforces Phone prefix and at most eight words total',()=>{
  assert.equal(normalizePhoneName('"Phone-Shared Shell Job Control"'),'Phone-shared-shell-job-control');
  assert.equal(normalizePhoneName('Phone-one-two-three-four-five-six-seven-eight-nine'),'Phone-one-two-three-four-five-six-seven');
  for(const value of ['An explanation\nPhone-title','Phone-','wrong-name'])assert.throws(()=>normalizePhoneName(value));
});
test('first final triggers one hidden same-account request with exact cached body; reload never repeats',async()=>{
  const f=fixture();await f.start();await f.capture();
  await f.emit('message_end',{message:response('toolUse')});assert.equal(f.requests.length,0);
  await f.emit('message_end',{message:response()});await tick();
  assert.equal(f.name,'Phone-shared-shell-job-control');assert.equal(f.requests.length,1);
  const r=f.requests[0];assert.deepEqual(r.model,model);
  assert.equal(r.settings.apiKey,'parent-account-token');assert.equal(r.settings.headers['chatgpt-account-id'],'same-account');
  assert.deepEqual(r.payload.input.slice(0,parent.input.length),parent.input);assert.deepEqual(r.payload.tools,parent.tools);
  assert.equal(r.payload.instructions,parent.instructions);assert.equal(r.payload.prompt_cache_key,parent.prompt_cache_key);assert.equal(r.payload.tool_choice,'none');
  assert.deepEqual(r.payload.reasoning,parent.reasoning);assert.equal(r.context.messages.at(-1).content[0].text,NAME_PROMPT);
  assert.ok(f.entries.every(e=>e.type==='custom'&&e.customType===STATE_TYPE));
  assert.equal(f.entries.find(e=>e.data.status==='named').data.usage.cacheRead,4096);
  await f.emit('message_end',{message:response()});await f.start('reload');await f.capture();await f.emit('message_end',{message:response()});await tick();assert.equal(f.requests.length,1);
});
test('ordinary and unsupported-provider chats do not use a fallback model',async()=>{
  for(const options of [{phone:false},{api:'anthropic-messages'}]){
    const f=fixture(options);await f.start();await f.capture();await f.emit('message_end',{message:response()});await tick();assert.equal(f.requests.length,0);assert.equal(f.name,'Phone');
    if(options.api)assert.equal(f.entries.at(-1).data.status,'skipped');else assert.equal(f.entries.length,0);
  }
});
test('manual rename, session switch, tree navigation and shutdown invalidate delayed naming',async()=>{
  for(const mutation of ['rename','switch','tree','shutdown']){
    const f=fixture({hold:true});await f.start();await f.capture();await f.emit('message_end',{message:response()});
    if(mutation==='rename')f.rename('Manual title');
    if(mutation==='switch'){await f.emit('session_before_switch',{});f.switchSession();}
    if(mutation==='tree')await f.emit('session_before_tree',{});
    if(mutation==='shutdown')await f.emit('session_shutdown',{});
    f.release();await tick();assert.equal(f.name,mutation==='rename'?'Manual title':'Phone');assert.equal(f.entries.some(e=>e.data.status==='named'),false);
  }
});
test('mismatched prefix and attempted tools fail closed without retrying or running tools',async()=>{
  for(const options of [{invalidPrefix:true},{tool:true}]){
    const f=fixture(options);await f.start();await f.capture();await f.emit('message_end',{message:response()});await tick();
    assert.equal(f.name,'Phone');assert.equal(f.entries.at(-1).data.status,'failed');
    await f.emit('message_end',{message:response()});assert.equal(f.requests.length,1);
  }
});

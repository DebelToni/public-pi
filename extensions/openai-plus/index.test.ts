import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";

test("raw image HTTP normalizes only wire IDs and preserves visible aliases, content, headers and selection", () => {
	const root = mkdtempSync(join(homedir(), "tmp", "openai-plus-long-"));
	try {
		const agentDir = join(root, "agent"); mkdirSync(agentDir);
		writeFileSync(join(agentDir, "openai-plus.json"), JSON.stringify({ image: { defaultSave: "none", defaultModel: "gpt-6-luna-long" } }));
		const release = join(root, "releases", "v27");
		mkdirSync(join(release, "suite", "runtime"), { recursive: true });
		writeFileSync(join(release, "suite", "runtime", "long-context-models.mjs"), `
export function getCodexLongContextModel(id) {
 return ['gpt-6.1-sol', 'gpt-6-luna', 'future-image-model'].map(baseId => ({baseId})).find(m => m.baseId + '-long' === id);
}`);
		writeFileSync(join(root, "reference.webp"), Buffer.from("fixture image"));
		const script = String.raw`
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {SessionManager,convertToLlm} from '@earendil-works/pi-coding-agent';
import {join} from 'node:path';
import extension from ${JSON.stringify(new URL("./index.ts", import.meta.url).pathname)};
const root = ${JSON.stringify(root)};
const token = 'fake.' + Buffer.from(JSON.stringify({'https://api.openai.com/auth':{chatgpt_account_id:'fixture-account'}})).toString('base64url') + '.fake';
const tools=new Map(), commands=new Map(), sent=[];
extension({events:{on(){return ()=>{}}},on(){},registerCommand(name,c){commands.set(name,c)},registerTool(t){tools.set(t.name,t)},sendMessage(m){sent.push(m)}});
let request;
globalThis.fetch=async (url,init)=>{
 request={url,init,body:JSON.parse(init.body)};
 return new Response('data: '+JSON.stringify({item:{type:'image_generation_call',id:'ig_fixture',status:'completed',result:'aW1hZ2U=',revised_prompt:'Fixture revision'}})+'\n\n', {headers:{'content-type':'text/event-stream'}});
};
const cases=[
 {selected:'gpt-6.1-sol-long',params:{},visible:'gpt-6.1-sol-long',wire:'gpt-6.1-sol',provider:'codex-pro'},
 {selected:'gpt-6-luna-long',params:{},visible:'gpt-6-luna-long',wire:'gpt-6-luna',provider:'codex-pro'},
 {selected:'gpt-6.1-sol',params:{model:'openai-codex/gpt-6.1-sol-long'},visible:'gpt-6.1-sol-long',wire:'gpt-6.1-sol',provider:'openai-codex'},
 {selected:'gpt-6.1-sol',params:{model:'codex-other/gpt-6-luna-long'},visible:'gpt-6-luna-long',wire:'gpt-6-luna',provider:'codex-other'},
 {selected:'gpt-6.1-sol',params:{provider:'codex-explicit',model:'openai-codex/gpt-6-luna-long'},visible:'gpt-6-luna-long',wire:'gpt-6-luna',provider:'codex-explicit'},
 {selected:'future-image-model-long',params:{},visible:'future-image-model-long',wire:'future-image-model',provider:'codex-pro'},
 {selected:'unknown-long',params:{},visible:'unknown-long',wire:'unknown-long',provider:'codex-pro'},
 {selected:'ordinary-model',params:{},visible:'ordinary-model',wire:'ordinary-model',provider:'codex-pro'},
 {selected:'ordinary-model',selectedProvider:'openai',params:{},visible:'gpt-6-luna-long',wire:'gpt-6-luna',provider:'openai-codex'},
];
function context(c) {
 const authCalls=[];
 const ctx={cwd:root,model:{provider:c.selectedProvider||'codex-pro',id:c.selected},modelRegistry:{async getApiKeyForProvider(provider){authCalls.push(provider);return token}}};
 return {ctx,authCalls};
}
function verifyRequest(c, prompt, edited=true) {
 assert.equal(request.url,'https://chatgpt.com/backend-api/codex/responses');
 assert.equal(request.init.method,'POST');
 assert.deepEqual(request.init.headers,{
  authorization:'Bearer '+token,'chatgpt-account-id':'fixture-account','OpenAI-Beta':'responses=experimental',accept:'text/event-stream','content-type':'application/json',originator:'codex_cli_rs','User-Agent':'codex_cli_rs/0.0.0 (pi-openai-plus)',
 });
 assert.deepEqual(request.body,{
  model:c.wire,instructions:'',input:[{role:'user',content:[{type:'input_text',text:prompt},...(edited?[{type:'input_image',detail:'auto',image_url:'data:image/webp;base64,'+Buffer.from('fixture image').toString('base64')}]:[])]}],
  tools:[{type:'image_generation',output_format:edited?'webp':'png',...(edited?{action:'edit'}:{})}],tool_choice:{type:'image_generation'},parallel_tool_calls:false,store:false,stream:true,include:[],client_metadata:{'x-codex-installation-id':'pi-openai-plus'},
 });
 assert.equal(request.init.signal.aborted,false);
}
for(const c of cases) {
 const {ctx,authCalls}=context(c);const original={...ctx.model};const updates=[];
 const prompt='Verbatim image prompt: colors, punctuation!';
 const result=await tools.get('openai_image').execute('fixture',{prompt,action:'edit',images:['reference.webp'],outputFormat:'webp',save:'none',...c.params},new AbortController().signal,(u)=>updates.push(u),ctx);
 verifyRequest(c,prompt);
 assert.deepEqual(authCalls,[c.provider]);assert.deepEqual(ctx.model,original);
 assert.deepEqual(result.details,{id:'ig_fixture',status:'completed',mimeType:'image/webp',revisedPrompt:'Fixture revision',prompt,savedPath:undefined,provider:c.provider,model:c.visible,action:'edit',outputFormat:'webp'});
 assert.equal(JSON.stringify(result).split('aW1hZ2U=').length-1,1,'image payload must be serialized only in content');
 assert.equal(result.content[0].text,'Generated image via '+c.provider+'/'+c.visible+'.\nAction: edit.\nPrompt: '+prompt+'\nRevised prompt: Fixture revision');
 assert.deepEqual(result.content[1],{type:'image',data:'aW1hZ2U=',mimeType:'image/webp'});
 assert.equal(updates[0].content[0].text,'Requesting OpenAI image...');
}
const c=cases[0];const {ctx,authCalls}=context(c);ctx.ui={notify(){}};
await commands.get('openai-image').handler('  Command prompt  ',ctx);
verifyRequest(c,'Command prompt',false);
assert.deepEqual(authCalls,[c.provider]);assert.equal(sent[0].details.model,c.visible);
assert.match(sent[0].content[0].text,/codex-pro\/gpt-6\.1-sol-long/);
assert.deepEqual(sent[0].content[1],{type:'image',data:'aW1hZ2U=',mimeType:'image/png'});
assert.equal(Object.hasOwn(sent[0].details,'data'),false);
assert.equal(JSON.stringify(sent[0]).split('aW1hZ2U=').length-1,1);
assert.equal(ctx.model.id,c.selected);
assert.deepEqual(readdirSync(join(root,'agent')),['openai-plus.json']);
assert.deepEqual(readdirSync(root).sort(),['agent','reference.webp','releases']);

// Old inline details remain readable alongside metadata-only new results.
const modern=await tools.get('openai_image').execute('saved',{prompt:'Save fixture',save:'custom',saveDir:join(root,'saved')},undefined,undefined,ctx);
assert.equal(readFileSync(modern.details.savedPath).toString(),'image');
assert.equal(Object.hasOwn(modern.details,'data'),false);
assert.equal(JSON.stringify(modern).split('aW1hZ2U=').length-1,1);
assert.match(modern.content[0].text,/Saved: /);
const legacy={...modern,details:{...modern.details,data:'aW1hZ2U='}};
const replay=SessionManager.inMemory(root);
for(const [index,result] of [legacy,modern].entries()) {
 replay.appendMessage(JSON.parse(JSON.stringify({role:'toolResult',toolName:'openai_image',toolCallId:'fixture-'+index,content:result.content,details:result.details,isError:false,timestamp:index})));
}
const messages=replay.buildSessionContext().messages;
assert.equal(messages[0].details.data,'aW1hZ2U=');
assert.equal(Object.hasOwn(messages[1].details,'data'),false);
for(const message of convertToLlm(messages)) assert.deepEqual(message.content,modern.content);
console.log('verified 9 image tool cases, command, save and legacy/new replay');
`;
		const output = execFileSync(process.execPath, ["-e", script], {
			encoding: "utf8", timeout: 20_000,
			env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_CODEX_ULTRA_RELEASE_ROOT: release, PI_CODEX_ULTRA_HOME: root, TMUX: "", TMUX_PANE: "" },
		});
		assert.equal(output.trim(), "verified 9 image tool cases, command, save and legacy/new replay");
	} finally { rmSync(root, { recursive: true, force: true }); }
}, 25_000);

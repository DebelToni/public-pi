import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

test("/park leaves ○ after quit without changing normal exits or allowing busy sessions", () => {
	const socket = `pi-park-test-${process.pid}`;
	const tmux = (...args: string[]) => execFileSync("tmux", ["-L", socket, ...args], { encoding: "utf8", timeout: 3000 });
	try {
		tmux("-f", "/dev/null", "new-session", "-d", "-s", "test", "-n", "Notes", "sleep 60");
		const socketPath = tmux("display-message", "-p", "#{socket_path}").trim();
		const pane = tmux("display-message", "-p", "#{pane_id}").trim();
		const script = `
			import assert from 'node:assert/strict';
			import {execFileSync} from 'node:child_process';
			import extension from ${JSON.stringify(new URL("./index.ts", import.meta.url).pathname)};
			const tmux=(...args)=>execFileSync('tmux',args,{encoding:'utf8',timeout:3000}).trim();
			assert.equal(tmux('display-message','-p','#{socket_path}'),${JSON.stringify(socketPath)});
			const fixture=()=>{
				const handlers=new Map(),commands=new Map();let exits=0;
				const ctx={cwd:'/tmp/notes',hasUI:true,mode:'tui',isIdle:()=>true,hasPendingMessages:()=>false,
					sessionManager:{getSessionFile:()=>undefined,getSessionName:()=>'Notes'},
					ui:{setTitle(){},notify(){}},shutdown(){exits++;}};
				extension({on(name,fn){handlers.set(name,fn)},registerFlag(){},registerCommand(name,value){commands.set(name,value)}});
				return {ctx,handlers,park:commands.get('park').handler,exits:()=>exits};
			};
			const parked=fixture();await parked.park('',parked.ctx);assert.equal(parked.exits(),1);
			await parked.handlers.get('session_shutdown')({reason:'quit'},parked.ctx);
			assert.equal(tmux('display-message','-p','#{window_name}'),'○ Notes');
			assert.equal(tmux('show-window-options','-v','@pi_title_state'),'idle');
			const normal=fixture();await normal.handlers.get('session_shutdown')({reason:'quit'},normal.ctx);
			assert.equal(tmux('display-message','-p','#{window_name}'),'Notes');
			await parked.handlers.get('session_shutdown')({reason:'reload'},parked.ctx);
			assert.equal(tmux('display-message','-p','#{window_name}'),'Notes');
			const busy=fixture();busy.ctx.isIdle=()=>false;await busy.park('',busy.ctx);assert.equal(busy.exits(),0);
			const queued=fixture();queued.ctx.hasPendingMessages=()=>true;await queued.park('',queued.ctx);assert.equal(queued.exits(),0);
			const rpc=fixture();rpc.ctx.mode='rpc';await rpc.park('',rpc.ctx);assert.equal(rpc.exits(),0);
			console.log('verified');
		`;
		const output = execFileSync(process.execPath, ["-e", script], {
			encoding: "utf8", timeout: 10000,
			env: { ...process.env, TMUX: `${socketPath},0,0`, TMUX_PANE: pane },
		});
		assert.equal(output.trim(), "verified");
	} finally { try { tmux("kill-server"); } catch {} }
}, { timeout: 15000 });

test("ask_user waits with ?, then returns to running and normal settled titles", () => {
	const socket = `pi-question-title-${process.pid}`;
	const tmux = (...args: string[]) => execFileSync("tmux", ["-L", socket, ...args], { encoding: "utf8", timeout: 3000 });
	try {
		tmux("-f", "/dev/null", "new-session", "-d", "-s", "test", "-n", "Notes", "sleep 60");
		const socketPath = tmux("display-message", "-p", "#{socket_path}").trim();
		const pane = tmux("display-message", "-p", "#{pane_id}").trim();
		const script = `
			import assert from 'node:assert/strict';
			import {execFileSync} from 'node:child_process';
			import extension from ${JSON.stringify(new URL("./index.ts", import.meta.url).pathname)};
			const tmux=(...args)=>execFileSync('tmux',args,{encoding:'utf8',timeout:3000}).trim();
			const handlers=new Map();
			const ctx={cwd:'/tmp/notes',hasUI:true,mode:'tui',sessionManager:{getSessionFile:()=>'/tmp/session.jsonl',getSessionName:()=>'Notes'},ui:{setTitle(){},notify(){}}};
			extension({on(name,fn){handlers.set(name,fn)},registerFlag(){},registerCommand(){}});
			await handlers.get('session_start')({},ctx);
			assert.equal(tmux('display-message','-p','#{window_name}'),'○ Notes');
			await handlers.get('turn_start')({},ctx);
			assert.equal(tmux('display-message','-p','#{window_name}'),'● Notes');
			await handlers.get('tool_execution_start')({toolName:'ask_user'},ctx);
			assert.equal(tmux('display-message','-p','#{window_name}'),'? Notes');
			assert.equal(tmux('show-window-options','-v','@pi_title_state'),'question');
			await handlers.get('tool_execution_start')({toolName:'read'},ctx);
			assert.equal(tmux('display-message','-p','#{window_name}'),'? Notes');
			await handlers.get('tool_execution_end')({toolName:'ask_user'},ctx);
			assert.equal(tmux('display-message','-p','#{window_name}'),'● Notes');
			await handlers.get('agent_settled')({},ctx);
			assert.equal(tmux('display-message','-p','#{window_name}'),'○ Notes');
			await handlers.get('turn_end')({message:{role:'assistant',stopReason:'stop'}},ctx);
			await handlers.get('agent_end')({messages:[{role:'assistant',stopReason:'stop'}]},ctx);
			await handlers.get('agent_settled')({},ctx);
			assert.equal(tmux('display-message','-p','#{window_name}'),'✓ Notes');
			await handlers.get('tool_execution_start')({toolName:'ask_user'},ctx);
			await handlers.get('agent_settled')({},ctx);
			assert.equal(tmux('display-message','-p','#{window_name}'),'? Notes');
			await handlers.get('tool_execution_end')({toolName:'ask_user'},ctx);
			await handlers.get('session_shutdown')({reason:'quit'},ctx);
			assert.equal(tmux('display-message','-p','#{window_name}'),'Notes');
			ctx.sessionManager.getSessionName=()=>'Phone-generated-name';
			for(const [state,icon] of [['idle','○'],['done','✓'],['running','●'],['question','?'],['none','']]){
				tmux('set-window-option','@pi_title_state',state);
				await handlers.get('session_info_changed')({name:'Phone-generated-name'},ctx);
				assert.equal(tmux('display-message','-p','#{window_name}'),(icon?icon+' ':'')+'Phone-generated-name');
				assert.equal(tmux('show-window-options','-v','@pi_title_state'),state);
				assert.equal(tmux('show-window-options','-v','@pi_title_base'),'Phone-generated-name');
			}
			console.log('verified');
		`;
		const output = execFileSync(process.execPath, ["-e", script], {
			encoding: "utf8", timeout: 10000,
			env: { ...process.env, TMUX: `${socketPath},0,0`, TMUX_PANE: pane },
		});
		assert.equal(output.trim(), "verified");
	} finally { try { tmux("kill-server"); } catch {} }
}, { timeout: 15000 });


test("raw wiki title HTTP resolves registry aliases without enabling automatic titles", () => {
	const root = mkdtempSync(join(homedir(), "tmp", "wiki-title-long-"));
	try {
		const agentDir = join(root, "agent"); mkdirSync(agentDir);
		const release = join(root, "releases", "v27");
		mkdirSync(join(release, "suite", "runtime"), { recursive: true });
		writeFileSync(join(release, "suite", "runtime", "long-context-models.mjs"), `
export function getCodexLongContextModel(id) {
 return ['gpt-6.1-sol', 'gpt-6-luna', 'future-title-model'].map(baseId => ({baseId})).find(m => m.baseId + '-long' === id);
}`);
		const script = String.raw`
import assert from 'node:assert/strict';
import {readdirSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import extension, {modelTitle} from ${JSON.stringify(new URL("./index.ts", import.meta.url).pathname)};
const root=${JSON.stringify(root)};
const token='fake.'+Buffer.from(JSON.stringify({'https://api.openai.com/auth':{chatgpt_account_id:'fixture-account'}})).toString('base64url')+'.fake';
let request,fetchCalls=0,sse=false;
globalThis.fetch=async(url,init)=>{
 fetchCalls++;request={url,init,body:JSON.parse(init.body)};
 if(sse)return new Response('data: '+JSON.stringify({delta:'Registry Title'})+'\n\n',{headers:{'content-type':'text/event-stream'}});
 return Response.json({output:[{content:[{type:'output_text',text:'Registry Title'}]}]});
};
const prompt='Verbatim wiki prompt! '+ 'x'.repeat(6500);
const cases=[
 {id:'gpt-6.1-sol-long',wire:'gpt-6.1-sol'},
 {id:'gpt-6-luna-long',wire:'gpt-6-luna'},
 {id:'future-title-model-long',wire:'future-title-model'},
 {id:'unknown-long',wire:'unknown-long'},
 {id:'ordinary-model',wire:'ordinary-model'},
 {id:'other',selectedProvider:'openai',wire:'gpt-6.1-sol',provider:'openai-codex'},
];
for(const c of cases){
 const authCalls=[];const ctx={model:{provider:c.selectedProvider||'codex-pro',id:c.id},modelRegistry:{async getApiKeyForProvider(p){authCalls.push(p);return token}}};
 const original={...ctx.model};
 assert.equal(await modelTitle(ctx,prompt),'Registry Title');
 assert.deepEqual(ctx.model,original);assert.deepEqual(authCalls,[c.provider||'codex-pro']);
 assert.equal(request.url,'https://chatgpt.com/backend-api/codex/responses');assert.equal(request.init.method,'POST');
 assert.deepEqual(request.init.headers,{authorization:'Bearer '+token,'chatgpt-account-id':'fixture-account','OpenAI-Beta':'responses=experimental','content-type':'application/json',originator:'codex_cli_rs','User-Agent':'codex_cli_rs/0.0.0 (pi-wiki-title)',accept:'application/json'});
 assert.deepEqual(request.body,{
  model:c.wire,
  instructions:'You name wiki note/research/chat sessions. Return only ONE word when possible: preferably the technology, paper name, method, author/project name, or key term. Use maximum TWO words only if one word is unclear. No punctuation, no quotes, no explanation.',
  input:[{role:'user',content:[{type:'input_text',text:prompt.slice(0,6000)}]}],
  max_output_tokens:16,store:false,stream:false,include:[],client_metadata:{'x-codex-installation-id':'pi-wiki-title'},
 });
 assert.equal(request.init.signal.aborted,false);
}
sse=true;
assert.equal(await modelTitle({model:{provider:'codex-pro',id:'gpt-6-luna-long'},modelRegistry:{async getApiKeyForProvider(){return token}}},'SSE prompt'),'Registry Title');
const handlers=new Map(),commands=new Map(),notices=[];
extension({on(name,fn){handlers.set(name,fn)},registerFlag(){},registerCommand(name,c){commands.set(name,c)}});
const before=fetchCalls;
const ctx={cwd:join(homedir(),'wiki'),hasUI:true,mode:'tui',model:{provider:'codex-pro',id:'gpt-6-luna-long'},
 modelRegistry:{async getApiKeyForProvider(){throw new Error('disabled title must not get auth')}},
 sessionManager:{getSessionFile:()=>'/fixture/session.jsonl',getSessionName:()=>'',getEntries:()=>[],getBranch(){throw new Error('disabled title must not read opening context')}},
 ui:{setTitle(){},notify(text){notices.push(text)}}};
await handlers.get('session_start')({},ctx);
await handlers.get('agent_end')({messages:[{role:'assistant',stopReason:'stop'}]},ctx);
await commands.get('wiki-title').handler('',ctx);
assert.equal(fetchCalls,before);
assert.deepEqual(notices,['Automatic wiki titles are disabled. Use /name <title>.']);
assert.deepEqual(readdirSync(join(root,'agent')),[]);
assert.deepEqual(readdirSync(root).sort(),['agent','releases']);
console.log('verified 6 title model cases, SSE response and disabled generation');
`;
		const output = execFileSync(process.execPath, ["-e", script], {
			encoding: "utf8", timeout: 20_000,
			env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_CODEX_ULTRA_RELEASE_ROOT: release, PI_CODEX_ULTRA_HOME: root, TMUX: "", TMUX_PANE: "" },
		});
		assert.equal(output.trim(), "verified 6 title model cases, SSE response and disabled generation");
	} finally { rmSync(root, { recursive: true, force: true }); }
}, { timeout: 25_000 });

import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { buildSessionContext, createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";

test("real SDK flag, slash command and reload preserve metadata outside model context", async t => {
	const directory = mkdtempSync(join(homedir(), "tmp/pi-unlisted-sdk-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const settingsManager = SettingsManager.inMemory({});
	const resourceLoader = new DefaultResourceLoader({ cwd: directory, agentDir: directory, settingsManager,
		additionalExtensionPaths: [new URL("./index.ts", import.meta.url).pathname], noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
	await resourceLoader.reload();
	assert.deepEqual(resourceLoader.getExtensions().errors, []);
	resourceLoader.getExtensions().runtime.flagValues.set("unlisted", true);
	const manager = SessionManager.inMemory(directory);
	const { session } = await createAgentSession({ cwd: directory, agentDir: directory, settingsManager, resourceLoader, sessionManager: manager, noTools: "all" });
	t.after(() => session.dispose());
	await session.bindExtensions({ mode: "print" });
	const preference = () => manager.getEntries().filter((entry: any) => entry.type === "custom" && entry.customType === "pi-unlisted").at(-1) as any;
	assert.equal(preference().data.enabled, true);
	assert.deepEqual(buildSessionContext(manager.getEntries(), manager.getLeafId()).messages, []);
	await session.prompt("/unlisted off");
	assert.equal(preference().data.enabled, false);
	await session.reload();
	assert.equal(preference().data.enabled, false);
	await session.prompt("/unlisted");
	assert.equal(preference().data.enabled, true);
	assert.deepEqual(buildSessionContext(manager.getEntries(), manager.getLeafId()).messages, []);
});

// Owned server only: lifecycle events and commands never call a model or send pane input.
test("unlisted startup/command state persists across reloads without marking other panes", () => {
	const socket = `pi-unlisted-${process.pid}`;
	const tmux = (...args: string[]) => execFileSync("tmux", ["-L", socket, ...args], { encoding: "utf8", timeout: 3000 }).trim();
	try {
		tmux("-f", "/dev/null", "new-session", "-d", "-s", "test", "-n", "Notes", "sleep 90");
		const socketPath = tmux("display-message", "-p", "#{socket_path}");
		const pane = tmux("display-message", "-p", "#{pane_id}");
		const other = tmux("split-window", "-d", "-P", "-F", "#{pane_id}", "sleep 90");
		const script = `
			import assert from 'node:assert/strict';
			import {execFileSync} from 'node:child_process';
			import extension from ${JSON.stringify(new URL("./index.ts", import.meta.url).pathname)};
			const pane=${JSON.stringify(pane)},other=${JSON.stringify(other)};
			const tmux=(...args)=>execFileSync('tmux',args,{encoding:'utf8',timeout:3000}).trim();
			let entries=[],flag=true,idle=true,pending=false,name='Notes';
			const notices=[],titles=[],flags=new Map();
			const ctx={cwd:'/tmp/unlisted-test',hasUI:true,mode:'tui',isIdle:()=>idle,hasPendingMessages:()=>pending,
				sessionManager:{getSessionFile:()=>'/tmp/owned.jsonl',getSessionName:()=>name,getEntries:()=>entries},
				ui:{setTitle(t){titles.push(t)},notify(t){notices.push(t)}},shutdown(){}};
			const load=()=>{
				const handlers=new Map(),commands=new Map();
				extension({on(n,f){handlers.set(n,f)},registerCommand(n,c){commands.set(n,c)},registerFlag(n,v){flags.set(n,v)},getFlag:()=>flag,
					appendEntry(customType,data){entries.push({type:'custom',customType,data})}});
				return {handlers,commands};
			};
			let runtime=load();
			const event=async(n,e={})=>runtime.handlers.get(n)?.(e,ctx);
			const command=async(args)=>runtime.commands.get('unlisted').handler(args,ctx);
			const check=(state,excluded,title)=>{
				assert.equal(tmux('display-message','-t',pane,'-p','#{@pi_title_state}'),state);
				assert.equal(tmux('show-options','-p','-t',pane,'-v','@pi_unlisted'),excluded?'1':'0');
				assert.equal(tmux('display-message','-t',pane,'-p','#{window_name}'),title);
				assert.equal(tmux('show-options','-p','-q','-t',other,'-v','@pi_unlisted'),'');
			};
			await event('session_start',{reason:'startup'});check('excluded',true,'Notes');
			assert.equal(flags.get('unlisted').type,'boolean');assert.deepEqual(entries,[{type:'custom',customType:'pi-unlisted',data:{enabled:true}}]);
			await event('before_agent_start');await event('turn_start');await event('tool_execution_start',{toolName:'ask_user'});check('excluded',true,'Notes');
			await command('off');check('question',false,'? Notes');
			await command('on');await command('');await command('status');check('excluded',true,'Notes');
			const count=entries.length;await command('wrong');assert.equal(entries.length,count);
			name='Renamed';await event('session_info_changed');if(runtime.handlers.has('session_info_changed'))check('excluded',true,'Renamed');
			await event('turn_end',{message:{role:'assistant',stopReason:'stop'}});await event('agent_end',{messages:[{role:'assistant',stopReason:'stop'}]});await event('agent_settled');check('excluded',true,'Renamed');
			if(runtime.commands.has('tick')){await runtime.commands.get('tick').handler('',ctx);check('excluded',true,'Renamed');}
			await runtime.commands.get('park').handler('',ctx);await event('session_shutdown',{reason:'quit'});check('excluded',true,'Renamed');
			runtime=load();await event('session_start',{reason:'reload'});check('excluded',true,'Renamed');
			await event('tool_execution_end',{toolName:'ask_user'});idle=false;await command('off');check('running',false,'● Renamed');
			idle=true;pending=true;await command('off');check('running',false,'● Renamed');pending=false;await command('off');check('idle',false,'○ Renamed');
			await event('session_shutdown',{reason:'reload'});runtime=load();await event('session_start',{reason:'reload'});check('idle',false,'○ Renamed');
			// Explicit flag on a fresh process wins over a saved off; normal resume restores it.
			runtime=load();await event('session_start',{reason:'startup'});check('excluded',true,'Renamed');
			flag=false;runtime=load();await event('session_start',{reason:'startup'});check('excluded',true,'Renamed');
			// Session replacement resets the old pane option; tree branches do not change this session-wide preference.
			entries=[];await event('session_start',{reason:'new'});check('idle',false,'○ Renamed');
			entries=[{type:'custom',customType:'pi-unlisted',data:{enabled:true}},{type:'custom',customType:'pi-unlisted',data:{enabled:'bad'}}];
			await event('session_start',{reason:'resume'});check('excluded',true,'Renamed');
			await command('off');await event('session_shutdown',{reason:'quit'});check('none',false,'Renamed');
			assert.ok(notices.some(n=>n.includes('Use /unlisted')));console.log('verified');
		`;
		assert.equal(execFileSync(process.execPath, ["-e", script], { encoding: "utf8", timeout: 25000,
			env: { ...process.env, TMUX: `${socketPath},0,0`, TMUX_PANE: pane } }).trim(), "verified");
	} finally { try { tmux("kill-server"); } catch {} }
}, { timeout: 30000 });

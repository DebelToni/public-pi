import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";

test("/tick restores native done state on its own window and preserves title lifecycle", () => {
	const socket = `pi-tick-test-${process.pid}`;
	const tmux = (...args: string[]) => execFileSync("tmux", ["-L", socket, ...args], { encoding: "utf8", timeout: 3000 });
	try {
		tmux("-f", "/dev/null", "new-session", "-d", "-s", "test", "-n", "Notes", "sleep 60");
		const socketPath = tmux("display-message", "-p", "#{socket_path}").trim();
		const pane = tmux("display-message", "-p", "#{pane_id}").trim();
		tmux("new-window", "-n", "Other", "sleep 60");
		const script = `
			import assert from 'node:assert/strict';
			import {execFileSync} from 'node:child_process';
			import extension from ${JSON.stringify(new URL("./index.ts", import.meta.url).pathname)};
			const tmux=(...args)=>execFileSync('tmux',args,{encoding:'utf8',timeout:3000}).trim();
			const pane=${JSON.stringify(pane)};
			const handlers=new Map(),commands=new Map(),titles=[],notices=[];
			const ctx={cwd:'/tmp/notes',hasUI:true,mode:'tui',isIdle:()=>true,hasPendingMessages:()=>false,
				sessionManager:{getSessionFile:()=>'/tmp/session.jsonl',getSessionName:()=>'Notes'},
				ui:{setTitle(title){titles.push(title)},notify(message){notices.push(message)}}};
			extension({on(name,fn){handlers.set(name,fn)},registerFlag(){},registerCommand(name,value){commands.set(name,value)}});
			const check=(name,state)=>{
				assert.equal(tmux('display-message','-t',pane,'-p','#{window_name}'),name);
				assert.equal(tmux('show-window-options','-t',pane,'-v','@pi_title_state'),state);
			};
			await handlers.get('session_start')({},ctx);
			check('○ Notes','idle');
			const tick=commands.get('tick');assert.ok(tick,'/tick must be registered');
			await tick.handler('',ctx);await tick.handler('',ctx);
			check('✓ Notes','done');assert.equal(titles.at(-1),'✓ Notes');
			assert.equal(tmux('display-message','-p','#{window_name}'),'Other');
			assert.equal(tmux('show-window-options','-t',pane,'-v','@pi_title_base'),'Notes');
			await handlers.get('agent_settled')({},ctx);check('✓ Notes','done');
			ctx.sessionManager.getSessionName=()=>'Renamed';
			await handlers.get('session_info_changed')({},ctx);check('✓ Renamed','done');
			tmux('select-window','-t',pane);check('○ Renamed','idle');
			await tick.handler('',ctx);check('✓ Renamed','done');
			await handlers.get('before_agent_start')({},ctx);check('● Renamed','running');
			ctx.isIdle=()=>false;await tick.handler('',ctx);check('● Renamed','running');
			ctx.isIdle=()=>true;ctx.hasPendingMessages=()=>true;
			await tick.handler('',ctx);check('● Renamed','running');
			ctx.hasPendingMessages=()=>false;ctx.mode='rpc';
			await tick.handler('',ctx);check('● Renamed','running');
			ctx.mode='tui';const savedTmux=process.env.TMUX;delete process.env.TMUX;
			await tick.handler('',ctx);process.env.TMUX=savedTmux;check('● Renamed','running');
			assert.equal(notices.length,4);
			await handlers.get('session_shutdown')({reason:'quit'},ctx);check('Renamed','none');
			console.log('verified');
		`;
		const output = execFileSync(process.execPath, ["-e", script], {
			encoding: "utf8", timeout: 10000,
			env: { ...process.env, TMUX: `${socketPath},0,0`, TMUX_PANE: pane },
		});
		assert.equal(output.trim(), "verified");
	} finally { try { tmux("kill-server"); } catch {} }
}, { timeout: 15000 });

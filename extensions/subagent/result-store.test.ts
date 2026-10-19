import * as fs from "node:fs";
import { spyOn } from "bun:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { normalizeSingleResult, readResultPage, resultOutput, sameMigratedResult } from "./result-store.ts";
import { runSingleAgent, type SingleResult } from "./index.ts";
import { renderSubagentResult } from "./monitor-ui.ts";
import { registerNamedSubagentTools, readNamedSubagent } from "./named-subagents.ts";
import { removeContinuation, writeContinuationManifest } from "./continuation-store.ts";
import { writeResumableForkSession } from "./fork-context.ts";
import { SubagentMonitorStore } from "./monitor.ts";

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
const assistant = (text: string): any => ({ role: "assistant", content: [{ type: "text", text }], stopReason: "stop", timestamp: 1 });
const legacy = (messages: any[]): SingleResult => ({ agent: "general", agentSource: "user", task: "test", exitCode: 0, messages, stderr: "", usage: { ...usage }, status: "completed" });
const details = (results: SingleResult[]) => ({ mode: "single" as const, agentScope: "user" as const, projectAgentsDir: null, results });

function fixture(t: any) {
	const root = mkdtempSync(join(tmpdir(), "disk-results-"));
	const prior = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = join(root, "agent");
	mkdirSync(join(root, "agent", "agents"), { recursive: true });
	writeFileSync(join(root, "agent", "agents", "general.md"), "---\nname: general\ndescription: fixture\nsize: big\n---\nfixture\n");
	t.after(() => { if (prior === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = prior; rmSync(root, { recursive: true, force: true }); });
	return root;
}

test("legacy normalization preserves exact evidence, is lean, and normalized restore never hydrates", (t) => {
	const root = fixture(t);
	const image = { role: "toolResult", toolCallId: "image", content: [{ type: "image", mimeType: "image/png", data: "X".repeat(2 * 1024 * 1024) }] };
	const original = legacy([image, assistant("all final text\n".repeat(10_000))]);
	const normalized = normalizeSingleResult(original, join(root, "results"));
	assert.deepEqual(normalized.messages, []);
	assert.equal(normalized.finalText, resultOutput(original));
	assert.deepEqual(readResultPage(normalized, 0, 1, 3 * 1024 * 1024).messages, [image]);
	assert.deepEqual(readResultPage(original, 1).messages, [original.messages[1]]);
	assert.equal(statSync(normalized.transcript!.directory).mode & 0o777, 0o700);
	assert.equal(statSync(join(normalized.transcript!.directory, "0.json")).mode & 0o777, 0o600);
	assert.throws(() => readResultPage(normalized), /exceeds page byte budget/);
	assert.equal(readResultPage(normalized, 1).next, undefined);
	const backing = normalized.transcript!.directory;
	rmSync(backing, { recursive: true });
	// Restore and rendering use inline final text, not disk access or an invalid fallback.
	assert.equal(normalizeSingleResult(normalized).finalText, normalized.finalText);
	const theme: any = { fg: (_: any, s: string) => s, bold: (s: string) => s };
	for (const expanded of [false, true]) assert.ok(renderSubagentResult({ content: [], details: details([normalized]) }, { expanded }, theme, { toolCallId: "t" }).render(80).length);
	assert.throws(() => readResultPage(normalized), /ENOENT/);
	assert.equal(original.messages[0], image);
});

test("empty legacy pending receipts compare exactly after normalization without a transcript", (t) => {
	fixture(t);
	const original = { ...legacy([]), status: "pending" as const, resume: { filePath: "/saved/session.jsonl" } as any };
	const normalized = normalizeSingleResult(original);
	assert.equal(normalized.transcript, undefined);
	assert.equal(sameMigratedResult(original, normalized), true);
	assert.equal(sameMigratedResult(original, { ...normalized, task: "changed" }), false);
});

test("explicit pages are bounded, missing/corrupt backing data fails loudly without inline fallback", (t) => {
	const root = fixture(t);
	const result = normalizeSingleResult(legacy(Array.from({ length: 40 }, (_, i) => assistant(`note-${i}`))), join(root, "results"));
	assert.equal(readResultPage(result).messages.length, 16);
	assert.equal(readResultPage(result).next, 16);
	assert.throws(() => readResultPage(result, 0, 33), /window/);
	assert.throws(() => readResultPage(result, 0, 1, 8 * 1024 * 1024), /window/);
	const file = join(result.transcript!.directory, "0.json");
	const corrupt = JSON.parse(readFileSync(file, "utf8"));
	corrupt.message.content[0].text = "corrupted but valid JSON";
	writeFileSync(file, JSON.stringify(corrupt));
	assert.throws(() => readResultPage(result), /checksum/);
	writeFileSync(join(result.transcript!.directory, "0.json"), "not json");
	assert.throws(() => readResultPage(result));
	writeFileSync(join(result.transcript!.directory, "0.json"), "{}");
	assert.throws(() => readResultPage(result), /Invalid result/);
	rmSync(join(result.transcript!.directory, "1.json"));
	assert.throws(() => readResultPage(result, 1), /ENOENT/);
});

function fakeChild(root: string, systems = 0, images = 8) {
	const file = join(root, "child.mjs");
	writeFileSync(file, `
import { appendFileSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
const args = process.argv.slice(2), file = args[args.indexOf('--session') + 1];
let parentId = JSON.parse(readFileSync(file, 'utf8').trim().split('\\n').at(-1)).id;
function emit(message) {
 const id = randomUUID();
 appendFileSync(file, JSON.stringify({type:'message',id,parentId,timestamp:new Date().toISOString(),message})+'\\n');
 parentId = id;
 console.log(JSON.stringify({type:'message_end',message}));
}
for(let i=0;i<${systems};i++) emit({role:'system',content:i % 2 ? [{type:'text',text:'system-'+i}] : 'system-'+i,timestamp:i});
emit({role:'user',content:[{type:'text',text:args.at(-1)}]});
const image = 'Z'.repeat(1024*1024);
for(let i=0;i<${images};i++) emit({role:'toolResult',toolCallId:'img'+i,content:[{type:'image',mimeType:'image/png',data:image}]});
emit({role:'assistant',content:[{type:'text',text:'COMPLETE FINAL RESPONSE '+ 'tail '.repeat(30_000)}],stopReason:'stop',usage:{input:1,output:1},model:'fixture'});
`);
	return (args: string[]) => ({ command: process.execPath.includes("bun") ? "node" : process.execPath, args: [file, ...args] });
}

test("repeated image-heavy runs never retain raw messages in live/parent details and retain successful sessions", async (t) => {
	const root = fixture(t);
	const invocation = fakeChild(root);
	const snapshots: string[] = [];
	const results: SingleResult[] = [];
	const monitor = new SubagentMonitorStore();
	const run = async () => {
		const id = monitor.queueRun({ orchestrationId: "o", sessionId: "parent", kind: "one-off", mode: "single", agent: "general", task: "test" });
		return runSingleAgent(root, [{ name: "general", description: "", systemPrompt: "", source: "user" } as any], "general", "test", undefined, "none", undefined, undefined, undefined, undefined,
			(partial) => {
				const result = partial.details!.results[0];
				assert.deepEqual(result.messages, []);
				const json = JSON.stringify(partial);
				assert.ok(json.length < 400_000);
				assert.equal(json.includes("Z".repeat(100)), false);
				snapshots.push(json);
			}, details, { invocation, runsRoot: join(root, "runs"), monitor: { store: monitor, runId: id } });
	};
	await run(); // warm modules/render caches before measuring retention
	Bun.gc(true);
	const before = process.memoryUsage().heapUsed;
	for (let i = 0; i < 3; i++) { results.push(await run()); Bun.gc(true); }
	await new Promise((resolve) => setTimeout(resolve, 20));
	Bun.gc(true);
	assert.ok(process.memoryUsage().heapUsed - before < 16 * 1024 * 1024, "retained heap must not grow with 24 MiB of child images");
	assert.ok(JSON.stringify(results).length < 500_000);
	for (const result of results) {
		assert.equal(result.status, "completed");
		assert.ok(result.finalText!.endsWith("tail "));
		assert.ok(existsSync(result.resume!.filePath));
		assert.equal(readResultPage(result, 1, 1, 2 * 1024 * 1024).messages[0].content[0].type, "image");
	}
	assert.deepEqual(monitor.getRuns("parent"), []);
});

test("named reuse/checkpoints stay lean and delivered manifests retain child evidence", async (t) => {
	const root = fixture(t);
	const invocation = fakeChild(root);
	const tools = new Map<string, any>();
	registerNamedSubagentTools({ registerTool(tool: any) { tools.set(tool.name, tool); }, appendEntry() {} } as any, {
		sizedModel: () => "fake/fake",
		runSingleAgent: (...args: any[]) => { args[12] = { ...args[12], invocation }; return (runSingleAgent as any)(...args); },
	});
	const ctx: any = { cwd: root, hasUI: false, sessionManager: { getSessionId: () => "parent", getSessionFile: () => undefined } };
	await tools.get("create_subagent").execute("create", { name: "worker", template: "general", history: "none", contextMode: "none" }, undefined, undefined, ctx);
	for (let i = 0; i < 2; i++) {
		const result = await tools.get("invoke_subagent").execute(`call-${i}`, { name: "worker", prompt: "work" }, undefined, undefined, ctx);
		assert.ok(JSON.stringify(result.details).length < 160_000);
		assert.equal(result.content[0].text, result.details.result.finalText);
		assert.equal(result.details.result.transcript.messageCount, 10);
		assert.deepEqual(result.details.result.messages, []);
		assert.ok(JSON.stringify(readNamedSubagent("parent", "worker")).length < 160_000);
	}
	const state = readNamedSubagent("parent", "worker")!;
	const manifests = join(root, "manifests");
	writeContinuationManifest({ version: 1, id: "call", parentSessionId: "p", parentBranchAnchor: null, parentToolCallId: "call", mode: "single", args: {}, details: {}, status: "resolved", createdAt: 0, updatedAt: 0 }, manifests);
	removeContinuation("call", "p", manifests);
	assert.ok(existsSync(state.resume.filePath));
	assert.ok(readFileSync(state.resume.filePath, "utf8").includes('"parentId"'));
});


test("legacy and streamed results page all 50 system messages and supported built-in stream shapes", async (t) => {
	const root = fixture(t);
	const messages: any[] = Array.from({ length: 50 }, (_, i) => ({ role: "system", content: i % 2 ? [{ type: "text", text: `system-${i}` }] : `system-${i}`, timestamp: i }));
	messages.push({ role: "custom", content: "custom", customType: "fixture" },
		{ role: "bashExecution", command: "true", output: "okay" },
		{ role: "branchSummary", summary: "branch" }, { role: "compactionSummary", summary: "summary" }, assistant("final"));
	const inline = legacy(messages);
	const disk = normalizeSingleResult(inline);
	const collect = (result: SingleResult) => {
		const output: any[] = [];
		let start: number | undefined = 0;
		while (start !== undefined) { const page = readResultPage(result, start, 16, 4 * 1024 * 1024); output.push(...page.messages); start = page.next; }
		return output;
	};
	assert.deepEqual(collect(inline), messages);
	assert.deepEqual(collect(disk), messages);
	const untimestamped = legacy([{ role: "system", content: "legacy system without timestamp" }]);
	assert.equal(sameMigratedResult(JSON.parse(JSON.stringify(normalizeSingleResult(untimestamped))), untimestamped), true);
	assert.throws(() => readResultPage(legacy([{ role: "unknown", content: [] }])), /Invalid result message/);
	assert.throws(() => readResultPage(legacy([{ role: "system", content: 42 }])), /Invalid result message/);
	const streamed = await runSingleAgent(root, [{ name: "general", systemPrompt: "", source: "user" } as any], "general", "test", undefined, "none", undefined, undefined, undefined, undefined, undefined, details,
		{ invocation: fakeChild(root, 50), runsRoot: join(root, "runs") });
	assert.deepEqual(collect(streamed).slice(0, 50), messages.slice(0, 50));
	assert.equal(streamed.transcript!.messageCount, 60);
});

test("resumed transcript directory is synced after hardlinks and before publishing its checkpoint", async (t) => {
	const root = fixture(t);
	const session = await writeResumableForkSession(root, [], undefined, join(root, "runs"));
	const prior = normalizeSingleResult({ ...legacy([assistant("partial")]), status: "interrupted", exitCode: 130, resume: session });
	const nativeLink = fs.linkSync, nativeSync = fs.fsyncSync;
	let linkedDirectory: string | undefined, synced = false, checkpoint = false;
	const linkSpy = spyOn(fs, "linkSync").mockImplementation((source: fs.PathLike, destination: fs.PathLike) => {
		nativeLink(source, destination);
		linkedDirectory = dirname(String(destination)); synced = false;
	});
	const syncSpy = spyOn(fs, "fsyncSync").mockImplementation((fd: number) => {
		nativeSync(fd);
		if (linkedDirectory && fs.fstatSync(fd).ino === fs.statSync(linkedDirectory).ino && fs.fstatSync(fd).isDirectory()) synced = true;
	});
	try {
		await runSingleAgent(root, [{ name: "general", systemPrompt: "", source: "user" } as any], "general", "test", undefined, "none", undefined, undefined, undefined, AbortSignal.abort(), undefined, details, {
			resumeFrom: prior,
			onCheckpoint(result) {
				checkpoint = true;
				assert.equal(result.transcript!.directory, linkedDirectory);
				assert.equal(synced, true, "hardlink directory must be fsynced before onCheckpoint");
				assert.deepEqual(readResultPage(result).messages, readResultPage(prior).messages);
			},
			invocation: () => { throw new Error("must not launch"); },
		});
		assert.equal(checkpoint, true);
	} finally { linkSpy.mockRestore(); syncSpy.mockRestore(); }
});


test("named truncated-tail recovery remaps the durable thread before a later invocation", async (t) => {
	const root = fixture(t);
	const invocation = fakeChild(root, 0, 0);
	const tools = new Map<string, any>();
	registerNamedSubagentTools({ registerTool(tool: any) { tools.set(tool.name, tool); }, appendEntry() {} } as any, {
		sizedModel: () => "fake/fake",
		runSingleAgent: (...args: any[]) => { args[12] = { ...args[12], invocation }; return (runSingleAgent as any)(...args); },
	});
	const ctx: any = { cwd: root, hasUI: false, sessionManager: { getSessionId: () => "parent", getSessionFile: () => undefined } };
	await tools.get("create_subagent").execute("create", { name: "worker", template: "general", history: "none", contextMode: "none" }, undefined, undefined, ctx);
	const first = await tools.get("invoke_subagent").execute("call-1", { name: "worker", prompt: "work" }, undefined, undefined, ctx);
	const state = readNamedSubagent("parent", "worker")!;
	state.pending = { ...first.details.result, status: "interrupted", stopReason: "aborted", exitCode: 130 };
	const owner = dirname(dirname(state.resume.dir));
	writeFileSync(join(owner, "worker.json"), JSON.stringify(state));
	fs.appendFileSync(state.resume.filePath, '{"type":"message","id":"cut","message":{');
	const evidence = readFileSync(state.resume.filePath);
	const continued = await tools.get("invoke_subagent").execute("call-2", { name: "worker", continue: true }, undefined, undefined, ctx);
	assert.equal(continued.details.result.status, "completed");
	const repaired = readNamedSubagent("parent", "worker")!;
	assert.notEqual(repaired.resume.filePath, state.resume.filePath);
	assert.equal(repaired.resume.filePath, continued.details.result.resume.filePath);
	assert.equal(repaired.pending, undefined);
	const next = await tools.get("invoke_subagent").execute("call-3", { name: "worker", prompt: "next" }, undefined, undefined, ctx);
	assert.equal(next.details.result.resume.filePath, repaired.resume.filePath);
	assert.deepEqual(readFileSync(state.resume.filePath), evidence);
});

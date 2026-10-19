import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { runBoundedProcess, SessionStoreClient } from "./session-store-client.ts";

function fixture() {
	const root = mkdtempSync(join(process.env.HOME!, "tmp", "session-client-test-"));
	const cli = join(root, "catalog");
	const log = join(root, "diagnostics.jsonl");
	const oldLog = process.env.PI_SESSION_SEARCH_LOG_PATH;
	process.env.PI_SESSION_SEARCH_LOG_PATH = log;
	return {
		root, cli, log,
		write(body: string) { writeFileSync(cli, `#!${process.execPath}\n${body}\n`); chmodSync(cli, 0o700); },
		close() {
			if (oldLog === undefined) delete process.env.PI_SESSION_SEARCH_LOG_PATH;
			else process.env.PI_SESSION_SEARCH_LOG_PATH = oldLog;
			rmSync(root, { recursive: true, force: true });
		},
	};
}

function alive(pid: number) {
	try {
		process.kill(pid, 0);
		return !readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1].startsWith("Z");
	} catch { return false; }
}

test("timeout kills a SIGTERM-resistant descendant even after its leader closes pipes", async () => {
	const f = fixture();
	let pid: number | undefined;
	try {
		const pidFile = join(f.root, "descendant.pid");
		const descendant = `process.on('SIGTERM', () => {}); require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`;
		f.write(`require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: 'ignore' }); setInterval(() => {}, 1000);`);
		await assert.rejects(() => runBoundedProcess(f.cli, [], { timeoutMs: 500 }), /timed out/);
		pid = Number(readFileSync(pidFile, "utf8"));
		await new Promise((resolve) => setTimeout(resolve, 100));
		assert.equal(alive(pid), false, `descendant ${pid} survived failed request`);
	} finally {
		if (pid && alive(pid)) process.kill(pid, "SIGKILL");
		f.close();
	}
});

test("maximum-match Unicode search fits the serialized output budget", async () => {
	const f = fixture();
	try {
		f.write(`const results = Array.from({length: 100}, (_, s) => {
 const matches = Array.from({length: 50}, (_, i) => ({excerpt: '漢'.repeat(320), matchedEntryId: 'e'+i,
 matchedEntryRef: {id:'e'+i,ordinal:i,byteStart:i*100,byteEnd:i*100+99,sourceSha256:'a'.repeat(64)}, matchedRole:'user'}));
 return {path:'/tmp/'+s+'.jsonl',id:'s'+s,cwd:'/tmp',excerpt:matches[0].excerpt,matchedEntryId:'e0',matchedEntryRef:matches[0].matchedEntryRef,matches};
}); console.log(JSON.stringify({results,coverage:{scopeComplete:true}}));`);
		const result = await new SessionStoreClient(f.cli).search("unicode", { limit: 100, matches: 50 });
		assert.equal(result.results.length, 100);
		assert.equal(result.results[99].matches?.length, 50);
		assert.ok(JSON.parse(readFileSync(f.log, "utf8")).stdoutBytes > 5_660_672);
	} finally { f.close(); }
});

test("search diagnostics record timing and counters without queries or returned text", async () => {
	const f = fixture();
	try {
		f.write(`console.log(JSON.stringify({results:[{excerpt:'private returned content'}],coverage:{scopeComplete:true},performance:{candidateRowsScanned:3},durationMs:12}));`);
		await new SessionStoreClient(f.cli).search("private query", { path: "/private/source.jsonl", mode: "bm25", matches: 6 });
		const text = readFileSync(f.log, "utf8");
		const row = JSON.parse(text);
		assert.equal(row.operation, "search");
		assert.equal(row.mode, "bm25");
		assert.equal(row.scope, "path");
		assert.equal(row.status, "ok");
		assert.equal(row.queryChars, 13);
		assert.equal(row.backendDurationMs, 12);
		assert.equal(row.performance.candidateRowsScanned, 3);
		assert.equal(typeof row.pid, "number");
		assert.equal(typeof row.elapsedMs, "number");
		assert.doesNotMatch(text, /private query|private returned content|\/private\/source/);
		assert.equal(statSync(f.log).mode & 0o777, 0o600);
	} finally { f.close(); }
});

test("partial and failed reconciliation diagnostics prioritize actual failures", async () => {
	const f = fixture();
	try {
		f.write(`console.log(JSON.stringify({buckets:['x'.repeat(2000)],scopeComplete:false,failures:[{error:'missing session header'}]}));process.exit(2);`);
		const client = new SessionStoreClient(f.cli);
		assert.equal((await client.reconcile({ all: true }, undefined, { allowIncomplete: true })).scopeComplete, false);
		await assert.rejects(() => client.reconcile({ all: true }), /missing session header.*catalog reconcile/);
		const rows = readFileSync(f.log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
		assert.equal(rows[0].status, "partial");
		assert.equal(rows[0].failureCount, 1);
		assert.equal(rows[1].status, "error");
		assert.equal(rows[1].errorCategory, "nonzero_exit");
		assert.equal(rows[1].error, undefined);
	} finally { f.close(); }
});

test("error diagnostics do not persist queries echoed by the backend", async () => {
	const f = fixture();
	try {
		f.write(`console.error('Invalid regular expression: /[PRIVATE_QUERY/: Unterminated character class'); process.exit(1);`);
		await assert.rejects(() => new SessionStoreClient(f.cli).search("[PRIVATE_QUERY", { mode: "regex" }), /PRIVATE_QUERY/);
		const text = readFileSync(f.log, "utf8");
		assert.doesNotMatch(text, /PRIVATE_QUERY|regular expression/);
		assert.equal(JSON.parse(text).errorCategory, "nonzero_exit");
	} finally { f.close(); }
});

test("diagnostics rotate at the byte limit and never fail a successful request", async () => {
	const f = fixture();
	try {
		f.write(`console.log(JSON.stringify({results:[],coverage:{scopeComplete:true}}));`);
		writeFileSync(f.log, "x".repeat(2 * 1024 * 1024), { mode: 0o600 });
		const client = new SessionStoreClient(f.cli);
		await client.search("needle");
		assert.ok(existsSync(f.log + ".1"));
		assert.ok(statSync(f.log).size < 4096);
		process.env.PI_SESSION_SEARCH_LOG_PATH = f.root;
		assert.equal((await client.search("needle")).results.length, 0);
	} finally { f.close(); }
});

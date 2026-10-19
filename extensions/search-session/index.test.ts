import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import searchSessionExtension from "./index.ts";
import { runBoundedProcess, SESSION_SOURCE_PATH_ENV, SessionStoreClient } from "../lib/session-store-client.ts";

const ref = (id: string, ordinal: number, byteStart: number) => ({ id, ordinal, byteStart, byteEnd: byteStart + 20, sourceSha256: `${id}-sha` });

function fakeCatalog(root: string) {
	const log = join(root, "calls.jsonl");
	const cli = join(root, "catalog");
	writeFileSync(cli, `#!/usr/bin/env python3
import json, os, pathlib, sys
with open(os.environ['SESSION_STORE_TEST_LOG'], 'a') as f: f.write(json.dumps(sys.argv[1:]) + '\\n')
command = sys.argv[1]
u1 = {'id':'u1','ordinal':1,'byteStart':100,'byteEnd':120,'sourceSha256':'u1-sha'}
a1 = {'id':'a1','ordinal':2,'byteStart':200,'byteEnd':220,'sourceSha256':'a1-sha'}
if command == 'read':
 print(json.dumps({'entries':[{'id':'u1','entryRef':u1,'parentId':None,'type':'message','role':'user','text':'needle question','parts':[{'part':1,'kind':'image','image':{'mime':'image/png','sha256':'abc','bytes':3}}]},{'id':'a1','entryRef':a1,'parentId':'u1','type':'message','role':'assistant','text':'needle answer'}], 'coverage':{'scopeComplete':True}, 'leafRef':a1, 'leafSelection':'explicit'}))
elif command == 'search' and '--path' in sys.argv:
 print(json.dumps({'results':[{'path':'/tmp/current.jsonl','id':'current','cwd':'/tmp/project','matches':[{'excerpt':'needle question','matchedEntryId':'u1','matchedEntryRef':u1,'matchedRole':'user'},{'excerpt':'needle answer','matchedEntryId':'a1','matchedEntryRef':a1,'matchedRole':'assistant'}]}], 'coverage':{'scopeComplete':True,'leafRef':a1}}))
elif command == 'search':
 print(json.dumps({'results':[{'path':'/tmp/global.jsonl','id':'global','cwd':'/tmp/project','name':'Global','modified':'2026-01-01T00:00:00Z','messageCount':2,'firstMessage':'first','excerpt':'needle global','matchedEntryId':'a1','matchedEntryRef':a1,'matchedRole':'assistant','matches':[{'excerpt':'needle global','matchedEntryId':'a1','matchedEntryRef':a1,'matchedRole':'assistant'}]}], 'coverage':{'scopeComplete':True}}))
elif command == 'image':
 output = sys.argv[sys.argv.index('--output') + 1]
 pathlib.Path(output).write_bytes(b'png')
 print(json.dumps({'path':'/tmp/current.jsonl','entry':'u1','entryRef':u1,'part':1,'output':output,'mime':'image/png','sha256':'abc','bytes':3,'imageSource':{'base':'message.content','contentIndex':1}}))
else:
 print(json.dumps({'scopeComplete':True}))
`);
	chmodSync(cli, 0o700);
	return { cli, log };
}

function toolsFor(cli: string, log?: string) {
	process.env.PI_SESSION_CATALOG_CLI = cli;
	if (log) process.env.SESSION_STORE_TEST_LOG = log;
	const tools = new Map<string, any>();
	searchSessionExtension({ registerTool(tool: any) { tools.set(tool.name, tool); } } as ExtensionAPI);
	return tools;
}

function calls(log: string) {
	return readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function clearEnvironment() {
	delete process.env.PI_SESSION_CATALOG_CLI;
	delete process.env.SESSION_STORE_TEST_LOG;
	delete process.env[SESSION_SOURCE_PATH_ENV];
}

const context = {
	cwd: "/tmp/project",
	sessionManager: {
		getSessionFile: () => "/tmp/current.jsonl",
		getLeafId: () => "live-leaf",
	},
};

test("grep_current_session and grep_session_bank expose distinct scope contracts without the old alias", async () => {
	const root = mkdtempSync(join(tmpdir(), "grep-session-contract-"));
	try {
		const { cli, log } = fakeCatalog(root);
		const tools = toolsFor(cli, log);
		assert.deepEqual([...tools.keys()].sort(), ["grep_current_session", "grep_session_bank", "read_session"]);
		const current = tools.get("grep_current_session");
		const bank = tools.get("grep_session_bank");
		assert.match(current.description, /current session/i);
		assert.match(bank.description, /BM25 \(default\)/);
		assert.match(bank.description, /global phrase\/regex scans eligible entries and can time out/i);
		assert.match(bank.promptGuidelines.join(" "), /Use grep_session_bank with two or three distinctive BM25 terms/);
		for (const key of ["session", "cwd", "global", "tree", "limit"]) assert.equal(current.parameters.properties[key], undefined, `current must not advertise ${key}`);
		assert.ok(bank.parameters.properties.session);
		assert.ok(bank.parameters.properties.cwd);
		assert.ok(bank.parameters.properties.global);
		for (const invalid of [{ session: "/tmp/other.jsonl" }, { global: true }, { cwd: "/tmp/project" }, { tree: true }]) {
			await assert.rejects(() => current.execute("invalid", { query: "needle", ...invalid }, undefined, undefined, context), /(?:scope|current|parameter|unsupported|session|global|cwd|tree)/i);
		}
		assert.equal(existsSync(log), false, "invalid current scopes must fail before catalog access");
	} finally {
		clearEnvironment();
		rmSync(root, { recursive: true, force: true });
	}
});

test("read_session propagates exact locators and returns extracted image content", async () => {
	const root = mkdtempSync(join(tmpdir(), "read-session-test-"));
	try {
		const { cli, log } = fakeCatalog(root);
		const tool = toolsFor(cli, log).get("read_session");
		const result = await tool.execute("call", { entry: "u1", byteStart: 100, before: 2, after: 3, limit: 8, maxChars: 5000, imagePart: 1 }, undefined, undefined, context);
		assert.match(result.content[0].text, /needle answer/);
		assert.match(result.content[0].text, /entryRef=.*byteStart.*100/);
		assert.equal(result.content[1].type, "image");
		assert.equal(result.content[1].data, Buffer.from("png").toString("base64"));
		assert.deepEqual(result.details.coverage, { scopeComplete: true });
		const observed = calls(log);
		assert.deepEqual(observed[0].slice(0, 3), ["reconcile", "--path", "/tmp/current.jsonl"]);
		assert.equal(observed[1][observed[1].indexOf("--leaf") + 1], "live-leaf");
		assert.equal(observed[1][observed[1].indexOf("--entry") + 1], "u1");
		assert.equal(observed[1][observed[1].indexOf("--byte-start") + 1], "100");
		assert.equal(observed[2][observed[2].indexOf("--byte-start") + 1], "100");
		assert.match(result.details.image.output, /\/tmp\/pi-session-image-/);
	} finally {
		clearEnvironment();
		rmSync(root, { recursive: true, force: true });
	}
});

test("read_session explicit history is one selected physical session and needs no search", async () => {
	const root = mkdtempSync(join(tmpdir(), "read-session-scope-"));
	try {
		const source = join(root, "past.jsonl");
		writeFileSync(source, JSON.stringify({ type: "session", version: 3, id: "past", timestamp: new Date().toISOString(), cwd: root }) + "\n");
		const { cli, log } = fakeCatalog(root);
		const read = toolsFor(cli, log).get("read_session");
		const result = await read.execute("history", { session: source, entry: "u1", byteStart: 100, before: 1, after: 2 }, undefined, undefined, context);
		assert.equal(result.details.path, source);
		assert.match(result.content[0].text, /needle question/);
		const observed = calls(log);
		assert.deepEqual(observed[0].slice(0, 3), ["reconcile", "--path", source]);
		const transcript = observed.find((args) => args[0] === "read");
		assert.equal(transcript[transcript.indexOf("--path") + 1], source);
		assert.equal(transcript[transcript.indexOf("--byte-start") + 1], "100");
		assert.equal(transcript.includes("--leaf"), false, "historical read must not inherit the live branch");
		assert.equal(observed.some((args) => args[0] === "search"), false);
	} finally {
		clearEnvironment();
		rmSync(root, { recursive: true, force: true });
	}
});

test("grep tools separate current branch matches from bank session limits and preserve exact refs", async () => {
	const root = mkdtempSync(join(tmpdir(), "search-session-test-"));
	try {
		const { cli, log } = fakeCatalog(root);
		const tools = toolsFor(cli, log);
		const current = tools.get("grep_current_session");
		const bank = tools.get("grep_session_bank");
		const local = await current.execute("local", { query: "needle", maxMatches: 2 }, undefined, undefined, context);
		assert.equal(local.details.matchCount, 2);
		assert.match(local.content[0].text, /matchedEntryRef=.*sourceSha256/);
		await bank.execute("global", { query: "needle", global: true, limit: 4, maxMatches: 2 }, undefined, undefined, context);
		const observed = calls(log);
		const localSearch = observed.find((args) => args[0] === "search" && args.includes("--path"));
		assert.equal(localSearch[localSearch.indexOf("--matches") + 1], "2");
		assert.equal(localSearch[localSearch.indexOf("--mode") + 1], "phrase");
		const broadSearch = observed.find((args) => args[0] === "search" && !args.includes("--path"));
		assert.equal(broadSearch[broadSearch.indexOf("--limit") + 1], "4");
		assert.equal(broadSearch[broadSearch.indexOf("--matches") + 1], "2");
		assert.equal(broadSearch[broadSearch.indexOf("--mode") + 1], "bm25");
	} finally {
		clearEnvironment();
		rmSync(root, { recursive: true, force: true });
	}
});

test("grep_session_bank exact source stays one physical file; grep_current_session selects regex and BM25", async () => {
	const root = mkdtempSync(join(tmpdir(), "grep-session-modes-"));
	try {
		const source = join(root, "past.jsonl");
		writeFileSync(source, JSON.stringify({ type: "session", version: 3, id: "past", timestamp: new Date().toISOString(), cwd: root }) + "\n");
		const { cli, log } = fakeCatalog(root);
		const tools = toolsFor(cli, log);
		await tools.get("grep_session_bank").execute("exact", { query: "needle", session: source, mode: "regex", maxMatches: 3 }, undefined, undefined, context);
		await tools.get("grep_current_session").execute("regex", { query: "needle", mode: "regex" }, undefined, undefined, context);
		await tools.get("grep_current_session").execute("bm25", { query: "needle", mode: "bm25" }, undefined, undefined, context);
		const searches = calls(log).filter((args) => args[0] === "search");
		assert.equal(searches[0][searches[0].indexOf("--path") + 1], source);
		assert.equal(searches[0].includes("--cwd"), false);
		assert.equal(searches[0][searches[0].indexOf("--mode") + 1], "regex");
		assert.equal(searches[0][searches[0].indexOf("--matches") + 1], "3");
		assert.equal(searches[1][searches[1].indexOf("--mode") + 1], "regex");
		assert.equal(searches[2][searches[2].indexOf("--mode") + 1], "bm25");
		assert.equal(searches.slice(1).every((args) => args[args.indexOf("--leaf") + 1] === "live-leaf"), true);
	} finally {
		clearEnvironment();
		rmSync(root, { recursive: true, force: true });
	}
});

test("cwd tree and explicit assistant tool evidence forward backend flags", async () => {
	const root = mkdtempSync(join(tmpdir(), "search-session-flags-"));
	try {
		const { cli, log } = fakeCatalog(root);
		const tool = toolsFor(cli, log).get("grep_session_bank");
		await tool.execute("cwd", { query: "needle", cwd: "/tmp/project", tree: true, role: "assistant", includeTools: true }, undefined, undefined, context);
		const observed = calls(log);
		assert.ok(observed.some((args) => args[0] === "reconcile" && args.includes("--cwd") && args.includes("--tree")));
		const search = observed.find((args) => args[0] === "search");
		assert.ok(search.includes("--include-tools"));
		assert.equal(search[search.indexOf("--role") + 1], "assistant");
	} finally {
		clearEnvironment();
		rmSync(root, { recursive: true, force: true });
	}
});

test("source-restricted evidence permits only an explicit exact bank target", async () => {
	const root = mkdtempSync(join(tmpdir(), "search-session-scope-"));
	try {
		const source = join(root, "source.jsonl");
		const other = join(root, "other.jsonl");
		for (const [file, id] of [[source, "source-id"], [other, "other-id"]]) writeFileSync(file, JSON.stringify({ type: "session", version: 3, id, timestamp: new Date().toISOString(), cwd: root }) + "\n");
		const { cli, log } = fakeCatalog(root);
		const tools = toolsFor(cli, log);
		process.env[SESSION_SOURCE_PATH_ENV] = source;
		await assert.rejects(() => tools.get("grep_current_session").execute("current", { query: "needle" }, undefined, undefined, context), /restricted to one source/i);
		const bank = tools.get("grep_session_bank");
		await assert.rejects(() => bank.execute("implicit", { query: "needle" }, undefined, undefined, context), /(?:source|session|scope)/i);
		await assert.rejects(() => bank.execute("global", { query: "needle", global: true }, undefined, undefined, context), /(?:global|restricted)/i);
		await assert.rejects(() => bank.execute("cwd", { query: "needle", cwd: root }, undefined, undefined, context), /(?:cwd|restricted)/i);
		await assert.rejects(() => bank.execute("other", { query: "needle", session: other }, undefined, undefined, context), /(?:outside|restricted)/i);
		const scoped = await bank.execute("source", { query: "needle", session: source }, undefined, undefined, { cwd: root, sessionManager: { getSessionFile: () => undefined, getLeafId: () => null } });
		assert.equal(scoped.details.path, source);
		assert.equal(calls(log).filter((args) => args[0] === "search").every((args) => args.includes("--path")), true);
	} finally {
		clearEnvironment();
		rmSync(root, { recursive: true, force: true });
	}
});

test("a null live leaf is empty and never falls back to a persisted leaf", async () => {
	const root = mkdtempSync(join(tmpdir(), "search-session-empty-"));
	try {
		const { cli, log } = fakeCatalog(root);
		const tool = toolsFor(cli, log).get("grep_current_session");
		const emptyContext = { ...context, sessionManager: { ...context.sessionManager, getLeafId: () => null } };
		const result = await tool.execute("empty", { query: "needle" }, undefined, undefined, emptyContext);
		assert.equal(result.details.matchCount, 0);
		assert.equal(calls(log).some((args) => args[0] === "search"), false);
	} finally {
		clearEnvironment();
		rmSync(root, { recursive: true, force: true });
	}
});

test("partial broad reconciliation opts in explicitly and keeps a persistent warning", async () => {
	const root = mkdtempSync(join(tmpdir(), "search-session-partial-"));
	try {
		const log = join(root, "calls.jsonl");
		const cli = join(root, "catalog");
		writeFileSync(cli, `#!/usr/bin/env python3
import json, os, sys
with open(os.environ['SESSION_STORE_TEST_LOG'], 'a') as f: f.write(json.dumps(sys.argv[1:]) + '\\n')
if sys.argv[1] == 'reconcile':
 print(json.dumps({'scopeComplete':False,'failures':[{'path':'bad'}]}))
 raise SystemExit(2)
elif sys.argv[1] == 'search':
 print(json.dumps({'results':[],'coverage':{'scopeComplete':False,'excludedFiles':1}}))
 raise SystemExit(1)
else: raise SystemExit(3)
`);
		chmodSync(cli, 0o700);
		const result = await toolsFor(cli, log).get("grep_session_bank").execute("partial", { query: "needle", global: true }, undefined, undefined, context);
		assert.match(result.content[0].text, /^WARNING:/);
		assert.match(result.content[0].text, /results are incomplete/);
		assert.equal(result.details.partial, true);
		const search = calls(log).find((args) => args[0] === "search");
		assert.ok(search.includes("--allow-partial"));
	} finally {
		clearEnvironment();
		rmSync(root, { recursive: true, force: true });
	}
});

test("grep_session_bank serves fresh rows when reconciliation succeeds but a missing catalog row remains", async () => {
	const root = mkdtempSync(join(tmpdir(), "search-session-stale-row-"));
	try {
		const log = join(root, "calls.jsonl"), cli = join(root, "catalog");
		writeFileSync(cli, `#!/usr/bin/env python3
import json, os, sys
with open(os.environ['SESSION_STORE_TEST_LOG'], 'a') as f: f.write(json.dumps(sys.argv[1:]) + '\\n')
if sys.argv[1] == 'search':
 if '--allow-partial' not in sys.argv: raise SystemExit('session store scope is incomplete: 1 stale file')
 print(json.dumps({'results':[], 'coverage':{'scopeComplete':False,'failureCount':1}}))
 raise SystemExit(1)
else: print(json.dumps({'scopeComplete':True,'failures':[]}))
`);
		chmodSync(cli, 0o700);
		const result = await toolsFor(cli, log).get("grep_session_bank").execute("stale", { query: "needle", global: true }, undefined, undefined, context);
		assert.equal(result.details.freshness.scopeComplete, true);
		assert.equal(result.details.partial, true);
		assert.match(result.content[0].text, /^WARNING:/);
		assert.ok(calls(log).find((args) => args[0] === "search").includes("--allow-partial"));
	} finally {
		clearEnvironment();
		rmSync(root, { recursive: true, force: true });
	}
});

test("output truncation is byte-safe, bounded, and preserves focused text", async () => {
	const root = mkdtempSync(join(tmpdir(), "search-session-output-"));
	try {
		const cli = join(root, "catalog");
		writeFileSync(cli, `#!/usr/bin/env python3
import json, sys
if sys.argv[1] == 'search':
 matches = [{'excerpt':('FOCUS-' if session == 0 and match == 0 else '') + 'x' * 320,'matchedEntryId':f'e{session}-{match}','matchedEntryRef':{'id':f'e{session}-{match}','ordinal':match,'byteStart':session*10000+match*100,'byteEnd':session*10000+match*100+50,'sourceSha256':'sha'}} for session in range(10) for match in range(50)]
 results = [{'path':f'/tmp/{session}.jsonl','id':f's{session}','cwd':'/tmp','matches':matches[session*50:(session+1)*50]} for session in range(10)]
 print(json.dumps({'results':results,'coverage':{'scopeComplete':True}}))
else: print(json.dumps({'scopeComplete':True}))
`);
		chmodSync(cli, 0o700);
		const result = await toolsFor(cli).get("grep_session_bank").execute("bounded", { query: "needle", global: true, limit: 10, maxMatches: 50 }, undefined, undefined, context);
		const text = result.content[0].text;
		assert.ok(Buffer.byteLength(text) <= 45 * 1024);
		assert.match(text, /FOCUS-/);
		assert.match(text, /Output stopped at the tool budget/);
	} finally {
		clearEnvironment();
		rmSync(root, { recursive: true, force: true });
	}
});

test("catalog failures stay fatal and timeout kills descendants after their leader exits", async () => {
	const root = mkdtempSync(join(tmpdir(), "session-store-error-test-"));
	try {
		const failing = join(root, "failing");
		writeFileSync(failing, "#!/bin/sh\necho missing database >&2\nexit 7\n");
		chmodSync(failing, 0o700);
		await assert.rejects(() => toolsFor(failing).get("grep_session_bank").execute("call", { query: "needle", global: true }, undefined, undefined, context), /missing database/);

		const started = Date.now();
		await assert.rejects(() => runBoundedProcess("/bin/sh", ["-c", "sleep 2 &"], { timeoutMs: 50 }), /timed out/);
		assert.ok(Date.now() - started < 750, `descendant survived for ${Date.now() - started}ms`);
	} finally {
		clearEnvironment();
		rmSync(root, { recursive: true, force: true });
	}
});

test("partial client receipts require opt-in, expected status, valid shape, and no stderr", async () => {
	const root = mkdtempSync(join(tmpdir(), "session-store-receipt-test-"));
	try {
		const cli = join(root, "catalog");
		const client = new SessionStoreClient(cli);
		const writeResponse = (body: string) => {
			writeFileSync(cli, `#!/usr/bin/env python3\nimport json, sys\n${body}\n`);
			chmodSync(cli, 0o700);
		};
		writeResponse("print(json.dumps({'scopeComplete':False,'failures':[]}))\nsys.exit(2)");
		await assert.rejects(() => client.reconcile({ all: true }), /exit 2/);
		assert.equal((await client.reconcile({ all: true }, undefined, { allowIncomplete: true })).scopeComplete, false);
		for (const body of [
			"print('{}')\nsys.exit(2)",
			"print('not json')\nsys.exit(2)",
			"print(json.dumps({'scopeComplete':False,'failures':[]}))\nsys.exit(7)",
			"print(json.dumps({'scopeComplete':False,'failures':[]}))\nsys.stderr.write('real error')\nsys.exit(2)",
		]) {
			writeResponse(body);
			await assert.rejects(() => client.reconcile({ all: true }, undefined, { allowIncomplete: true }), /command failed/);
		}
		writeResponse("print(json.dumps({'results':[],'coverage':{'scopeComplete':False}}))\nsys.exit(1)");
		await assert.rejects(() => client.list(), /exit 1/);
		await assert.rejects(() => client.search("needle"), /exit 1/);
		assert.equal((await client.list({ allowPartial: true })).coverage?.scopeComplete, false);
		assert.equal((await client.search("needle", { allowPartial: true })).coverage?.scopeComplete, false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

function actualCatalog(root: string) {
	const sessionsRoot = join(root, "sessions");
	const bucket = join(sessionsRoot, "--tmp-project--");
	mkdirSync(bucket, { recursive: true });
	const database = join(root, "session-store.sqlite3");
	const cli = join(root, "catalog-wrapper");
	const realCli = resolve("bin/pi-session-catalog");
	writeFileSync(cli, `#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
const split = args.indexOf('--');
const at = split < 0 ? args.length : split;
args.splice(at, 0, '--sessions-root', ${JSON.stringify(sessionsRoot)}, '--database', ${JSON.stringify(database)});
const result = spawnSync(process.execPath, [${JSON.stringify(realCli)}, ...args], { stdio: 'inherit' });
process.exit(result.status ?? 1);
`);
	chmodSync(cli, 0o700);
	return { cli, bucket };
}

test("actual backend excludes malformed sessions and still searches healthy sources", async () => {
	const root = mkdtempSync(join(tmpdir(), "search-session-partial-integration-"));
	try {
		const { cli, bucket } = actualCatalog(root);
		const source = join(bucket, "healthy.jsonl");
		writeFileSync(source, [
			{ type: "session", version: 3, id: "healthy", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/tmp/project" },
			{ type: "message", id: "needle", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: "uniquehealthyneedle", timestamp: 1767225601000 } },
		].map((row) => JSON.stringify(row)).join("\n") + "\n");
		writeFileSync(join(bucket, "malformed.jsonl"), '{"type":"message","id":"broken"}\n');
		const tools = toolsFor(cli);
		const result = await tools.get("grep_session_bank").execute("partial", { query: "uniquehealthyneedle", global: true }, undefined, undefined, context);
		assert.equal(result.details.partial, true);
		assert.equal(result.details.results.length, 1);
		assert.equal(result.details.results[0].path, source);
		assert.match(result.content[0].text, /^WARNING:/);
		await assert.rejects(() => new SessionStoreClient(cli).reconcile({ path: join(bucket, "malformed.jsonl") }), /exit 2/i);
	} finally {
		clearEnvironment();
		rmSync(root, { recursive: true, force: true });
	}
});

test("actual backend fixture returns an early Unicode match with an exact entry ref", async () => {
	const root = mkdtempSync(join(tmpdir(), "search-session-integration-"));
	try {
		const { cli, bucket } = actualCatalog(root);
		const source = join(bucket, "long.jsonl");
		const rows: any[] = [{ type: "session", version: 3, id: "long-session", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/tmp/project" }];
		let parentId: string | null = null;
		for (let index = 0; index < 1205; index++) {
			const id = `e${String(index).padStart(7, "0")}`;
			rows.push({ type: "message", id, parentId, timestamp: new Date(1767225600000 + index).toISOString(), message: { role: index % 2 ? "assistant" : "user", content: index === 2 ? "Решение λήμμα уникално" : `ordinary ${index}`, timestamp: 1767225600000 + index } });
			parentId = id;
		}
		writeFileSync(source, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
		const tools = toolsFor(cli);
		const fixtureContext = { cwd: "/tmp/project", sessionManager: { getSessionFile: () => source, getLeafId: () => parentId } };
		const result = await tools.get("grep_current_session").execute("integration", { query: "λήμμα", maxMatches: 5 }, undefined, undefined, fixtureContext);
		assert.equal(result.details.matchCount, 1);
		assert.match(result.content[0].text, /Решение λήμμα уникално/i);
		assert.match(result.content[0].text, /matchedEntryRef=.*byteStart.*sourceSha256/);
		const hit = result.details.matches[0];
		assert.equal(typeof hit.matchedEntryRef.byteStart, "number");
		const exact = await tools.get("read_session").execute("exact", { entry: hit.matchedEntryId, byteStart: hit.matchedEntryRef.byteStart, before: 0, after: 0 }, undefined, undefined, fixtureContext);
		assert.match(exact.content[0].text, /entryRef=.*byteStart.*sourceSha256/);
		assert.match(exact.content[0].text, /λήμμα/i);
	} finally {
		clearEnvironment();
		rmSync(root, { recursive: true, force: true });
	}
});

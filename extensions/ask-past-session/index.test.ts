import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import askSessionExtension from "./index.ts";
import { SESSION_SOURCE_PATH_ENV } from "../lib/session-store-client.ts";
import { UPSTREAM_SESSION_REFS_ENV } from "../lib/upstream-session-refs.ts";

function registerTools(catalog: string) {
	process.env.PI_SESSION_CATALOG_CLI = catalog;
	const tools = new Map<string, any>();
	askSessionExtension({ registerTool(tool: any) { tools.set(tool.name, tool); } } as ExtensionAPI);
	return tools;
}

function writeCatalog(root: string, source: string, sourceCwd = root, incomplete = false, noMatches = false, shortQuery?: string) {
	const cli = join(root, "catalog");
	writeFileSync(cli, `#!/usr/bin/env python3
import json, os, sys
with open(os.environ['ASK_SESSION_CATALOG_LOG'], 'a') as f: f.write(json.dumps(sys.argv[1:]) + '\\n')
command = sys.argv[1]
ref = {'id':'match','ordinal':4,'byteStart':400,'byteEnd':450,'sourceSha256':'match-sha'}
if command == 'search':
 print(json.dumps({'results':[] if ${noMatches ? 'True' : shortQuery ? `sys.argv[-1] != ${JSON.stringify(shortQuery)}` : 'False'} else [{'path':${JSON.stringify(source)},'id':'past-id','cwd':${JSON.stringify(sourceCwd)},'name':'Past session','created':'2026-01-01T00:00:00Z','modified':'2026-01-02T00:00:00Z','messageCount':4,'firstMessage':'question','excerpt':'initial answer','matchedEntryId':'match','matchedEntryRef':ref,'matchedRole':'assistant'}], 'coverage':{'scopeComplete':${incomplete ? 'False' : 'True'}}}))
elif command == 'read':
 print(json.dumps({'entries':[{'id':'match','entryRef':ref,'parentId':None,'type':'message','role':'assistant','text':'initial answer'},{'id':'correction','entryRef':{'id':'correction','ordinal':5,'byteStart':451,'byteEnd':500,'sourceSha256':'correction-sha'},'parentId':'match','type':'message','role':'assistant','text':'later correction wins'}], 'coverage':{'scopeComplete':True}}))
else:
 print(json.dumps({'scopeComplete':${incomplete ? "False" : "True"}, 'failures':${incomplete ? "[{'path':'bad'}]" : "[]"}}))
${incomplete ? "sys.exit(2 if command == 'reconcile' else 1 if command == 'search' else 0)" : ""}
`);
	chmodSync(cli, 0o700);
	return cli;
}

function writePi(root: string) {
	const bin = join(root, "bin");
	mkdirSync(bin);
	const pi = join(bin, "pi");
	writeFileSync(pi, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.writeFileSync(process.env.ASK_SESSION_PI_LOG, JSON.stringify({ args, cwd: process.cwd(), source: process.env.PI_SESSION_SOURCE_PATH, upstreamRefs: process.env.PI_UPSTREAM_SESSION_REFS }));
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const message = { role: 'assistant', content: [{ type: 'text', text: 'oracle answer' }], api: 'fake', provider: 'fake', model: 'fake', usage, stopReason: 'stop', timestamp: Date.now() };
process.stdout.write(JSON.stringify({ type: 'message_end', message }) + '\\n');
`);
	chmodSync(pi, 0o700);
	return bin;
}

const context = { cwd: "/tmp/current", model: { provider: "codex-pi1" } };

function cleanup(root: string, previousPath: string | undefined, previousRefs: string | undefined) {
	if (previousPath === undefined) delete process.env.PATH;
	else process.env.PATH = previousPath;
	if (previousRefs === undefined) delete process.env[UPSTREAM_SESSION_REFS_ENV];
	else process.env[UPSTREAM_SESSION_REFS_ENV] = previousRefs;
	delete process.env.PI_SESSION_CATALOG_CLI;
	delete process.env.ASK_SESSION_CATALOG_LOG;
	delete process.env.ASK_SESSION_PI_LOG;
	delete process.env[SESSION_SOURCE_PATH_ENV];
	rmSync(root, { recursive: true, force: true });
}

test("ask_session requires an exact source; search_context owns discovery", async () => {
	const root = mkdtempSync(join(tmpdir(), "ask-session-contract-"));
	const previousPath = process.env.PATH;
	const previousRefs = process.env[UPSTREAM_SESSION_REFS_ENV];
	try {
		const source = join(root, "source.jsonl");
		const catalogLog = join(root, "catalog.jsonl");
		process.env.ASK_SESSION_CATALOG_LOG = catalogLog;
		const tools = registerTools(writeCatalog(root, source));
		assert.deepEqual([...tools.keys()].sort(), ["ask_session", "search_context"]);
		assert.ok(tools.get("ask_session").parameters.required.includes("session"));
		assert.equal(tools.get("search_context").parameters.properties.session, undefined);
		for (const key of ["cwd", "sinceHours", "sessionHint", "limit"]) assert.equal(tools.get("ask_session").parameters.properties[key], undefined, `ask_session must not discover via ${key}`);
		await assert.rejects(() => tools.get("ask_session").execute("missing", { query: "Question" }, undefined, undefined, context), /(?:session|source)/i);
		assert.equal(existsSync(catalogLog), false, "missing exact source must fail before catalog access");
		await tools.get("search_context").execute("discover", { query: "Question", dryRun: true }, undefined, undefined, context);
		const observed = readFileSync(catalogLog, "utf8").trim().split("\n").map((line) => JSON.parse(line));
		assert.ok(observed.some((args) => args[0] === "reconcile" && args.includes("--all")));
		assert.ok(observed.some((args) => args[0] === "search" && !args.includes("--path")));
	} finally {
		cleanup(root, previousPath, previousRefs);
	}
});

test("ask_session child receives only hard-scoped session tools and a single source env", async () => {
	const root = mkdtempSync(join(tmpdir(), "ask-session-evidence-"));
	const previousPath = process.env.PATH;
	const previousRefs = process.env[UPSTREAM_SESSION_REFS_ENV];
	try {
		const source = join(root, "source.jsonl");
		writeFileSync(source, JSON.stringify({ type: "session", version: 3, id: "source-id", timestamp: new Date().toISOString(), cwd: root }) + "\n");
		const catalogLog = join(root, "catalog.jsonl");
		const piLog = join(root, "pi.json");
		process.env.ASK_SESSION_CATALOG_LOG = catalogLog;
		process.env.ASK_SESSION_PI_LOG = piLog;
		process.env[UPSTREAM_SESSION_REFS_ENV] = JSON.stringify({ sibling: "/tmp/sibling.jsonl" });
		process.env.PATH = `${writePi(root)}:${previousPath ?? ""}`;
		const tools = registerTools(writeCatalog(root, source));
		const result = await tools.get("ask_session").execute("call", { query: "What was decided?", session: source }, undefined, undefined, { ...context, cwd: root });
		assert.match(result.content[0].text, /^oracle answer/);
		assert.equal(result.details.oracleMode, "source-restricted-expandable-evidence");
		const catalogCalls = readFileSync(catalogLog, "utf8").trim().split("\n").map((line) => JSON.parse(line));
		const read = catalogCalls.find((args) => args[0] === "read");
		assert.equal(read[read.indexOf("--entry") + 1], "match");
		assert.equal(read[read.indexOf("--byte-start") + 1], "400");
		const child = JSON.parse(readFileSync(piLog, "utf8"));
		assert.equal(child.args[child.args.indexOf("--tools") + 1], "grep_session_bank,read_session");
		assert.equal(child.source, source);
		assert.equal(child.upstreamRefs, undefined);
		const prompt = child.args[child.args.indexOf("-p") + 1];
		assert.match(prompt, /deterministic tool-level source scoping, not an operating-system sandbox/);
		assert.match(prompt, /Cite supporting full entryRef objects/);
		assert.match(prompt, /grep_session_bank/);
	} finally {
		cleanup(root, previousPath, previousRefs);
	}
});

test("search_context partial discovery forwards allow-partial and never claims a definitive no-match", async () => {
	const root = mkdtempSync(join(tmpdir(), "ask-session-partial-"));
	const previousPath = process.env.PATH;
	const previousRefs = process.env[UPSTREAM_SESSION_REFS_ENV];
	try {
		const source = join(root, "source.jsonl");
		const catalogLog = join(root, "catalog.jsonl");
		process.env.ASK_SESSION_CATALOG_LOG = catalogLog;
		const tools = registerTools(writeCatalog(root, source, root, true));
		const result = await tools.get("search_context").execute("call", { query: "Question", sinceHours: 6, limit: 2, dryRun: true }, undefined, undefined, context);
		assert.match(result.content[0].text, /^WARNING:/);
		assert.equal(result.details.partial, true);
		const observed = readFileSync(catalogLog, "utf8").trim().split("\n").map((line) => JSON.parse(line));
		const search = observed.find((args) => args[0] === "search");
		assert.equal(search[search.indexOf("--since-hours") + 1], "6");
		assert.equal(search[search.indexOf("--limit") + 1], "2");
		assert.ok(search.includes("--allow-partial"));
	} finally {
		cleanup(root, previousPath, previousRefs);
	}
});

test("search_context serves fresh rows when reconciliation succeeds but an old catalog row remains stale", async () => {
	const root = mkdtempSync(join(tmpdir(), "search-context-stale-row-"));
	const previousPath = process.env.PATH;
	const previousRefs = process.env[UPSTREAM_SESSION_REFS_ENV];
	try {
		const cli = join(root, "catalog"), log = join(root, "catalog.jsonl");
		process.env.ASK_SESSION_CATALOG_LOG = log;
		writeFileSync(cli, `#!/usr/bin/env python3
import json, os, sys
with open(os.environ['ASK_SESSION_CATALOG_LOG'], 'a') as f: f.write(json.dumps(sys.argv[1:]) + '\\n')
if sys.argv[1] == 'search':
 if '--allow-partial' not in sys.argv: raise SystemExit('session store scope is incomplete: 1 stale file')
 print(json.dumps({'results':[], 'coverage':{'scopeComplete':False,'failureCount':1}}))
 raise SystemExit(1)
else: print(json.dumps({'scopeComplete':True,'failures':[]}))
`);
		chmodSync(cli, 0o700);
		const result = await registerTools(cli).get("search_context").execute("stale", { query: "unmatched", dryRun: true }, undefined, undefined, context);
		assert.equal(result.details.freshness.scopeComplete, true);
		assert.equal(result.details.partial, true);
		assert.match(result.content[0].text, /^WARNING:/);
		const searches = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line)).filter((args) => args[0] === "search");
		assert.ok(searches.length > 0 && searches.every((args) => args.includes("--allow-partial")));
	} finally {
		cleanup(root, previousPath, previousRefs);
	}
});

test("deleted historical cwd falls back to the caller cwd", async () => {
	const root = mkdtempSync(join(tmpdir(), "ask-session-cwd-"));
	const previousPath = process.env.PATH;
	const previousRefs = process.env[UPSTREAM_SESSION_REFS_ENV];
	try {
		const source = join(root, "source.jsonl");
		writeFileSync(source, JSON.stringify({ type: "session", version: 3, id: "source-id", timestamp: new Date().toISOString(), cwd: root }) + "\n");
		const catalogLog = join(root, "catalog.jsonl");
		const piLog = join(root, "pi.json");
		process.env.ASK_SESSION_CATALOG_LOG = catalogLog;
		process.env.ASK_SESSION_PI_LOG = piLog;
		process.env.PATH = `${writePi(root)}:${previousPath ?? ""}`;
		const tools = registerTools(writeCatalog(root, source, join(root, "deleted-project")));
		const result = await tools.get("ask_session").execute("call", { query: "Question", session: source }, undefined, undefined, { ...context, cwd: root });
		assert.match(result.content[0].text, /^oracle answer/);
		assert.equal(realpathSync(JSON.parse(readFileSync(piLog, "utf8")).cwd), realpathSync(root));
		assert.equal(result.details.oracleCwd, root);
	} finally {
		cleanup(root, previousPath, previousRefs);
	}
});

test("exact fan-in targeting preserves verified ID resolution and exact match refs", async () => {
	const root = mkdtempSync(join(tmpdir(), "ask-session-exact-"));
	const previousPath = process.env.PATH;
	const previousRefs = process.env[UPSTREAM_SESSION_REFS_ENV];
	try {
		const source = join(root, "source.jsonl");
		writeFileSync(source, JSON.stringify({ type: "session", version: 3, id: "upstream-id", timestamp: new Date().toISOString(), cwd: root }) + "\n");
		const catalogLog = join(root, "catalog.jsonl");
		process.env.ASK_SESSION_CATALOG_LOG = catalogLog;
		process.env[UPSTREAM_SESSION_REFS_ENV] = JSON.stringify({ "upstream-id": source });
		const tools = registerTools(writeCatalog(root, source));
		const result = await tools.get("ask_session").execute("call", { query: "Question", session: "upstream-id", dryRun: true }, undefined, undefined, context);
		assert.equal(result.details.candidates[0].id, "upstream-id");
		assert.equal(result.details.candidates[0].matchedEntryRef.byteStart, 400);
		const observed = readFileSync(catalogLog, "utf8").trim().split("\n").map((line) => JSON.parse(line));
		assert.deepEqual(observed[0].slice(0, 3), ["reconcile", "--path", source]);
		const search = observed.find((args) => args[0] === "search");
		assert.equal(search[search.indexOf("--path") + 1], source);
		assert.equal(observed.some((args) => args[0] === "read"), false);
		assert.equal(observed.some((args) => args[0] === "reconcile" && (args.includes("--all") || args.includes("--cwd"))), false);
	} finally {
		cleanup(root, previousPath, previousRefs);
	}
});

test("search_context launches an ephemeral Luna/low worker with broad tools and no source restriction", async () => {
	const root = mkdtempSync(join(tmpdir(), "search-context-worker-"));
	const previousPath = process.env.PATH;
	const previousRefs = process.env[UPSTREAM_SESSION_REFS_ENV];
	try {
		const source = join(root, "past.jsonl");
		const catalogLog = join(root, "catalog.jsonl");
		const piLog = join(root, "pi.json");
		process.env.ASK_SESSION_CATALOG_LOG = catalogLog;
		process.env.ASK_SESSION_PI_LOG = piLog;
		process.env[UPSTREAM_SESSION_REFS_ENV] = JSON.stringify({ sibling: "/tmp/sibling.jsonl" });
		process.env.PATH = `${writePi(root)}:${previousPath ?? ""}`;
		const tools = registerTools(writeCatalog(root, source));
		const result = await tools.get("search_context").execute("worker", { query: "What changed?" }, undefined, undefined, { ...context, cwd: root });
		assert.equal(result.content[0].text, "oracle answer");
		assert.equal(result.details.partial, false);
		assert.equal(result.details.candidates.length, 1);
		assert.equal(result.details.model, "fake/fake");
		assert.equal(result.usage.totalTokens, 2);
		const child = JSON.parse(readFileSync(piLog, "utf8"));
		assert.ok(child.args.includes("--no-extensions"));
		assert.ok(child.args.includes("--no-session"));
		assert.equal(child.args.includes("--session"), false);
		assert.equal(child.args[child.args.indexOf("--model") + 1], "codex-pi1/gpt-6-luna");
		assert.equal(child.args[child.args.indexOf("--thinking") + 1], "low");
		assert.equal(child.args[child.args.indexOf("--tools") + 1], "grep_session_bank,read_session,ask_session,read,bash");
		assert.equal(child.source, undefined);
		assert.equal(child.upstreamRefs, undefined);
		const prompt = child.args[child.args.indexOf("-p") + 1];
		assert.match(prompt, /What changed\?/);
		assert.match(prompt, /Initial lexical candidates:/);
		assert.match(prompt, /entryRef=.*byteStart.*400/);
		assert.match(prompt, /physical session paths and full entryRef objects/);
		assert.match(prompt, /mode=bm25 and two or three distinctive terms/);
		assert.match(prompt, /Scope phrase\/regex to a known session/);
		assert.equal(realpathSync(child.cwd), realpathSync(root));
	} finally {
		cleanup(root, previousPath, previousRefs);
	}
});

test("search_context partial coverage persists in both worker prompt and answer", async () => {
	const root = mkdtempSync(join(tmpdir(), "search-context-worker-partial-"));
	const previousPath = process.env.PATH;
	const previousRefs = process.env[UPSTREAM_SESSION_REFS_ENV];
	try {
		const catalogLog = join(root, "catalog.jsonl");
		const piLog = join(root, "pi.json");
		process.env.ASK_SESSION_CATALOG_LOG = catalogLog;
		process.env.ASK_SESSION_PI_LOG = piLog;
		process.env.PATH = `${writePi(root)}:${previousPath ?? ""}`;
		const tools = registerTools(writeCatalog(root, join(root, "past.jsonl"), root, true));
		const result = await tools.get("search_context").execute("partial", { query: "Question", cwd: root }, undefined, undefined, { ...context, cwd: root });
		assert.equal(result.details.partial, true);
		assert.match(result.content[0].text, /^WARNING:.*discovery is incomplete/);
		assert.match(result.content[0].text, /oracle answer/);
		const child = JSON.parse(readFileSync(piLog, "utf8"));
		assert.match(child.args[child.args.indexOf("-p") + 1], /WARNING:.*discovery is incomplete/);
		const calls = readFileSync(catalogLog, "utf8").trim().split("\n").map((line) => JSON.parse(line));
		assert.ok(calls.some((args) => args[0] === "search" && args.includes("--allow-partial")));
	} finally {
		cleanup(root, previousPath, previousRefs);
	}
});

test("search_context initial discovery retries a distinctive two-word query after a verbose BM25 miss", async () => {
	const root = mkdtempSync(join(tmpdir(), "search-context-short-fallback-"));
	const previousPath = process.env.PATH;
	const previousRefs = process.env[UPSTREAM_SESSION_REFS_ENV];
	try {
		const log = join(root, "catalog.jsonl");
		process.env.ASK_SESSION_CATALOG_LOG = log;
		const tool = registerTools(writeCatalog(root, join(root, "past.jsonl"), root, false, false, "TiDAR LoRA")).get("search_context");
		const result = await tool.execute("fallback", { query: "Find the original TiDAR LoRA decision from our earlier discussion", dryRun: true }, undefined, undefined, context);
		const searches = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line)).filter((args) => args[0] === "search");
		assert.equal(searches[0].at(-1), "Find the original TiDAR LoRA decision from our earlier discussion");
		assert.ok(searches.some((args) => args.at(-1) === "TiDAR LoRA"), "retry initial discovery with the two distinctive terms");
		assert.ok(searches.every((args) => !args.includes("--include-tools")), "initial discovery must not match echoes of its own query in tool calls");
		assert.equal(result.details.candidates[0].matchedEntryId, "match");
		assert.match(result.content[0].text, /initial answer/);
	} finally {
		cleanup(root, previousPath, previousRefs);
	}
});

test("search_context still launches a worker when lexical discovery has no candidates", async () => {
	const root = mkdtempSync(join(tmpdir(), "search-context-no-candidates-"));
	const previousPath = process.env.PATH;
	const previousRefs = process.env[UPSTREAM_SESSION_REFS_ENV];
	try {
		const piLog = join(root, "pi.json");
		process.env.ASK_SESSION_CATALOG_LOG = join(root, "catalog.jsonl");
		process.env.ASK_SESSION_PI_LOG = piLog;
		process.env.PATH = `${writePi(root)}:${previousPath ?? ""}`;
		const tools = registerTools(writeCatalog(root, join(root, "unmatched.jsonl"), root, false, true));
		const result = await tools.get("search_context").execute("empty", { query: "Find an unindexed synonym" }, undefined, undefined, { ...context, cwd: root });
		assert.deepEqual(result.details.candidates, []);
		assert.equal(result.content[0].text, "oracle answer");
		const prompt = JSON.parse(readFileSync(piLog, "utf8")).args.at(-1);
		assert.match(prompt, /Find an unindexed synonym/);
		assert.match(prompt, /initial candidates as hints, not a completeness boundary/);
	} finally {
		cleanup(root, previousPath, previousRefs);
	}
});

test("a source-restricted ask_session refuses other paths and fan-in IDs before catalog or child launch", async () => {
	const root = mkdtempSync(join(tmpdir(), "ask-session-source-boundary-"));
	const previousPath = process.env.PATH;
	const previousRefs = process.env[UPSTREAM_SESSION_REFS_ENV];
	try {
		const source = join(root, "source.jsonl");
		const other = join(root, "other.jsonl");
		for (const [file, id] of [[source, "source-id"], [other, "other-id"]]) {
			writeFileSync(file, JSON.stringify({ type: "session", version: 3, id, timestamp: new Date().toISOString(), cwd: root }) + "\n");
		}
		const catalogLog = join(root, "catalog.jsonl");
		const piLog = join(root, "pi.json");
		process.env.ASK_SESSION_CATALOG_LOG = catalogLog;
		process.env.ASK_SESSION_PI_LOG = piLog;
		process.env[SESSION_SOURCE_PATH_ENV] = source;
		process.env[UPSTREAM_SESSION_REFS_ENV] = JSON.stringify({ "other-id": other });
		process.env.PATH = `${writePi(root)}:${previousPath ?? ""}`;
		const tools = registerTools(writeCatalog(root, source));
		for (const session of [other, "other-id"]) {
			await assert.rejects(() => tools.get("ask_session").execute("blocked", { query: "Question", session }, undefined, undefined, { ...context, cwd: root }), /another source session/);
		}
		assert.equal(existsSync(catalogLog), false, "rejected sources must not reach catalog");
		assert.equal(existsSync(piLog), false, "rejected sources must not launch a model");
		await assert.rejects(() => tools.get("search_context").execute("blocked", { query: "Question" }, undefined, undefined, { ...context, cwd: root }), /source-restricted child/);
		assert.equal(existsSync(catalogLog), false);
		const allowed = await tools.get("ask_session").execute("allowed", { query: "Question", session: source, dryRun: true }, undefined, undefined, { ...context, cwd: root });
		assert.equal(allowed.details.candidates[0].file, source);
		assert.equal(existsSync(piLog), false);
	} finally {
		cleanup(root, previousPath, previousRefs);
	}
});

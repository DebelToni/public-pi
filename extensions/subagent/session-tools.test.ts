import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import askSessionExtension from "../ask-past-session/index.ts";
import { SESSION_SOURCE_PATH_ENV } from "../lib/session-store-client.ts";
import { resolveSessionReference, UPSTREAM_SESSION_REFS_ENV } from "../lib/upstream-session-refs.ts";
import searchSessionExtension from "../search-session/index.ts";

function writeSession(filePath: string, id: string, cwd: string) {
	writeFileSync(filePath, [
		JSON.stringify({ type: "session", version: 3, id, timestamp: new Date().toISOString(), cwd }),
		JSON.stringify({ type: "message", id: "message-1", parentId: null, timestamp: new Date().toISOString(), message: { role: "assistant", content: [{ type: "text", text: "upstream searchable needle" }], timestamp: Date.now() } }),
	].join("\n") + "\n");
}

function fakeCatalog(root: string, source: string) {
	const cli = path.join(root, "catalog");
	writeFileSync(cli, `#!/usr/bin/env python3
import json, pathlib, sys
ref = {'id':'message-1','ordinal':1,'byteStart':100,'byteEnd':200,'sourceSha256':'sha'}
if sys.argv[1] == 'search': print(json.dumps({'results':[{'path':${JSON.stringify(source)},'id':'search-upstream','cwd':${JSON.stringify(root)},'excerpt':'upstream searchable needle','matchedEntryId':'message-1','matchedEntryRef':ref,'matchedRole':'assistant'}], 'coverage':{'scopeComplete':True}}))
elif sys.argv[1] == 'read': print(json.dumps({'entries':[{'id':'message-1','entryRef':ref,'type':'message','role':'assistant','text':'upstream searchable needle'}], 'coverage':{'scopeComplete':True}}))
else: print(json.dumps({'scopeComplete':True}))
`);
	chmodSync(cli, 0o700);
	return cli;
}

function cleanEnv(previousRefs: string | undefined, previousPath?: string) {
	if (previousRefs === undefined) delete process.env[UPSTREAM_SESSION_REFS_ENV];
	else process.env[UPSTREAM_SESSION_REFS_ENV] = previousRefs;
	if (previousPath !== undefined) process.env.PATH = previousPath;
	delete process.env.PI_SESSION_CATALOG_CLI;
	delete process.env.PI_ASK_SESSION_TEST_LOG;
	delete process.env[SESSION_SOURCE_PATH_ENV];
}

test("fan-in session references resolve only through the scoped ID mapping and verify headers", () => {
	const root = mkdtempSync(path.join(os.tmpdir(), "pi-upstream-ref-"));
	try {
		const file = path.join(root, "session.jsonl");
		writeSession(file, "upstream-id", root);
		const env = JSON.stringify({ "upstream-id": file });
		assert.deepEqual(resolveSessionReference("upstream-id", env), { filePath: file, sessionId: "upstream-id" });
		assert.throws(() => resolveSessionReference("wrong-id", JSON.stringify({ "wrong-id": file })), /mapping mismatch/);
		assert.throws(() => resolveSessionReference("unknown-id", env), /Session file not found/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("grep_session_bank targets an upstream transcript by fan-in session ID", async () => {
	const root = mkdtempSync(path.join(os.tmpdir(), "pi-upstream-search-"));
	const previous = process.env[UPSTREAM_SESSION_REFS_ENV];
	try {
		const file = path.join(root, "session.jsonl");
		writeSession(file, "search-upstream", root);
		process.env[UPSTREAM_SESSION_REFS_ENV] = JSON.stringify({ "search-upstream": file });
		process.env.PI_SESSION_CATALOG_CLI = fakeCatalog(root, file);
		let tool: any;
		searchSessionExtension({ registerTool(value: any) { if (value.name === "grep_session_bank") tool = value; } } as ExtensionAPI);
		const result = await tool.execute("search-call", { query: "searchable needle", session: "search-upstream" }, undefined, undefined, {
			cwd: root,
			sessionManager: { getSessionFile: () => undefined, getLeafId: () => null },
		});
		assert.match(result.content[0].text, /upstream searchable needle/);
		assert.match(result.content[0].text, /matchedEntryRef=.*byteStart/);
		assert.equal(result.details.sessionId, "search-upstream");
		assert.equal(result.details.path, file);
	} finally {
		cleanEnv(previous);
		rmSync(root, { recursive: true, force: true });
	}
});

test("ask_session exact targeting uses no-session evidence mode with one authorized source", async () => {
	const root = mkdtempSync(path.join(os.tmpdir(), "pi-upstream-oracle-"));
	const previousRefs = process.env[UPSTREAM_SESSION_REFS_ENV];
	const previousPath = process.env.PATH;
	try {
		const source = path.join(root, "source.jsonl");
		writeSession(source, "oracle-upstream", root);
		const bin = path.join(root, "bin");
		mkdirSync(bin);
		const fakePi = path.join(bin, "pi");
		writeFileSync(fakePi, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.writeFileSync(process.env.PI_ASK_SESSION_TEST_LOG, JSON.stringify({ args, source: process.env.PI_SESSION_SOURCE_PATH, refs: process.env.PI_UPSTREAM_SESSION_REFS }));
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const message = { role: "assistant", content: [{ type: "text", text: "oracle-result" }], api: "fake", provider: "fake", model: "fake", usage, stopReason: "stop", timestamp: Date.now() };
process.stdout.write(JSON.stringify({ type: "message_end", message }) + "\\n");
`);
		chmodSync(fakePi, 0o700);
		const log = path.join(root, "oracle.json");
		process.env[UPSTREAM_SESSION_REFS_ENV] = JSON.stringify({ "oracle-upstream": source, sibling: "/tmp/sibling" });
		process.env.PI_ASK_SESSION_TEST_LOG = log;
		process.env.PI_SESSION_CATALOG_CLI = fakeCatalog(root, source);
		process.env.PATH = `${bin}:${previousPath ?? ""}`;
		const tools = new Map<string, any>();
		askSessionExtension({ registerTool(value: any) { tools.set(value.name, value); } } as ExtensionAPI);
		const result = await tools.get("ask_session").execute("ask-call", { query: "specific question", session: "oracle-upstream" }, undefined, () => {}, { cwd: root, model: { provider: "codex-pi1" } });
		assert.match(result.content[0].text, /^oracle-result/);
		const observed = JSON.parse(readFileSync(log, "utf8"));
		assert.ok(observed.args.includes("--no-session"));
		assert.equal(observed.args.includes("--session"), false);
		assert.equal(observed.args[observed.args.indexOf("--tools") + 1], "grep_session_bank,read_session");
		assert.equal(observed.source, source);
		assert.equal(observed.refs, undefined);
		assert.equal(readFileSync(source, "utf8").includes("upstream searchable needle"), true);
	} finally {
		cleanEnv(previousRefs, previousPath);
		rmSync(root, { recursive: true, force: true });
	}
});

test("ask_session stays exact-source and search_context offers discovery", async () => {
	const root = mkdtempSync(path.join(os.tmpdir(), "pi-upstream-ask-"));
	const previous = process.env[UPSTREAM_SESSION_REFS_ENV];
	try {
		const file = path.join(root, "session.jsonl");
		writeSession(file, "ask-upstream", root);
		process.env[UPSTREAM_SESSION_REFS_ENV] = JSON.stringify({ "ask-upstream": file });
		process.env.PI_SESSION_CATALOG_CLI = fakeCatalog(root, file);
		const tools = new Map<string, any>();
		askSessionExtension({ registerTool(value: any) { tools.set(value.name, value); } } as ExtensionAPI);
		assert.deepEqual([...tools.keys()].sort(), ["ask_session", "search_context"]);
		const result = await tools.get("ask_session").execute("ask-call", { query: "What happened?", session: "ask-upstream", dryRun: true }, undefined, undefined, { cwd: root, model: { provider: "codex-pi1" } });
		assert.equal(result.details.candidates[0].id, "ask-upstream");
		assert.equal(result.details.candidates[0].file, file);
	} finally {
		cleanEnv(previous);
		rmSync(root, { recursive: true, force: true });
	}
});

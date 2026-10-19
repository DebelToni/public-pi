import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const root = process.env.PI_CODEX_ULTRA_RELEASE_ROOT || resolve(process.env.HOME, "repos/pi-codex-ultra");
process.env.PI_CODEX_ULTRA_RELEASE_ROOT = root;
const { createSessionCatalogBoundary } = await import("../lib/session-catalog/ultra-client.mjs");
const command = resolve(root, "tests/fixtures/session-catalog-cli.mjs");
const coverage = { scopeComplete: true, failureCount: 0, excludedFiles: 0, failedScopes: 0 };

function fixture(t, extra = {}) {
	const dir = mkdtempSync(join(tmpdir(), "ultra-local-resume-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const log = join(dir, "calls.jsonl"), file = join(dir, "session.jsonl");
	writeFileSync(file, "{}\n");
	const item = { path: file, id: "session", cwd: "/project", created: "2026-01-01T00:00:00Z", modified: "2026-01-02T00:00:00Z", messageCount: 1, firstMessage: "hello" };
	const env = { ...process.env, CATALOG_FIXTURE_LOG: log,
		CATALOG_FIXTURE_LIST: JSON.stringify({ results: [item], coverage }),
		CATALOG_FIXTURE_SEARCH: JSON.stringify({ results: [item], coverage }), ...extra };
	return { log, file, env };
}
function calls(file) { return existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : []; }

test("the Anton-only Ultra bridge loads the personal adapter in a fresh process", () => {
	const script = `import { createSessionCatalogBoundary } from ${JSON.stringify(pathToFileURL(join(root, "suite/runtime/session-catalog-bridge.mjs")).href)}; console.log(JSON.stringify({status:globalThis[Symbol.for("pi-codex-ultra.session-catalog-client.v1")],disabled:createSessionCatalogBoundary({enabled:false})}));`;
	const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
		encoding: "utf8", env: { ...process.env, PI_CODEX_ULTRA_PROFILE_ID: "anton", PI_CODEX_ULTRA_RELEASE_ROOT: root },
	});
	assert.equal(result.status, 0, result.stderr);
	assert.equal(JSON.parse(result.stdout).status.source, "local");
});

test("snapshot is selectable before slow reconciliation finishes; search does not start a second reconcile", async (t) => {
	const f = fixture(t, { CATALOG_FIXTURE_SLOW_COMMAND: "reconcile", CATALOG_FIXTURE_SLOW_MS: "400" });
	const boundary = createSessionCatalogBoundary({ cwd: "/project", command, env: f.env });
	const progress = [];
	const pending = boundary.loadCurrent((loaded, total, sessions) => progress.push({ loaded, total, sessions }));
	for (let n = 0; n < 100 && !progress.length; n++) await new Promise((r) => setTimeout(r, 10));
	assert.equal(progress[0].sessions[0].path, f.file);
	assert.equal(progress[0].loaded, 0);
	const searched = await boundary.search("hello", { scope: "current", sortMode: "recent", nameFilter: "all" });
	assert.equal(searched[0].path, f.file);
	assert.ok(calls(f.log).find(({ args }) => args[0] === "search").args.includes("--title-first"));
	const fresh = await pending;
	assert.equal(fresh[0].path, f.file);
	assert.equal(calls(f.log).filter(({ args }) => args[0] === "reconcile").length, 1);
});

test("only unquoted resume searches enable fuzzy title priority; sort, scope and named filters survive", async (t) => {
	const f = fixture(t);
	const boundary = createSessionCatalogBoundary({ cwd: "/project", command, env: f.env });
	for (const raw of ["keyword", '"exact phrase"', "re:pattern"]) {
		await boundary.search(raw, { scope: "all", sortMode: "recent", nameFilter: "named" });
	}
	const searches = calls(f.log).filter(({ args }) => args[0] === "search");
	assert.equal(searches.length, 3);
	for (const [index, { args }] of searches.entries()) {
		assert.equal(args.includes("--title-first"), index === 0);
		assert.ok(args.includes("--named-only"));
		assert.equal(args[args.indexOf("--sort") + 1], "recent");
		assert.ok(!args.includes("--cwd"));
	}
});

test("refresh failure retains the snapshot and warns; aborted refresh does not return stale rows", async (t) => {
	const f = fixture(t, { CATALOG_FIXTURE_FAIL: "reconcile" });
	const boundary = createSessionCatalogBoundary({ cwd: "/project", command, env: f.env });
	const retained = await boundary.loadCurrent();
	assert.equal(retained[0].path, f.file);
	assert.match(retained.catalogWarning, /Catalog refresh failed/);
	const slow = fixture(t, { CATALOG_FIXTURE_SLOW_COMMAND: "reconcile", CATALOG_FIXTURE_SLOW_MS: "4000" });
	const active = createSessionCatalogBoundary({ cwd: "/project", command, env: slow.env });
	const controller = new AbortController();
	const pending = active.loadCurrent(undefined, controller.signal);
	for (let n = 0; n < 100 && !calls(slow.log).some(({ args }) => args[0] === "reconcile"); n++) await new Promise((r) => setTimeout(r, 10));
	controller.abort();
	await assert.rejects(pending, (error) => error.name === "AbortError");
});

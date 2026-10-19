import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, test } from "bun:test";
import { codexWireModelId } from "./codex-long-context.ts";

const keys = ["PI_CODEX_ULTRA_RELEASE_ROOT", "PI_CODEX_ULTRA_HOME", "XDG_DATA_HOME"] as const;
const original = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
const roots: string[] = [];
afterEach(() => {
	for (const key of keys) {
		if (original[key] === undefined) delete process.env[key]; else process.env[key] = original[key];
	}
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
	const root = mkdtempSync(join(homedir(), "tmp", "codex-long-context-")); roots.push(root);
	for (const key of keys) delete process.env[key];
	process.env.XDG_DATA_HOME = root;
	return root;
}
function registry(root: string, baseIds = ["gpt-6.1-sol", "gpt-6-luna", "future-registry-only"]) {
	const path = join(root, "suite", "runtime", "long-context-models.mjs");
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `const models = ${JSON.stringify(baseIds)}.map(baseId => ({baseId}));
export function getCodexLongContextModel(id) { return models.find(m => m.baseId + '-long' === id); }`);
}

test("active release registry maps known and synthetic future entries without a payload mapper", async () => {
	const root = fixture(); registry(root); process.env.PI_CODEX_ULTRA_RELEASE_ROOT = root;
	for (const base of ["gpt-6.1-sol", "gpt-6-luna", "future-registry-only"]) {
		assert.equal(await codexWireModelId(`${base}-long`), base);
	}
	for (const id of ["gpt-6.1-sol", "unknown-long", "gpt-6-luna-long-extra", "codex-pro/gpt-6-luna-long"]) {
		assert.equal(await codexWireModelId(id), id);
	}
});

test("non-Long IDs return before importing even a broken registry", async () => {
	const root = fixture(); registry(root);
	writeFileSync(join(root, "suite", "runtime", "long-context-models.mjs"), "throw new Error('must not import');");
	process.env.PI_CODEX_ULTRA_RELEASE_ROOT = root;
	assert.equal(await codexWireModelId("ordinary-model"), "ordinary-model");
});

test(".26 missing registry falls back to current in the release's own state directory", async () => {
	const state = fixture(); const current = join(state, "releases", "v27"); registry(current);
	symlinkSync(current, join(state, "current"));
	process.env.PI_CODEX_ULTRA_RELEASE_ROOT = join(state, "releases", "v26");
	process.env.PI_CODEX_ULTRA_HOME = join(state, "wrong-state");
	assert.equal(await codexWireModelId("gpt-6-luna-long"), "gpt-6-luna");
});

test("active immutable registry wins over current, including its unknown IDs", async () => {
	const state = fixture(); const active = join(state, "releases", "active"); registry(active, ["active-model"]);
	registry(join(state, "current"), ["current-model"]);
	process.env.PI_CODEX_ULTRA_RELEASE_ROOT = active;
	assert.equal(await codexWireModelId("active-model-long"), "active-model");
	assert.equal(await codexWireModelId("current-model-long"), "current-model-long");
});

test("without a release root, explicit Ultra home wins over XDG", async () => {
	const root = fixture(); registry(join(root, "home", "current"), ["home-model"]);
	registry(join(root, "pi-codex-ultra", "current"), ["xdg-model"]);
	process.env.PI_CODEX_ULTRA_HOME = join(root, "home");
	assert.equal(await codexWireModelId("home-model-long"), "home-model");
	assert.equal(await codexWireModelId("xdg-model-long"), "xdg-model-long");
});

test("XDG fallback follows current updates without caching the symlink module", async () => {
	const root = fixture(); const state = join(root, "pi-codex-ultra");
	const first = join(state, "releases", "first"); const second = join(state, "releases", "second");
	registry(first, ["first-model"]); registry(second, ["second-model"]);
	const current = join(state, "current"); symlinkSync(first, current);
	assert.equal(await codexWireModelId("first-model-long"), "first-model");
	rmSync(current); symlinkSync(second, current);
	assert.equal(await codexWireModelId("second-model-long"), "second-model");
	assert.equal(await codexWireModelId("first-model-long"), "first-model-long");
});

test("absent Ultra leaves ordinary and unknown Long models unchanged", async () => {
	fixture();
	for (const id of ["ordinary", "unknown-long", "gpt-6.1-sol-long"]) assert.equal(await codexWireModelId(id), id);
});

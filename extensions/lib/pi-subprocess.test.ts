import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, test } from "bun:test";
import { getPiInvocation, isForcedPiSession, piChildEnvironment, subagentModel } from "./pi-subprocess.ts";

const key = Symbol.for("pi-codex-ultra.force-model.v1");
const global = globalThis as any;
const original = global[key];
const roots: string[] = [];
afterEach(() => {
	if (original === undefined) delete global[key]; else global[key] = original;
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function force() { global[key] = { active: true }; }
function parent(provider = "codex-pro", id = "gpt-6-sol", models = [id, "gpt-6-luna", "gpt-6-astra"]) {
	return {
		model: { provider, id }, thinkingLevel: "high",
		modelRegistry: {
			find: (requestedProvider: string, modelId: string) => requestedProvider === provider && models.includes(modelId) ? { provider, id: modelId } : undefined,
			getProviderAuthStatus: () => ({ configured: true }),
		},
	} as any;
}
function runtime() {
	const root = mkdtempSync(join(tmpdir(), "pi-force-invocation-")); roots.push(root);
	const currentScript = join(root, "runtime", "cli.mjs");
	const launcher = join(root, "launcher", "launcher.mjs");
	for (const file of [currentScript, launcher]) { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, ""); }
	return { currentScript, ultraReleaseRoot: root, execPath: process.execPath, launcher };
}

test("only the latched process symbol enables forced delegation", () => {
	delete global[key];
	assert.equal(isForcedPiSession(), false);
	assert.deepEqual(subagentModel("other/model:low", parent("openai-codex")), { model: "other/model:low" });
	global[key] = { active: "true" };
	assert.equal(isForcedPiSession(), false);
	force(); assert.equal(isForcedPiSession(), true);
});

test("deliberate child environments strip launcher markers without changing their parent", () => {
	force();
	const base = { PI_CODEX_ULTRA_FORCE_MODEL: "1", PI_CODEX_ULTRA_UPDATE_CHECKED: "old", PI_PROVIDER: "stale-provider", KEEP: "yes" };
	assert.deepEqual(piChildEnvironment(base), { PI_PROVIDER: "stale-provider", KEEP: "yes", NODE_OPTIONS: "--max-old-space-size=8192" });
	assert.equal(base.PI_CODEX_ULTRA_FORCE_MODEL, "1");
	assert.equal(base.PI_CODEX_ULTRA_UPDATE_CHECKED, "old");
	delete global[key];
	assert.equal(isForcedPiSession(), false);
	assert.deepEqual(piChildEnvironment(base), { PI_CODEX_ULTRA_UPDATE_CHECKED: "old", PI_PROVIDER: "stale-provider", KEEP: "yes", NODE_OPTIONS: "--max-old-space-size=8192" });
});

test("all deliberate Pi children get the heap policy without losing other Node options", () => {
	delete global[key];
	const base = { NODE_OPTIONS: "--trace-warnings --max-old-space-size=2048" };
	const env = piChildEnvironment(base);
	assert.equal(env.NODE_OPTIONS, `${base.NODE_OPTIONS} --max-old-space-size=8192`);
	assert.deepEqual(piChildEnvironment(env), env);
	assert.equal(base.NODE_OPTIONS, "--trace-warnings --max-old-space-size=2048");
});

test("forced sizing and foreign-qualified requests resolve exactly under the personal provider", () => {
	force(); const ctx = parent();
	for (const id of ["gpt-6-luna", "gpt-6-sol", "gpt-6-astra"]) {
		assert.deepEqual(subagentModel(`openai-codex/${id}:high`, ctx), { provider: "codex-pro", model: `codex-pro/${id}:high` });
	}
	assert.deepEqual(subagentModel("gpt-6-astra:low", ctx), { provider: "codex-pro", model: "codex-pro/gpt-6-astra:low" });
});

test("unavailable requested models fall back to the live parent model, not a startup pin", () => {
	force(); const ctx = parent();
	assert.equal(subagentModel("other/unavailable:high", ctx).model, "codex-pro/gpt-6-sol:high");
	ctx.model = { provider: "codex-pro", id: "gpt-6-luna" };
	ctx.thinkingLevel = "low";
	assert.equal(subagentModel(undefined, ctx).model, "codex-pro/gpt-6-luna:low");
	assert.equal(subagentModel("unavailable:high", ctx).model, "codex-pro/gpt-6-luna:high");
});

test("missing personal authority, auth or exact model metadata fails closed", () => {
	force();
	assert.throws(() => subagentModel("gpt-6-sol"), /personal/);
	assert.throws(() => subagentModel("gpt-6-sol", parent("openai-codex")), /personal/);
	const ctx = parent();
	ctx.modelRegistry.getProviderAuthStatus = () => ({ configured: false });
	assert.throws(() => subagentModel(undefined, ctx), /authentication/);
	ctx.modelRegistry.getProviderAuthStatus = () => ({ configured: true });
	ctx.modelRegistry.find = () => ({ provider: "openai-codex", id: "gpt-6-sol" });
	assert.throws(() => subagentModel(undefined, ctx), /personal model/);
	ctx.modelRegistry.find = () => undefined;
	assert.throws(() => subagentModel(undefined, ctx), /personal model/);
});

test("verified Ultra launch prepends force without rewriting prompt or option values", () => {
	force(); const r = runtime();
	const args = ["--append-system-prompt", "--force-model", "Task: literal --force-model", "--force-model"];
	assert.deepEqual(getPiInvocation(args, r), { command: process.execPath, args: [realpathSync(r.launcher), "--force-model", ...args] });
	assert.deepEqual(args, ["--append-system-prompt", "--force-model", "Task: literal --force-model", "--force-model"]);
});

test("forced launches reject unverified roots and never pass the flag to stock Pi", () => {
	force(); const r = runtime();
	for (const currentScript of [undefined, r.ultraReleaseRoot, dirname(r.ultraReleaseRoot), `${r.ultraReleaseRoot}-sibling/cli.mjs`, join(r.ultraReleaseRoot, "missing.mjs")]) {
		assert.throws(() => getPiInvocation(["prompt"], { ...r, currentScript }), /Ultra launcher/);
	}
	assert.throws(() => getPiInvocation(["prompt"], { ...r, ultraReleaseRoot: undefined }), /Ultra launcher/);
	const outside = join(dirname(r.ultraReleaseRoot), `${r.ultraReleaseRoot.split("/").at(-1)}-outside.mjs`);
	writeFileSync(outside, ""); roots.push(outside);
	rmSync(r.currentScript); symlinkSync(outside, r.currentScript);
	assert.throws(() => getPiInvocation([], r), /Ultra launcher/);
	rmSync(r.currentScript); writeFileSync(r.currentScript, "");
	rmSync(r.launcher); symlinkSync(outside, r.launcher);
	assert.throws(() => getPiInvocation([], r), /Ultra launcher/);
	rmSync(r.launcher);
	assert.throws(() => getPiInvocation([], r), /Ultra launcher/);
});

test("ordinary stock and packaged executable fallback behavior stays unforced", () => {
	delete global[key]; const r = runtime();
	assert.deepEqual(getPiInvocation(["prompt"], { ...r, ultraReleaseRoot: undefined }), { command: process.execPath, args: [r.currentScript, "prompt"] });
	assert.deepEqual(getPiInvocation(["prompt"], { execPath: "/bin/node" }), { command: "pi", args: ["prompt"] });
	assert.deepEqual(getPiInvocation(["prompt"], { execPath: "/bin/pi" }), { command: "/bin/pi", args: ["prompt"] });
});

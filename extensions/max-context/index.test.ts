import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import maxContext, { CUSTOM_ENTRY_TYPE, maxContextMarker, parseMaxContext, restoreMaxContext } from "./index.ts";

const modelA = Object.freeze({ provider: "codex-pi10", id: "gpt-6-sol", contextWindow: 372_000 });
const modelB = Object.freeze({ provider: "other", id: "other-model", contextWindow: 256_000 });
const stateEntry = (value: unknown, sessionId = "parent", version = 1) => ({
	type: "custom", customType: CUSTOM_ENTRY_TYPE, data: { version, sessionId, value },
}) as SessionEntry;

test("parses positive safe integers and whitespace-only reset", () => {
	for (const text of ["", " ", "\t\n"]) assert.equal(parseMaxContext(text), null);
	for (const value of [1, 256_000, Number.MAX_SAFE_INTEGER]) assert.equal(parseMaxContext(` ${value} `), value);
});

for (const text of ["0", "-1", "+1", "1.0", "1e5", "256k", "NaN", "Infinity", "0x100", "1 2", "1\n2", "1\t2", "1_000", "01", "9007199254740992"]) {
	test(`rejects ${JSON.stringify(text)}`, () => assert.throws(() => parseMaxContext(text), /Usage:/));
}

test("restores only the last valid current-session entry, including reset tombstones", () => {
	const entries = [
		stateEntry(372_000), stateEntry(256_000), stateEntry(1, "foreign"), stateEntry(1, "parent", 2),
		...[-1, 0, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "256000", undefined].map((value) => stateEntry(value)),
		{ type: "custom", customType: CUSTOM_ENTRY_TYPE, data: null },
		{ type: "custom", customType: "unrelated", data: { version: 1, sessionId: "parent", value: 1 } },
	] as SessionEntry[];
	assert.equal(restoreMaxContext(entries, "parent"), 256_000);
	assert.equal(restoreMaxContext(entries, "child"), undefined);
	assert.equal(restoreMaxContext([...entries, stateEntry(null)], "parent"), undefined);
	assert.equal(restoreMaxContext([...entries, stateEntry(null), stateEntry(1)], "parent"), 1);
});

function harness(entries: SessionEntry[] = [], sessionId = "parent") {
	const handlers = new Map<string, ((event: any, ctx: any) => any)[]>();
	const commands = new Map<string, any>();
	const models = new Map([modelA, modelB].map((model) => [`${model.provider}/${model.id}`, model]));
	const notifications: Array<[string, string]> = [];
	const publications: Array<{ channel: string; data: any }> = [];
	const modelCalls: any[] = [];
	const thinkingCalls: string[] = [];
	let activeModel: any = modelA;
	let thinking = "max";
	let failure: "false" | "throw" | undefined;
	let idle = true;
	let waitHook = async () => { idle = true; };
	const context = {
		get model() { return activeModel; },
		modelRegistry: { find: (provider: string, id: string) => models.get(`${provider}/${id}`) },
		sessionManager: { getEntries: () => entries, getSessionId: () => sessionId },
		isIdle: () => idle,
		waitForIdle: () => waitHook(),
		ui: { notify: (text: string, level: string) => notifications.push([text, level]) },
	};
	const fire = async (name: string, event: any = {}) => {
		let result;
		for (const handler of handlers.get(name) ?? []) result = await handler(event, context);
		return result;
	};
	const pi = {
		on(name: string, handler: any) { handlers.set(name, [...handlers.get(name) ?? [], handler]); },
		registerCommand(name: string, command: any) { commands.set(name, command); },
		appendEntry(customType: string, data: any) { entries.push({ type: "custom", customType, data } as SessionEntry); },
		events: { emit(channel: string, data: any) { publications.push({ channel, data }); } },
		getThinkingLevel() { return thinking; },
		setThinkingLevel(value: string) { thinking = value; thinkingCalls.push(value); },
		async setModel(model: any) {
			modelCalls.push(model);
			if (failure === "false") return false;
			if (failure === "throw") throw new Error("synthetic private backend detail");
			const previousModel = activeModel;
			activeModel = model;
			thinking = "high"; // Core applies model defaults even for same-ID clones.
			if (previousModel?.id !== model.id || previousModel?.provider !== model.provider) {
				await fire("model_select", { model, previousModel });
			}
			return true;
		},
	} as unknown as ExtensionAPI;
	maxContext(pi);
	return {
		context, entries, notifications, publications, modelCalls, thinkingCalls, models, fire, pi,
		command: (args = "") => commands.get("set-max-context").handler(args, context),
		get model() { return activeModel; },
		set model(value: any) { activeModel = value; },
		get thinking() { return thinking; },
		set failure(value: typeof failure) { failure = value; },
		set idle(value: boolean) { idle = value; },
		set waitHook(value: typeof waitHook) { waitHook = value; },
		get marker() { return publications.at(-1)?.data.value; },
	};
}

test("clones without mutating active/registered defaults and preserves thinking", async () => {
	const h = harness();
	await h.fire("session_start");
	await h.command("256000");
	assert.deepEqual(h.model, { ...modelA, contextWindow: 256_000 });
	assert.notStrictEqual(h.model, modelA);
	assert.equal(modelA.contextWindow, 372_000);
	assert.equal(h.thinking, "max");
	assert.deepEqual(h.thinkingCalls, ["max"]);
	assert.deepEqual(h.entries, [stateEntry(256_000)]);
	assert.equal(h.marker, "max:256k");
	assert.equal(h.publications.at(-1)?.channel, "model-status:prefix");
	assert.equal(h.modelCalls.length, 1, "same-ID clone must not recurse");
});

test("unchanged values avoid model changes but keep the numeric override across models", async () => {
	const h = harness();
	await h.command("372000");
	assert.equal(h.modelCalls.length, 0);
	assert.equal(h.marker, "");
	await h.pi.setModel(modelB as any);
	assert.equal(h.model.contextWindow, 372_000);
	assert.equal(h.marker, "max:372k");
	assert.equal(h.entries.length, 1, "reapplication must not write persistence entries");
	await h.command("372000");
	assert.equal(h.modelCalls.length, 2, "repeat command must not call the model setter");
});

test("reset restores the exact current registry object and remains cleared after model changes", async () => {
	const h = harness();
	await h.command("256000");
	await h.command();
	assert.strictEqual(h.model, modelA);
	assert.equal(h.thinking, "max");
	assert.deepEqual(h.entries, [stateEntry(256_000), stateEntry(null)]);
	assert.equal(h.marker, "");
	await h.pi.setModel(modelB as any);
	assert.strictEqual(h.model, modelB);
	assert.equal(h.marker, "");
});

test("reset resolves the newly selected model's own default", async () => {
	const h = harness();
	await h.command("128000");
	await h.pi.setModel(modelB as any);
	await h.command();
	assert.strictEqual(h.model, modelB);
	assert.match(h.notifications.at(-1)![0], /256,000.*other\/other-model/);
});

test("equal-default clones reset to registry identity, but a second reset avoids the setter", async () => {
	const h = harness();
	await h.command("256000");
	await h.command("372000");
	assert.equal(h.marker, "");
	assert.notStrictEqual(h.model, modelA);
	await h.command();
	assert.strictEqual(h.model, modelA);
	const calls = h.modelCalls.length;
	await h.command();
	assert.equal(h.modelCalls.length, calls);
});

for (const reason of ["startup", "reload", "resume"]) {
	test(`${reason} restores same-session state without appending entries`, async () => {
		const h = harness([stateEntry(256_000)]);
		await h.fire("session_start", { reason });
		assert.equal(h.model.contextWindow, 256_000);
		assert.equal(h.marker, "max:256k");
		assert.equal(h.entries.length, 1);
	});
}

for (const child of ["new", "fork", "clone", "tmux-fork", "subagent"]) {
	test(`${child} ignores copied parent entries`, async () => {
		const h = harness([stateEntry(256_000)], child);
		await h.fire("session_start", { reason: child });
		await h.fire("input");
		assert.strictEqual(h.model, modelA);
		assert.equal(h.marker, "");
		assert.equal(h.modelCalls.length, 0);
	});
}

test("a startup tombstone hides and clears a preceding override", async () => {
	const h = harness([stateEntry(256_000), stateEntry(null)]);
	await h.fire("session_start");
	await h.pi.setModel(modelB as any);
	assert.strictEqual(h.model, modelB);
	assert.equal(h.marker, "");
});

test("tree navigation restores session-wide state from all entries", async () => {
	const h = harness([stateEntry(256_000)]);
	await h.fire("session_tree");
	assert.equal(h.model.contextWindow, 256_000);
	assert.equal(h.entries.length, 1);
});

for (const hook of ["input", "before_agent_start"]) {
	test(`${hook} repairs silent model replacement idempotently`, async () => {
		const h = harness();
		await h.command("256000");
		h.model = modelA;
		await h.fire(hook);
		assert.equal(h.model.contextWindow, 256_000);
		const calls = h.modelCalls.length;
		await h.fire(hook);
		assert.equal(h.modelCalls.length, calls);
		assert.equal(h.entries.length, 1);
	});
}

test("input leaves an active streaming request alone", async () => {
	const h = harness([stateEntry(256_000)]);
	await h.fire("session_start");
	h.model = modelA;
	h.idle = false;
	await h.fire("input");
	assert.strictEqual(h.model, modelA);
});

test("commands await idle before touching the active model or session history", async () => {
	const h = harness();
	let release!: () => void;
	h.waitHook = () => new Promise<void>((resolve) => { release = resolve; });
	const pending = h.command("256000");
	assert.equal(h.modelCalls.length, 0);
	assert.equal(h.entries.length, 0);
	release();
	await pending;
	assert.equal(h.model.contextWindow, 256_000);
});

for (const failure of ["false", "throw"] as const) {
	test(`${failure} model-set failure does not persist or leak raw backend errors`, async () => {
		const h = harness();
		h.failure = failure;
		await h.command("256000");
		assert.equal(h.entries.length, 0);
		assert.strictEqual(h.model, modelA);
		assert.equal(h.notifications.at(-1)![1], "error");
		assert.doesNotMatch(h.notifications.at(-1)![0], /private backend/);
		h.failure = undefined;
		await h.fire("input");
		assert.strictEqual(h.model, modelA, "failed set must not activate runtime override state");
	});
}

test("failed reset retains persisted and runtime override state", async () => {
	const h = harness();
	await h.command("128000");
	h.failure = "false";
	await h.command();
	assert.equal(h.entries.length, 1);
	h.failure = undefined;
	await h.pi.setModel(modelB as any);
	assert.equal(h.model.contextWindow, 128_000);
});

test("failed input repair handles the prompt rather than using the wrong limit", async () => {
	const h = harness();
	await h.command("256000");
	h.model = modelA;
	h.failure = "false";
	assert.deepEqual(await h.fire("input"), { action: "handled" });
	assert.equal(h.marker, "", "marker describes the actual active value, never a failed intention");
	h.failure = undefined;
	await h.fire("input");
	assert.equal(h.model.contextWindow, 256_000);
});

test("invalid commands and missing active/registered models leave session state untouched", async () => {
	const h = harness();
	await h.command("1 2");
	h.model = undefined;
	await h.command("256000");
	h.model = modelA;
	h.models.clear();
	await h.command();
	await h.command("256000");
	assert.equal(h.entries.length, 0);
	assert.equal(h.modelCalls.length, 0);
	assert.deepEqual(h.notifications.map(([, level]) => level), ["warning", "error", "error", "error"]);
});

test("marker compares active metadata with the current registry and preserves exact values", () => {
	const h = harness();
	assert.equal(maxContextMarker(h.context as any), "");
	for (const [value, marker] of [[256_000, "max:256k"], [1_000_000, "max:1m"], [256_123, "max:256,123"], [1, "max:1"]] as const) {
		h.model = { ...modelA, contextWindow: value };
		assert.equal(maxContextMarker(h.context as any), marker);
	}
	h.model = { ...modelB };
	assert.equal(maxContextMarker(h.context as any), "");
	h.model = { ...modelB, contextWindow: 372_000 };
	assert.equal(maxContextMarker(h.context as any), "max:372k");
	h.models.clear();
	assert.equal(maxContextMarker(h.context as any), "");
	h.model = undefined;
	assert.equal(maxContextMarker(h.context as any), "");
});

test("shutdown clears its footer contribution", async () => {
	const h = harness();
	await h.command("256000");
	await h.fire("session_shutdown");
	assert.equal(h.marker, "");
});

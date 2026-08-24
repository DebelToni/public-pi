import assert from "node:assert/strict";
import test from "node:test";
import {
	OneShotMediumFastState,
	applyMediumFast,
	latestUserText,
	supportsOneShotMediumFast,
} from "./one-shot-medium-fast.ts";

const model = {
	provider: "openai-codex",
	api: "openai-codex-responses",
	reasoning: true,
};

function payload(lastUserText: string, trailing: unknown[] = []) {
	return {
		model: "gpt-5.6-sol",
		reasoning: { effort: "max", summary: "auto" },
		input: [
			{ role: "user", content: [{ type: "input_text", text: lastUserText }] },
			...trailing,
		],
	};
}

function activate(state: OneShotMediumFastState, text = "target prompt") {
	state.arm();
	state.onInput("interactive");
	state.onBeforeAgentStart(text);
	state.onUserMessage(text);
}

test("medium/fast payload preserves other fields", () => {
	assert.deepEqual(applyMediumFast(payload("target")), {
		model: "gpt-5.6-sol",
		reasoning: { effort: "medium", summary: "auto" },
		service_tier: "priority",
		input: [{ role: "user", content: [{ type: "input_text", text: "target" }] }],
	});
});

test("one-shot applies to the target prompt and its tool continuations", () => {
	const state = new OneShotMediumFastState();
	activate(state);
	const first = state.rewrite(payload("target prompt"), model) as Record<string, unknown>;
	assert.equal(first.service_tier, "priority");
	assert.deepEqual(first.reasoning, { effort: "medium", summary: "auto" });

	const continuation = state.rewrite(payload("target prompt", [
		{ type: "function_call", name: "read" },
		{ type: "function_call_output", output: "done" },
	]), model) as Record<string, unknown>;
	assert.equal(continuation.service_tier, "priority");
});

test("a queued or later user message ends the override even when text is identical", () => {
	const state = new OneShotMediumFastState();
	activate(state);
	state.onUserMessage("target prompt");
	assert.equal(state.rewrite(payload("target prompt"), model), undefined);
});

test("unrelated provider calls cannot consume or inherit the override", () => {
	const state = new OneShotMediumFastState();
	activate(state);
	const compaction = payload("Summarize this conversation containing: target prompt");
	assert.equal(state.rewrite(compaction, model), undefined);
	assert.ok(state.rewrite(payload("target prompt"), model));
});

test("normal input, extension input, cancellation, and settlement clear pending state", () => {
	for (const clear of [
		(state: OneShotMediumFastState) => { state.onInput("interactive"); state.onInput("interactive"); },
		(state: OneShotMediumFastState) => state.onInput("extension"),
		(state: OneShotMediumFastState) => state.cancel(),
		(state: OneShotMediumFastState) => state.clear(),
	]) {
		const state = new OneShotMediumFastState();
		state.arm();
		clear(state);
		state.onBeforeAgentStart("wrong prompt");
		state.onUserMessage("wrong prompt");
		assert.equal(state.rewrite(payload("wrong prompt"), model), undefined);
	}
});

test("only reasoning-capable OpenAI Responses models are eligible", () => {
	assert.equal(supportsOneShotMediumFast(model), true);
	assert.equal(supportsOneShotMediumFast({ ...model, provider: "codex-pi7" }), true);
	assert.equal(supportsOneShotMediumFast({ ...model, reasoning: false }), false);
	assert.equal(supportsOneShotMediumFast({ ...model, provider: "anthropic" }), false);
	assert.equal(supportsOneShotMediumFast({ ...model, api: "openai-completions" }), false);
});

test("latest user text ignores later tool records", () => {
	assert.equal(latestUserText(payload("target", [{ type: "function_call_output", output: "done" }])), "target");
});

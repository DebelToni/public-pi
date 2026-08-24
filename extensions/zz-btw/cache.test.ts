import assert from "node:assert/strict";
import test from "node:test";
import {
	CacheSafetyError,
	buildCacheForkPayload,
	cacheHitRatio,
	formatUsage,
	promptCacheKey,
	roughSharedTokenEstimate,
} from "./cache.ts";

const parent = {
	model: "gpt-5.6-sol",
	instructions: "stable system",
	input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "parent" }] }],
	tools: [{ type: "function", name: "read" }],
	prompt_cache_key: "parent-session",
	service_tier: "priority",
	store: false,
	stream: true,
};

const sidePrompt = "SIDE QUESTION";
const candidate = {
	...parent,
	prompt_cache_key: "side-transport-session",
	service_tier: "default",
	input: [
		...parent.input,
		{ type: "message", role: "assistant", content: [{ type: "output_text", text: "answer" }] },
		{ type: "message", role: "user", content: [{ type: "input_text", text: sidePrompt }] },
	],
};

test("fork payload preserves the parent body and only extends input", () => {
	const originalParent = structuredClone(parent);
	const result = buildCacheForkPayload(parent, candidate, sidePrompt);

	assert.deepEqual(parent, originalParent);
	assert.equal(result.payload.prompt_cache_key, "parent-session");
	assert.equal(result.payload.service_tier, "priority");
	assert.deepEqual(result.payload.tools, parent.tools);
	assert.deepEqual((result.payload.input as unknown[]).slice(0, parent.input.length), parent.input);
	assert.equal(result.sharedInputItems, 1);
	assert.equal(result.suffixInputItems, 2);
});

test("concurrent fork can append the side prompt before the parent response finishes", () => {
	const concurrentCandidate = {
		...parent,
		input: [
			...parent.input,
			{ type: "message", role: "user", content: [{ type: "input_text", text: sidePrompt }] },
		],
	};
	const result = buildCacheForkPayload(parent, concurrentCandidate, sidePrompt);
	assert.deepEqual(result.payload.input, concurrentCandidate.input);
	assert.equal(result.sharedInputItems, parent.input.length);
	assert.equal(result.suffixInputItems, 1);
});

test("follow-up turns preserve the exact parent prefix and append side history", () => {
	const followUp = "FOLLOW UP";
	const multiTurnCandidate = {
		...parent,
		prompt_cache_key: "side-transport-session",
		input: [
			...parent.input,
			{ type: "message", role: "user", content: [{ type: "input_text", text: sidePrompt }] },
			{ type: "message", role: "assistant", content: [{ type: "output_text", text: "side answer" }] },
			{ type: "message", role: "user", content: [{ type: "input_text", text: followUp }] },
		],
	};
	const result = buildCacheForkPayload(parent, multiTurnCandidate, followUp);
	assert.deepEqual((result.payload.input as unknown[]).slice(0, parent.input.length), parent.input);
	assert.deepEqual(result.payload.input, multiTurnCandidate.input);
	assert.equal(result.payload.prompt_cache_key, parent.prompt_cache_key);
	assert.equal(result.sharedInputItems, parent.input.length);
	assert.equal(result.suffixInputItems, 3);
});

test("fork payload rejects a changed parent prefix", () => {
	const changed = structuredClone(candidate);
	changed.input[0].content[0].text = "changed";
	assert.throws(() => buildCacheForkPayload(parent, changed, sidePrompt), CacheSafetyError);
});

test("fork payload rejects a missing cache key", () => {
	const withoutKey = { ...parent, prompt_cache_key: undefined };
	assert.equal(promptCacheKey(withoutKey), undefined);
	assert.throws(() => buildCacheForkPayload(withoutKey, candidate, sidePrompt), /prompt_cache_key/);
});

test("fork payload rejects a suffix without the exact side prompt", () => {
	assert.throws(() => buildCacheForkPayload(parent, candidate, "different"), /exact side prompt/);
});

test("fork payload rejects content after the exact side prompt", () => {
	const extra = structuredClone(candidate);
	extra.input.push({ type: "message", role: "user", content: [{ type: "input_text", text: "extra" }] });
	assert.throws(() => buildCacheForkPayload(parent, extra, sidePrompt), /end with the exact side prompt/);
});

test("fork payload rejects a side prompt hidden inside another content block", () => {
	const embedded = structuredClone(candidate);
	embedded.input.at(-1)!.content.push({ type: "input_text", text: "extra" });
	assert.throws(() => buildCacheForkPayload(parent, embedded, sidePrompt), /end with the exact side prompt/);
});

test("cache telemetry reports hit ratio, writes, and cost", () => {
	const usage = { input: 258, output: 19, cacheRead: 1536, cacheWrite: 128, cost: { total: 0.002628 } };
	assert.equal(cacheHitRatio(usage), 1536 / 1922);
	assert.equal(formatUsage(usage), "in 258 · cache 1.5k (80%) · write 128 · out 19 · $0.0026");
});

test("rough token estimate recognizes cache-eligible payloads", () => {
	const large = { ...parent, instructions: "x".repeat(5000) };
	assert.ok(roughSharedTokenEstimate(large) >= 1024);
});

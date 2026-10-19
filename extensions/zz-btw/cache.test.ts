import assert from "node:assert/strict";
import test from "node:test";
import {
	CACHE_FRESHNESS_MS,
	CacheSafetyError,
	buildCacheForkPayload,
	cacheFreshness,
	cacheHitRatio,
	confirmedCacheProblem,
	confirmedParentCacheCoverage,
	formatUsage,
	promptCacheKey,
	roughSharedTokenEstimate,
} from "./cache.ts";

const parent = {
	model: "gpt-6-sol",
	instructions: "stable system",
	input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "parent" }] }],
	tools: [{ type: "function", name: "read" }],
	prompt_cache_key: "parent-session",
	tool_choice: "auto",
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
	assert.equal(result.payload.tool_choice, "none");
	assert.equal(result.payload.service_tier, "priority");
	assert.deepEqual(result.payload.tools, parent.tools);
	assert.deepEqual((result.payload.input as unknown[]).slice(0, parent.input.length), parent.input);
	const { input: _parentInput, tool_choice: _parentToolChoice, ...parentBody } = parent;
	const { input: _sideInput, tool_choice: _sideToolChoice, ...sideBody } = result.payload;
	assert.deepEqual(sideBody, parentBody);
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

test("cache freshness rejects future timestamps and the exact five-minute boundary", () => {
	assert.deepEqual(cacheFreshness(10_001, 10_000), { ok: false, ageMs: -1, reason: "future" });
	assert.deepEqual(cacheFreshness(10_000, 10_000 + CACHE_FRESHNESS_MS - 1), {
		ok: true,
		ageMs: CACHE_FRESHNESS_MS - 1,
	});
	assert.deepEqual(cacheFreshness(10_000, 10_000 + CACHE_FRESHNESS_MS), {
		ok: false,
		ageMs: CACHE_FRESHNESS_MS,
		reason: "expired",
	});
});

test("confirmed cache coverage is measured against exact parent prompt tokens", () => {
	assert.equal(confirmedParentCacheCoverage(2_000, 1_800), 0.9);
	assert.equal(confirmedParentCacheCoverage(2_000, 4_000), 1);
	assert.equal(confirmedCacheProblem(2_000, 1_800), undefined);
	assert.match(confirmedCacheProblem(2_000, 1_799) ?? "", /parent cache coverage/);
	assert.match(confirmedCacheProblem(2_000, 0) ?? "", /cache miss/);
	assert.match(confirmedCacheProblem(1_023, 1_023) ?? "", /at least 1024/);
});

test("dispatch recheck catches expiry after a successful turn preflight", () => {
	const confirmedRequestStartedAt = 5_000;
	assert.equal(cacheFreshness(confirmedRequestStartedAt, 5_000 + CACHE_FRESHNESS_MS - 1).ok, true);
	assert.deepEqual(cacheFreshness(confirmedRequestStartedAt, 5_000 + CACHE_FRESHNESS_MS), {
		ok: false,
		ageMs: CACHE_FRESHNESS_MS,
		reason: "expired",
	});
});

test("follow-up freshness uses the successful request start, not its completion", () => {
	const successfulRequestStartedAt = 1_000;
	const responseCompletedAt = 50_000;
	const followUpAt = successfulRequestStartedAt + CACHE_FRESHNESS_MS;
	assert.equal(cacheFreshness(successfulRequestStartedAt, followUpAt).ok, false);
	assert.equal(cacheFreshness(responseCompletedAt, followUpAt).ok, true);
});

test("rough token estimate recognizes cache-eligible payloads", () => {
	const large = { ...parent, instructions: "x".repeat(5000) };
	assert.ok(roughSharedTokenEstimate(large) >= 1024);
});

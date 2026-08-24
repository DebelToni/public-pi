import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { expect, test } from "bun:test";
import { CODEX_USAGE_LIMIT_SIGNAL_CHANNEL } from "../codex-accounts/auto-recovery.js";
import { reportCompactionUsageLimit } from "./index.js";

function response(errorMessage: string): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "openai-codex-responses",
		provider: "codex-pi9",
		model: "gpt-5.6-sol",
		stopReason: "error",
		errorMessage,
		timestamp: Date.now(),
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	} as AssistantMessage;
}

test("compaction forwards exact Codex exhaustion to automatic recovery", () => {
	const emitted: Array<{ channel: string; value: unknown }> = [];
	const context = {} as ExtensionContext;
	const pi = {
		events: {
			emit(channel: string, value: unknown) {
				emitted.push({ channel, value });
			},
		},
	};

	expect(reportCompactionUsageLimit(pi as never, context, response("Codex error: The usage limit has been reached."))).toBe(true);
	expect(emitted).toEqual([
		{
			channel: CODEX_USAGE_LIMIT_SIGNAL_CHANNEL,
			value: { provider: "codex-pi9", model: "gpt-5.6-sol", context },
		},
	]);
});

test("compaction does not forward overload or generic 429 failures", () => {
	let emitted = false;
	const pi = { events: { emit() { emitted = true; } } };
	const context = {} as ExtensionContext;
	for (const error of ["Codex error: Server overloaded", "Codex error: 429 Too Many Requests"]) {
		expect(reportCompactionUsageLimit(pi as never, context, response(error))).toBe(false);
	}
	expect(emitted).toBe(false);
});

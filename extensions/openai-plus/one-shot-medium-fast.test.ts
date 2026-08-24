import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ONE_SHOT_MEDIUM_FAST_CHANNEL } from "../lib/one-shot-medium-fast.ts";
import openaiPlus from "./index.ts";

type Handler = (event: any, context?: any) => unknown;

function harness() {
	const handlers = new Map<string, Handler[]>();
	const bus = new Map<string, Set<(data: unknown) => void>>();
	const pi = {
		on(name: string, handler: Handler) {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
		},
		events: {
			on(name: string, handler: (data: unknown) => void) {
				const listeners = bus.get(name) ?? new Set();
				listeners.add(handler);
				bus.set(name, listeners);
				return () => listeners.delete(handler);
			},
			emit(name: string, data: unknown) {
				for (const handler of bus.get(name) ?? []) handler(data);
			},
		},
		registerCommand() {},
		registerTool() {},
		appendEntry() {},
		sendMessage() {},
	} as unknown as ExtensionAPI;
	openaiPlus(pi);
	return {
		pi,
		emit(name: string, event: unknown, context?: unknown) {
			let result: unknown;
			for (const handler of handlers.get(name) ?? []) result = handler(event, context);
			return result;
		},
	};
}

const context = {
	model: {
		api: "openai-codex-responses",
		provider: "codex-pi2",
		reasoning: true,
	},
	sessionManager: { getEntries: () => [] },
};

test("Ctrl+F arm applies medium priority to exactly the submitted turn", () => {
	const extension = harness();
	const request = { action: "arm" as const };
	extension.pi.events.emit(ONE_SHOT_MEDIUM_FAST_CHANNEL, request);
	assert.equal(request.accepted, true);

	extension.emit("input", { source: "interactive" });
	extension.emit("before_agent_start", { prompt: "ship it" });
	extension.emit("message_start", { message: { role: "user", content: "ship it" } });

	const payload = { input: [{ role: "user", content: "ship it" }], reasoning: { summary: "auto" } };
	assert.deepEqual(extension.emit("before_provider_request", { payload }, context), {
		...payload,
		reasoning: { summary: "auto", effort: "medium" },
		service_tier: "priority",
	});

	extension.emit("agent_settled", {});
	assert.equal(extension.emit("before_provider_request", { payload }, context), undefined);
});

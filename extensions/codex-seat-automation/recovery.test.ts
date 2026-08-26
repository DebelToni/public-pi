import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, test } from "bun:test";
import { reportCompactionUsageLimit } from "../compaction/index.js";
import {
	CONTINUATION_REQUEST_CHANNEL,
	type ContinuationRequest,
} from "../lib/continuation-request.js";
import {
	CODEX_USAGE_LIMIT_SIGNAL_CHANNEL,
	getCodexUsageLimitCandidate,
	isCodexUsageLimitErrorText,
	isConfirmedCodexUsageLimit,
} from "../codex-accounts/auto-recovery.js";
import { installAutoRecovery } from "./recovery.js";
import type { RecoveryState } from "./recovery-state.js";

function assistant(errorMessage: string, overrides: Partial<AssistantMessage> = {}): AssistantMessage {
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
		...overrides,
	} as AssistantMessage;
}

type LifecycleHandler = (event: any, context: ExtensionContext) => unknown;

class FakeEventBus {
	private handlers = new Map<string, Set<(value: unknown) => void>>();

	emit(channel: string, value: unknown) {
		for (const handler of this.handlers.get(channel) ?? []) handler(value);
	}

	on(channel: string, handler: (value: unknown) => void) {
		const handlers = this.handlers.get(channel) ?? new Set();
		handlers.add(handler);
		this.handlers.set(channel, handlers);
		return () => {
			handlers.delete(handler);
			if (handlers.size === 0) this.handlers.delete(channel);
		};
	}

	listenerCount(channel: string) {
		return this.handlers.get(channel)?.size ?? 0;
	}
}

async function waitFor(predicate: () => boolean, message: string) {
	const deadline = Date.now() + 500;
	while (!predicate() && Date.now() < deadline) await Bun.sleep(2);
	if (!predicate()) throw new Error(message);
}

function recoveryHarness(
	bus = new FakeEventBus(),
	options: {
		mode?: "json" | "print";
		holdContinuation?: boolean;
		failCompletion?: boolean;
		uncommittedCompletion?: boolean;
		expireBeforeSelection?: boolean;
		usageScore?: number;
	} = {},
) {
	const failedProvider = "codex-pi9";
	const selectedProvider = "codex-pi10";
	const model = "gpt-5.6-sol";
	const failedSyncId = "failed-sync";
	const selectedSyncId = "selected-sync";
	let idle = false;
	let finishHeldContinuation: (() => void) | undefined;
	let activeProvider = failedProvider;
	let activeSyncId = failedSyncId;
	let state: RecoveryState = {
		version: 1,
		generation: 1,
		status: "switching",
		failedProvider,
		failedModel: model,
		failedSyncId,
		startedAt: Date.now(),
		leaderPid: process.pid,
	};
	const calls = { joins: 0, confirmations: 0, selections: 0, completions: 0, continuations: 0 };
	const notices: string[] = [];
	const contextValue: any = {
		mode: options.mode,
		model: { provider: failedProvider, id: model },
		isIdle: () => idle,
		ui: {
			setStatus: () => {},
			notify: (message: string) => notices.push(message),
		},
	};
	const context = contextValue as ExtensionContext;
	const lifecycle = new Map<string, LifecycleHandler[]>();
	const unsubscribeContinuation = bus.on(CONTINUATION_REQUEST_CHANNEL, (value) => {
		const request = value as ContinuationRequest;
		expect(request.context).toBe(context);
		expect(request.target).toBe("main");
		calls.continuations++;
		if (options.holdContinuation) {
			idle = false;
			request.run = new Promise<void>((resolve) => { finishHeldContinuation = resolve; });
		} else {
			request.run = Promise.resolve();
		}
	});
	const pi = {
		events: bus,
		on(event: string, handler: LifecycleHandler) {
			const handlers = lifecycle.get(event) ?? [];
			handlers.push(handler);
			lifecycle.set(event, handlers);
		},
		registerCommand() {},
	} as unknown as ExtensionAPI;

	installAutoRecovery(pi, {
		readEnabled: () => true,
		readState: () => state,
		readSyncId: (provider, requestedModel) =>
			provider === activeProvider && requestedModel === model ? activeSyncId : undefined,
		join: async (provider, requestedModel, requestSyncId) => {
			calls.joins++;
			expect({ provider, requestedModel, requestSyncId }).toEqual({
				provider: failedProvider,
				requestedModel: model,
				requestSyncId: failedSyncId,
			});
			return { action: "leader", state };
		},
		abandon: async () => ({ abandoned: false, state }),
		complete: async (generation, result, selection, failureCode) => {
			calls.completions++;
			if (options.failCompletion) throw new Error("fake coordinator write failure");
			if (options.uncommittedCompletion) return { committed: false };
			if ((options.usageScore ?? 0) < 0 || (options.usageScore ?? 0) >= 10) {
				expect({ generation, result, selection, failureCode }).toEqual({
					generation: 1,
					result: "failed",
					selection: undefined,
					failureCode: "quota-not-exhausted",
				});
				state = { ...state, status: "failed", failureCode };
				return { committed: true, state };
			}
			if (options.expireBeforeSelection) {
				expect(result).toBe("failed");
				expect(selection).toBeUndefined();
				return { committed: false, state };
			}
			expect({ generation, result, selection, failureCode }).toEqual({
				generation: 1,
				result: "succeeded",
				selection: { provider: selectedProvider, model, syncId: selectedSyncId },
				failureCode: undefined,
			});
			state = { ...state, status: "succeeded", selectedProvider, selectedModel: model, selectedSyncId };
			return { committed: true, state };
		},
		setEnabled: async (enabled) => ({ config: { version: 1, enabled } }),
		readStatus: async () => ({ config: { version: 1, enabled: true }, state, syncId: activeSyncId }),
		confirmFailedUsage: async () => {
			calls.confirmations++;
			if (options.expireBeforeSelection) {
				state = { ...state, status: "failed", failureCode: "recovery-timeout" };
			}
			const score = options.usageScore ?? 0;
			return { score, label: score > 0 ? `${score}% left` : "rate limit reached" };
		},
		selectReplacement: async (_pi, selectedContext, requestedModel, guard) => {
			expect(requestedModel).toBe(model);
			if (!guard()) return undefined;
			calls.selections++;
			activeProvider = selectedProvider;
			activeSyncId = selectedSyncId;
			(selectedContext as any).model = { provider: selectedProvider, id: model };
			return { provider: selectedProvider, modelId: model, syncId: selectedSyncId };
		},
		isProcessAlive: () => true,
	});

	const emit = async (event: string, value: any = {}) => {
		for (const handler of lifecycle.get(event) ?? []) await handler({ type: event, ...value }, context);
	};

	return {
		bus,
		calls,
		context,
		notices,
		pi,
		emit,
		setIdle(value: boolean) {
			idle = value;
			if (value && finishHeldContinuation) {
				finishHeldContinuation();
				finishHeldContinuation = undefined;
			}
		},
		shutdown: async () => {
			finishHeldContinuation?.();
			finishHeldContinuation = undefined;
			await emit("session_shutdown");
			unsubscribeContinuation();
		},
	};
}

async function expectSuccessfulRecovery(harness: ReturnType<typeof recoveryHarness>) {
	await waitFor(() => harness.calls.continuations === 1, "recovery did not request continuation");
	expect(harness.calls).toEqual({ joins: 1, confirmations: 1, selections: 1, completions: 1, continuations: 1 });
}

describe("Codex usage-limit signals", () => {
	test("accepts both exact provider quota messages", () => {
		for (const text of [
			"You have hit your ChatGPT usage limit (team plan). Try again in ~123 min.",
			"Codex error: You have hit your ChatGPT usage limit (team plan). Try again in ~123 min.",
			"The usage limit has been reached",
			"Codex error: The usage limit has been reached",
			"Codex error: The usage limit has been reached.",
		]) {
			expect(isCodexUsageLimitErrorText(text)).toBe(true);
			expect(isConfirmedCodexUsageLimit(assistant(text))).toBe(true);
			expect(getCodexUsageLimitCandidate(assistant(text))).toEqual({
				provider: "codex-pi9",
				model: "gpt-5.6-sol",
			});
		}
	});

	test("rejects unrelated or ambiguous failures", () => {
		for (const text of [
			"Codex error: rate limit exceeded",
			"Codex error: 429 Too Many Requests",
			"Codex error: The usage limit has been reached for another account",
			"Codex error: Server overloaded",
			"Codex error: An error occurred while processing your request",
			"Codex error: Your input exceeds the context window of this model.",
		]) {
			expect(isCodexUsageLimitErrorText(text)).toBe(false);
			expect(isConfirmedCodexUsageLimit(assistant(text))).toBe(false);
		}
	});

	test("requires a Codex error response", () => {
		const text = "Codex error: The usage limit has been reached";
		expect(isConfirmedCodexUsageLimit(assistant(text, { provider: "anthropic" }))).toBe(false);
		expect(isConfirmedCodexUsageLimit(assistant(text, { api: "anthropic-messages" }))).toBe(false);
		expect(isConfirmedCodexUsageLimit(assistant(text, { stopReason: "stop" }))).toBe(false);
	});
});

describe("automatic recovery flow", () => {
	test("records confirmed exhaustion and the replacement provider when quota logging is installed", async () => {
		const bus = new FakeEventBus();
		const events: Array<{ kind: string; provider: string }> = [];
		const unsubscribe = bus.on("codex-quota-log:event:v1", (value) => {
			const request = value as any;
			events.push({ kind: request.kind, provider: request.provider });
			request.run = Promise.resolve();
		});
		const harness = recoveryHarness(bus);
		try {
			await harness.emit("before_provider_request");
			await harness.emit("message_end", { message: assistant("Codex error: The usage limit has been reached") });
			harness.setIdle(true);
			await harness.emit("agent_settled");
			await expectSuccessfulRecovery(harness);
			expect(events).toEqual([
				{ kind: "confirmed-exhaustion", provider: "codex-pi9" },
				{ kind: "provider-selected", provider: "codex-pi10" },
			]);
		} finally {
			unsubscribe();
			await harness.shutdown();
		}
	});

	test("a short main-agent quota response runs one fake generation and continues", async () => {
		const harness = recoveryHarness();
		try {
			await harness.emit("before_provider_request");
			await harness.emit("message_end", { message: assistant("Codex error: The usage limit has been reached") });
			await Bun.sleep(5);
			expect(harness.calls.joins).toBe(0);

			harness.setIdle(true);
			await harness.emit("agent_settled");
			await expectSuccessfulRecovery(harness);
		} finally {
			await harness.shutdown();
		}
	});

	test("an exact quota error rotates when live usage is below ten percent", async () => {
		const harness = recoveryHarness(new FakeEventBus(), { usageScore: 9 });
		try {
			await harness.emit("before_provider_request");
			await harness.emit("message_end", { message: assistant("Codex error: The usage limit has been reached") });
			harness.setIdle(true);
			await harness.emit("agent_settled");
			await expectSuccessfulRecovery(harness);
			expect(harness.notices.some((notice) => notice.includes("less than 10% remains"))).toBe(true);
		} finally {
			await harness.shutdown();
		}
	});

	test("ten percent remaining keeps the account and retries once", async () => {
		const harness = recoveryHarness(new FakeEventBus(), { usageScore: 10 });
		try {
			await harness.emit("before_provider_request");
			await harness.emit("message_end", { message: assistant("Codex error: The usage limit has been reached") });
			harness.setIdle(true);
			await harness.emit("agent_settled");
			await waitFor(() => harness.calls.continuations === 1, "threshold boundary did not retry");
			expect(harness.calls.selections).toBe(0);
			expect(harness.notices.some((notice) => notice.includes("requires less than 10% remaining"))).toBe(true);
		} finally {
			await harness.shutdown();
		}
	});

	test("a false usage-limit response keeps the account and retries once", async () => {
		const harness = recoveryHarness(new FakeEventBus(), { usageScore: 97 });
		try {
			await harness.emit("before_provider_request");
			await harness.emit("message_end", { message: assistant("Codex error: The usage limit has been reached") });
			harness.setIdle(true);
			await harness.emit("agent_settled");
			await waitFor(() => harness.calls.continuations === 1, "false quota response did not retry");
			expect(harness.calls).toEqual({ joins: 1, confirmations: 1, selections: 0, completions: 1, continuations: 1 });
			expect(harness.notices.some((notice) => notice.includes("97% left"))).toBe(true);
			expect(harness.notices.some((notice) => notice.includes("retrying once on the same account"))).toBe(true);
			expect(harness.notices.some((notice) => notice.includes("manual intervention"))).toBe(false);
		} finally {
			await harness.shutdown();
		}
	});

	test("a one-shot child stays alive until its recovered continuation settles", async () => {
		const harness = recoveryHarness(new FakeEventBus(), { mode: "json", holdContinuation: true });
		let settled = false;
		try {
			await harness.emit("before_provider_request");
			await harness.emit("message_end", { message: assistant("Codex error: The usage limit has been reached") });
			await Bun.sleep(5);
			expect(harness.calls.joins).toBe(0);

			harness.setIdle(true);
			const settling = harness.emit("agent_settled").then(() => { settled = true; });
			await waitFor(() => harness.calls.continuations === 1, "child recovery did not start continuation");
			await Bun.sleep(10);
			expect(settled).toBe(false);

			harness.setIdle(true);
			await settling;
			expect(settled).toBe(true);
			await expectSuccessfulRecovery(harness);
		} finally {
			harness.setIdle(true);
			await harness.shutdown();
		}
	});

	test("an expired leader cannot perform seat, model, or sync side effects", async () => {
		const harness = recoveryHarness(new FakeEventBus(), {
			mode: "json",
			expireBeforeSelection: true,
		});
		try {
			await harness.emit("before_provider_request");
			await harness.emit("message_end", {
				message: assistant("Codex error: The usage limit has been reached"),
			});
			harness.setIdle(true);
			await harness.emit("agent_settled");
			expect(harness.calls.confirmations).toBe(1);
			expect(harness.calls.selections).toBe(0);
			expect(harness.calls.continuations).toBe(0);
		} finally {
			await harness.shutdown();
		}
	});

	test("a one-shot child stops waiting if its leader cannot finish the coordinator state", async () => {
		const harness = recoveryHarness(new FakeEventBus(), { mode: "json", failCompletion: true });
		try {
			await harness.emit("before_provider_request");
			await harness.emit("message_end", { message: assistant("Codex error: The usage limit has been reached") });
			harness.setIdle(true);
			await harness.emit("agent_settled");
			expect(harness.calls.completions).toBe(1);
			expect(harness.calls.continuations).toBe(0);
			expect(harness.notices.some((notice) => notice.includes("fake coordinator write failure"))).toBe(true);
		} finally {
			await harness.shutdown();
		}
	});

	test("a one-shot child stops waiting if coordinator ownership is lost without state", async () => {
		const harness = recoveryHarness(new FakeEventBus(), { mode: "json", uncommittedCompletion: true });
		try {
			await harness.emit("before_provider_request");
			await harness.emit("message_end", { message: assistant("Codex error: The usage limit has been reached") });
			harness.setIdle(true);
			await harness.emit("agent_settled");
			expect(harness.calls.completions).toBe(1);
			expect(harness.calls.continuations).toBe(0);
			expect(harness.notices.some((notice) => notice.includes("lost coordinator ownership"))).toBe(true);
		} finally {
			await harness.shutdown();
		}
	});

	test("a compaction quota signal remains pending until agent_settled", async () => {
		const harness = recoveryHarness();
		try {
			expect(reportCompactionUsageLimit(
				harness.pi,
				harness.context,
				assistant("Codex error: The usage limit has been reached."),
			)).toBe(true);
			await Bun.sleep(5);
			expect(harness.calls.joins).toBe(0);
			await harness.emit("message_end", { message: assistant("Codex error: Server overloaded") });

			harness.setIdle(true);
			await harness.emit("agent_settled");
			harness.setIdle(false);
			await Bun.sleep(5);
			expect(harness.calls.joins).toBe(0);

			harness.setIdle(true);
			await harness.emit("agent_settled");
			await expectSuccessfulRecovery(harness);
		} finally {
			await harness.shutdown();
		}
	});

	test("transient failures never schedule or preserve a main-response candidate", async () => {
		const harness = recoveryHarness();
		try {
			await harness.emit("before_provider_request");
			await harness.emit("message_end", { message: assistant("Codex error: The usage limit has been reached") });
			for (const error of ["Codex error: Server overloaded", "Codex error: 429 Too Many Requests"]) {
				await harness.emit("message_end", { message: assistant(error) });
				expect(reportCompactionUsageLimit(harness.pi, harness.context, assistant(error))).toBe(false);
			}
			harness.bus.emit(CODEX_USAGE_LIMIT_SIGNAL_CHANNEL, {
				provider: "codex-pi9",
				model: "gpt-5.6-sol",
				context: {},
			});
			harness.setIdle(true);
			await harness.emit("agent_settled");
			await Bun.sleep(10);
			expect(harness.calls.joins).toBe(0);
			expect(harness.calls.continuations).toBe(0);
		} finally {
			await harness.shutdown();
		}
	});

	test("session shutdown removes the event-bus listener and replacement reinstalls it", async () => {
		const bus = new FakeEventBus();
		const original = recoveryHarness(bus);
		expect(bus.listenerCount(CODEX_USAGE_LIMIT_SIGNAL_CHANNEL)).toBe(1);
		await original.shutdown();
		expect(bus.listenerCount(CODEX_USAGE_LIMIT_SIGNAL_CHANNEL)).toBe(0);

		const replacement = recoveryHarness(bus);
		try {
			expect(bus.listenerCount(CODEX_USAGE_LIMIT_SIGNAL_CHANNEL)).toBe(1);
			replacement.setIdle(true);
			expect(reportCompactionUsageLimit(
				replacement.pi,
				replacement.context,
				assistant("Codex error: The usage limit has been reached"),
			)).toBe(true);
			await replacement.emit("agent_settled");
			await expectSuccessfulRecovery(replacement);
		} finally {
			await replacement.shutdown();
		}
		expect(bus.listenerCount(CODEX_USAGE_LIMIT_SIGNAL_CHANNEL)).toBe(0);
	});
});

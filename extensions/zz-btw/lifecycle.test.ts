import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import test from "node:test";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	createAssistantMessageEventStream,
	type ApiStreamSimpleFunction,
	type AssistantMessage,
	type Context,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai/compat";
import {
	SessionManager,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import btwExtension, {
	BTW_TURN_ENTRY_TYPE,
	BtwOverlay,
	sideAffinityFetch,
	withoutIncompleteToolExchange,
	type BtwTurnEntryData,
} from "./index.ts";

const TEST_API_KEY = `header.${Buffer.from(JSON.stringify({
	"https://api.openai.com/auth": { chatgpt_account_id: "test-account" },
})).toString("base64url")}.signature`;

const model = {
	id: "gpt-test",
	name: "GPT test",
	api: "openai-codex-responses",
	provider: "test-provider",
	baseUrl: "https://example.invalid",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 4_096,
} as Model<"openai-codex-responses">;

const lunaModel = {
	...model,
	id: "gpt-6-luna",
	name: "GPT-5.6 Luna",
} as Model<"openai-codex-responses">;

const parentPayload = {
	model: model.id,
	instructions: "stable system prompt",
	input: [{ role: "user", content: [{ type: "input_text", text: "parent question" }] }],
	tools: [{ type: "function", name: "read" }],
	prompt_cache_key: "session-1",
	tool_choice: "auto",
	store: false,
	stream: true,
};

function assistant(cacheRead: number, input: number, text = "parent answer"): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		responseId: "parent-response",
		usage: {
			input,
			output: 10,
			cacheRead,
			cacheWrite: 0,
			totalTokens: input + cacheRead + 10,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 10_000,
	};
}

type Handler = (event: any, ctx: ExtensionContext) => unknown;
type Command = { handler: (args: string, ctx: ExtensionCommandContext) => unknown };

function harness(
	streamSimple: ApiStreamSimpleFunction,
	fetch?: typeof globalThis.fetch,
	persistentSessionManager?: SessionManager,
) {
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, Command>();
	const notifications: string[] = [];
	let now = 10_000;
	let idle = true;
	let overlay: BtwOverlay | undefined;
	let customCalls = 0;
	let sessionEntries: any[] = [];
	let currentSessionId = "session-1";
	const persistedEntries: Array<{ sessionId: string; customType: string; data: any }> = [];
	const sessionManager = persistentSessionManager ?? {
		getSessionId: () => currentSessionId,
		getSessionFile: () => undefined,
		buildContextEntries: () => sessionEntries,
	};
	const tui = {
		terminal: { rows: 40 },
		requestRender() {},
	} as unknown as TUI;
	const theme = {
		fg: (_color: string, text: string) => text,
	} as unknown as Theme;
	const context = {
		cwd: "/tmp/project",
		mode: "tui",
		hasUI: true,
		model,
		isIdle: () => idle,
		sessionManager,
		modelRegistry: {
			find: (provider: string, modelId: string) => provider === model.provider && modelId === lunaModel.id ? lunaModel : undefined,
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: TEST_API_KEY, headers: {}, env: { CUSTOM_PROVIDER_ENV: "kept" } }),
		},
		getSystemPrompt: () => "effective parent system prompt",
		ui: {
			notify(message: string) { notifications.push(message); },
			custom<T>(factory: (tui: TUI, theme: Theme, keybindings: unknown, done: (value: T) => void) => Component) {
				customCalls++;
				return new Promise<T>((resolve) => {
					overlay = factory(tui, theme, {}, resolve as (value: T) => void) as BtwOverlay;
					overlay.focused = true;
				});
			},
		},
	} as unknown as ExtensionCommandContext;
	const pi = {
		on(event: string, handler: Handler) {
			const eventHandlers = handlers.get(event) ?? [];
			eventHandlers.push(handler);
			handlers.set(event, eventHandlers);
		},
		registerCommand(name: string, command: Command) { commands.set(name, command); },
		appendEntry(customType: string, data: unknown) {
			persistedEntries.push({ sessionId: sessionManager.getSessionId(), customType, data });
			if (persistentSessionManager) persistentSessionManager.appendCustomEntry(customType, data);
		},
		getThinkingLevel: () => "high",
	} as unknown as ExtensionAPI;
	btwExtension(pi, { now: () => now, streamSimple, fetch });

	async function emit(event: string, value: any = {}) {
		for (const handler of handlers.get(event) ?? []) await handler(value, context);
	}

	let parentMessage: AgentMessage | undefined;

	async function beginParent(payload: unknown = parentPayload) {
		idle = false;
		await emit("agent_start");
		parentMessage = {
			role: "user",
			content: [{ type: "text", text: "parent question" }],
			timestamp: now,
		};
		await emit("context", { messages: [parentMessage] });
		await emit("before_provider_headers", {
			headers: { authorization: `Bearer ${TEST_API_KEY}`, "x-custom-auth": "kept" },
		});
		await emit("before_provider_request", { payload: structuredClone(payload) });
	}

	async function finishParent(response: AssistantMessage) {
		assert.ok(parentMessage);
		await emit("message_start", { message: response });
		await emit("message_update", {
			message: response,
			assistantMessageEvent: { type: "text_delta", delta: "parent answer" },
		});
		await emit("message_end", { message: response });
		await emit("agent_end", { messages: [parentMessage, response] });
		parentMessage = undefined;
		idle = true;
	}

	async function completeParent(response: AssistantMessage, payload: unknown = parentPayload) {
		await beginParent(payload);
		await finishParent(response);
	}

	return {
		commands,
		context,
		notifications,
		emit,
		beginParent,
		finishParent,
		completeParent,
		advance(ms: number) { now += ms; },
		setNow(value: number) { now = value; },
		setSessionEntries(entries: any[]) { sessionEntries = entries; },
		setSessionId(sessionId: string) { currentSessionId = sessionId; },
		get persistedEntries() { return persistedEntries; },
		get now() { return now; },
		get overlay() { return overlay; },
		get customCalls() { return customCalls; },
	};
}

async function waitFor(predicate: () => boolean, message: string) {
	for (let attempt = 0; attempt < 200; attempt++) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 1));
	}
	assert.fail(message);
}

function persistedTurns(h: ReturnType<typeof harness>) {
	return h.persistedEntries
		.filter((entry) => entry.customType === BTW_TURN_ENTRY_TYPE)
		.map((entry) => entry.data as BtwTurnEntryData);
}

test("/btw-luna materializes history before a parent assistant message exists", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-btw-persistence-"));
	try {
		const manager = SessionManager.create(root, join(root, "sessions"));
		const sessionFile = manager.getSessionFile()!;
		let authStarted = false;
		let releaseAuth!: () => void;
		const authReady = new Promise<void>((resolve) => { releaseAuth = resolve; });
		const h = harness(successfulLunaStream([]), undefined, manager);
		h.context.modelRegistry.getApiKeyAndHeaders = async () => {
			authStarted = true;
			await authReady;
			return { ok: true, apiKey: TEST_API_KEY, headers: {}, env: {} };
		};

		const command = h.commands.get("btw-luna")!.handler("durable before parent answer", h.context) as Promise<void>;
		await waitFor(() => authStarted, "Luna authentication did not start");
		assert.equal(manager.getEntries().some((entry) => entry.type === "message" && entry.message.role === "assistant"), false);
		assert.equal(existsSync(sessionFile), true);
		const onDisk = readFileSync(sessionFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
		assert.equal(onDisk.length, 2);
		assert.equal(onDisk[1].type, "custom");
		assert.equal(onDisk[1].customType, BTW_TURN_ENTRY_TYPE);
		assert.equal(onDisk[1].data.status, "submitted");

		releaseAuth();
		await waitFor(() => h.overlay?.isLoading === false, "Luna turn did not complete");
		h.overlay!.close();
		await command;
		assert.doesNotThrow(() => manager.appendMessage(assistant(0, 0)));
		const reopened = SessionManager.open(sessionFile);
		assert.equal(reopened.getEntries().some((entry) => entry.type === "custom" && entry.customType === BTW_TURN_ENTRY_TYPE), true);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

function candidatePayload(context: Context) {
	const suffix = context.messages.slice(1).map((message) => {
		assert.ok(message.role === "user" || message.role === "assistant");
		const text = typeof message.content === "string"
			? message.content
			: message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
		return {
			type: "message",
			role: message.role,
			content: [{ type: message.role === "user" ? "input_text" : "output_text", text }],
		};
	});
	return { ...parentPayload, input: [...parentPayload.input, ...suffix] };
}

function sideResult(cacheRead: number): AssistantMessage {
	return {
		...assistant(cacheRead, 1, "side answer"),
		responseId: "side-response",
		usage: {
			input: 1,
			output: 2,
			cacheRead,
			cacheWrite: 0,
			totalTokens: cacheRead + 3,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

function successfulStream(onDispatch: () => void, cacheRead = 1_800): ApiStreamSimpleFunction {
	return ((streamModel: Model<any>, streamContext: Context, options: SimpleStreamOptions = {}) => {
		const stream = createAssistantMessageEventStream();
		queueMicrotask(async () => {
			try {
				await options.onPayload?.(candidatePayload(streamContext), streamModel);
				onDispatch();
				await options.onResponse?.({ status: 200, headers: {} }, streamModel);
				const result = sideResult(cacheRead);
				stream.push({ type: "done", reason: "stop", message: result });
				stream.end();
			} catch (error) {
				stream.end({ ...sideResult(1_800), stopReason: "error", errorMessage: String(error) });
			}
		});
		return stream;
	}) as ApiStreamSimpleFunction;
}

test("/btw persists initial and follow-up questions with their final answers", async () => {
	let dispatches = 0;
	const h = harness(successfulStream(() => { dispatches++; }));
	await h.completeParent(assistant(1_800, 200));

	const command = h.commands.get("btw")!.handler("first persisted question", h.context) as Promise<void>;
	await waitFor(() => dispatches === 1 && h.overlay?.isLoading === false, "first /btw turn did not complete");
	for (const char of "persisted follow-up") h.overlay!.handleInput(char);
	h.overlay!.handleInput("\r");
	await waitFor(() => dispatches === 2 && h.overlay?.isLoading === false, "/btw follow-up did not complete");
	h.overlay!.close();
	await command;

	const turns = persistedTurns(h);
	assert.deepEqual(turns.map((entry) => [entry.turnIndex, entry.status, entry.question, entry.answer]), [
		[0, "submitted", "first persisted question", undefined],
		[0, "completed", "first persisted question", "side answer"],
		[1, "submitted", "persisted follow-up", undefined],
		[1, "completed", "persisted follow-up", "side answer"],
	]);
	assert.equal(new Set(turns.map((entry) => entry.runId)).size, 1);
	assert.equal(new Set(turns.filter((entry) => entry.turnIndex === 0).map((entry) => entry.turnId)).size, 1);
	assert.ok(turns.every((entry) => entry.mode === "btw"));
});

test("idle stale question waits, retargets a completed fresh parent, and sends once", async () => {
	let dispatches = 0;
	const h = harness(successfulStream(() => { dispatches++; }));
	await h.completeParent(assistant(1_800, 200));
	h.advance(5 * 60_000);

	const command = h.commands.get("btw")!.handler("side question", h.context) as Promise<void>;
	await waitFor(() => !!h.overlay?.render(100).join("\n").match(/300s limit/), "stale question did not remain waiting");
	assert.equal(dispatches, 0);

	await h.completeParent(assistant(1_800, 200));
	await waitFor(() => dispatches === 1, "fresh parent did not release the waiting question");
	await new Promise((resolve) => setTimeout(resolve, 25));
	assert.equal(dispatches, 1);
	h.overlay!.close();
	await command;
});

test("future parent request timestamps block without sending", async () => {
	let streamCalls = 0;
	const h = harness((() => {
		streamCalls++;
		throw new Error("future capsule must not create a side stream");
	}) as ApiStreamSimpleFunction);
	await h.completeParent(assistant(1_800, 200));
	h.setNow(h.now - 1);

	const command = h.commands.get("btw")!.handler("unsafe future question", h.context) as Promise<void>;
	await waitFor(
		() => !!h.overlay?.render(120).join("\n").match(/timestamp is in the future/),
		"future timestamp safety error did not surface",
	);
	assert.equal(streamCalls, 0);
	h.overlay!.handleInput("\x1b");
	await command;
});

test("active parent question waits for completion without a fixed visibility delay", async () => {
	let dispatches = 0;
	const h = harness(successfulStream(() => { dispatches++; }));
	await h.beginParent();
	const command = h.commands.get("btw")!.handler("side question", h.context) as Promise<void>;
	await waitFor(() => !!h.overlay?.render(100).join("\n").match(/not warmed|parent response/), "active question did not wait");
	assert.equal(dispatches, 0);

	await h.finishParent(assistant(1_800, 200));
	await waitFor(() => dispatches === 1, "completed parent did not release the question");
	h.overlay!.close();
	await command;
});

test("parent cache coverage is not an admission requirement", async () => {
	let dispatches = 0;
	const h = harness(successfulStream(() => { dispatches++; }));
	await h.completeParent(assistant(0, 2_000));

	const command = h.commands.get("btw")!.handler("side question", h.context) as Promise<void>;
	await waitFor(() => dispatches === 1, "parent cache miss incorrectly blocked the side request");
	h.overlay!.close();
	await command;
});

test("short parent prefix waits until a parent meets the exact token minimum", async () => {
	let dispatches = 0;
	const h = harness(successfulStream(() => { dispatches++; }));
	await h.completeParent(assistant(900, 100));

	const command = h.commands.get("btw")!.handler("side question", h.context) as Promise<void>;
	await waitFor(() => !!h.overlay?.render(100).join("\n").match(/only 1000 tokens.*at least 1024/), "short parent prefix did not wait");
	assert.equal(dispatches, 0);

	await h.completeParent(assistant(1_800, 200));
	await waitFor(() => dispatches === 1, "large parent prefix did not release the question");
	h.overlay!.close();
	await command;
});

test("Escape cancels a stale wait and no later parent can send it", async () => {
	let streamCalls = 0;
	const h = harness((() => {
		streamCalls++;
		throw new Error("cancelled question must not create a stream");
	}) as ApiStreamSimpleFunction);
	await h.completeParent(assistant(1_800, 200));
	h.advance(5 * 60_000);

	const command = h.commands.get("btw")!.handler("discard me", h.context) as Promise<void>;
	await waitFor(() => !!h.overlay?.render(100).join("\n").match(/300s limit/), "stale question did not wait");
	h.overlay!.handleInput("\x1b");
	await command;
	await h.completeParent(assistant(1_800, 200));
	await new Promise((resolve) => setTimeout(resolve, 25));
	assert.equal(streamCalls, 0);
	assert.equal(h.overlay!.closedBy, "escape");
});

test("freshness expiry inside onPayload sends nothing, returns to waiting, then retargets", async () => {
	let streamCalls = 0;
	let dispatches = 0;
	let firstRejection: unknown;
	let h: ReturnType<typeof harness>;
	const mockStream = ((streamModel: Model<any>, streamContext: Context, options: SimpleStreamOptions = {}) => {
		streamCalls++;
		const stream = createAssistantMessageEventStream();
		queueMicrotask(async () => {
			if (streamCalls === 1) h.setNow(10_000 + 5 * 60_000);
			try {
				await options.onPayload?.(candidatePayload(streamContext), streamModel);
				dispatches++;
				await options.onResponse?.({ status: 200, headers: {} }, streamModel);
				const result = sideResult(1_800);
				stream.push({ type: "done", reason: "stop", message: result });
				stream.end();
			} catch (error) {
				firstRejection ??= error;
				stream.end({ ...sideResult(1_800), stopReason: "error", errorMessage: String(error) });
			}
		});
		return stream;
	}) as ApiStreamSimpleFunction;
	h = harness(mockStream);
	await h.completeParent(assistant(1_800, 200));

	const command = h.commands.get("btw")!.handler("side question", h.context) as Promise<void>;
	await waitFor(() => firstRejection !== undefined, "onPayload did not perform the dispatch-time freshness check");
	await waitFor(() => !!h.overlay?.render(100).join("\n").match(/300s limit/), "dispatch race did not return to waiting");
	assert.equal(dispatches, 0);

	await h.completeParent(assistant(1_800, 200));
	await waitFor(() => dispatches === 1, "fresh parent did not release the deferred dispatch");
	assert.equal(streamCalls, 2);
	h.overlay!.close();
	await command;
});

test("a consumed completed capsule retargets the next question to a fresh parent", async () => {
	let streamCalls = 0;
	let dispatches = 0;
	const stream = successfulStream(() => { dispatches++; });
	const h = harness(((...args: Parameters<ApiStreamSimpleFunction>) => {
		streamCalls++;
		return stream(...args);
	}) as ApiStreamSimpleFunction);
	await h.completeParent(assistant(1_800, 200));

	const firstCommand = h.commands.get("btw")!.handler("first question", h.context) as Promise<void>;
	await waitFor(() => dispatches === 1 && !!h.overlay?.render(100).join("\n").match(/Enter sends follow-up/), "first question did not complete");
	h.overlay!.close();
	await firstCommand;

	const secondCommand = h.commands.get("btw")!.handler("second question", h.context) as Promise<void>;
	await waitFor(() => !!h.overlay?.render(100).join("\n").match(/already used by \/btw/), "consumed capsule did not wait");
	assert.equal(streamCalls, 1);
	await h.completeParent(assistant(1_800, 200));
	await waitFor(() => dispatches === 2, "fresh parent did not replace the consumed capsule");
	assert.equal(streamCalls, 2);
	h.overlay!.close();
	await secondCommand;
});

test("expired follow-up is not sent or silently rebased onto a new parent", async () => {
	let streamCalls = 0;
	let dispatches = 0;
	const stream = successfulStream(() => { dispatches++; });
	const h = harness(((...args: Parameters<ApiStreamSimpleFunction>) => {
		streamCalls++;
		return stream(...args);
	}) as ApiStreamSimpleFunction);
	await h.completeParent(assistant(1_800, 200));

	const command = h.commands.get("btw")!.handler("first question", h.context) as Promise<void>;
	await waitFor(() => dispatches === 1 && !!h.overlay?.render(100).join("\n").match(/Enter sends follow-up/), "first side turn did not complete");
	h.advance(5 * 60_000);
	for (const char of "expired follow-up") h.overlay!.handleInput(char);
	h.overlay!.handleInput("\r");
	await waitFor(() => !!h.overlay?.render(120).join("\n").match(/cannot be safely rebased/), "unsafe follow-up rebase was not surfaced");
	assert.equal(streamCalls, 1);

	await h.completeParent(assistant(1_800, 200));
	await new Promise((resolve) => setTimeout(resolve, 25));
	assert.equal(dispatches, 1);
	assert.equal(streamCalls, 1);
	h.overlay!.close();
	await command;
});

test("provider-hosted tools remain a permanent no-send safety error", async () => {
	let streamCalls = 0;
	const h = harness((() => {
		streamCalls++;
		throw new Error("unsafe parent must not create a side stream");
	}) as ApiStreamSimpleFunction);
	await h.completeParent(assistant(1_800, 200), {
		...parentPayload,
		tools: [{ type: "web_search" }],
	});
	h.advance(60_000);

	const command = h.commands.get("btw")!.handler("unsafe question", h.context) as Promise<void>;
	await waitFor(() => !!h.overlay?.render(120).join("\n").match(/cannot safely inherit provider-hosted tools/), "tool safety error did not surface");
	assert.equal(streamCalls, 0);
	h.overlay!.handleInput("\x1b");
	await command;
});

test("malformed parent payload fails instead of waiting forever", async () => {
	let streamCalls = 0;
	const h = harness((() => {
		streamCalls++;
		throw new Error("malformed parent must not create a side stream");
	}) as ApiStreamSimpleFunction);
	await h.completeParent(assistant(1_800, 200), { ...parentPayload, input: "not-an-array" });

	const command = h.commands.get("btw")!.handler("malformed question", h.context) as Promise<void>;
	await waitFor(() => !!h.overlay?.render(120).join("\n").match(/not a cache-forkable Responses request/), "malformed payload error did not surface");
	assert.equal(streamCalls, 0);
	assert.equal(persistedTurns(h).at(-1)?.status, "error");
	assert.match(persistedTurns(h).at(-1)?.error ?? "", /not a cache-forkable Responses request/);
	h.overlay!.close();
	await command;
});

test("session shutdown aborts a wait and prevents later sends", async () => {
	let streamCalls = 0;
	const h = harness((() => {
		streamCalls++;
		throw new Error("shutdown question must not create a stream");
	}) as ApiStreamSimpleFunction);
	await h.completeParent(assistant(1_800, 200));
	h.advance(5 * 60_000);

	const command = h.commands.get("btw")!.handler("discard on shutdown", h.context) as Promise<void>;
	await waitFor(() => !!h.overlay?.render(100).join("\n").match(/300s limit/), "question did not enter waiting state");
	await h.emit("session_shutdown", { reason: "reload" });
	await command;
	await h.completeParent(assistant(1_800, 200));
	await new Promise((resolve) => setTimeout(resolve, 25));
	assert.equal(streamCalls, 0);
	assert.match(h.overlay!.closedBy ?? "", /session_shutdown/);
	assert.deepEqual(persistedTurns(h).map((entry) => entry.status), ["submitted", "cancelled"]);
	assert.match(persistedTurns(h).at(-1)?.reason ?? "", /session_shutdown:reload/);
});

async function assertSideCacheWarningAllowsFollowUp(firstCacheRead: number, warning: RegExp) {
	const contexts: Context[] = [];
	const transportSessionIds: Array<string | undefined> = [];
	const streamOptions: SimpleStreamOptions[] = [];
	const mockStream = ((streamModel: Model<any>, streamContext: Context, options: SimpleStreamOptions = {}) => {
		contexts.push(structuredClone(streamContext));
		transportSessionIds.push(options.sessionId);
		streamOptions.push(options);
		const stream = createAssistantMessageEventStream();
		queueMicrotask(async () => {
			try {
				await options.onPayload?.(candidatePayload(streamContext), streamModel);
				await options.onResponse?.({ status: 200, headers: {} }, streamModel);
				const result = sideResult(contexts.length === 1 ? firstCacheRead : 1_800);
				stream.push({ type: "done", reason: "stop", message: result });
				stream.end();
			} catch (error) {
				stream.end({ ...sideResult(1_800), stopReason: "error", errorMessage: String(error) });
			}
		});
		return stream;
	}) as ApiStreamSimpleFunction;
	const h = harness(mockStream);
	await h.completeParent(assistant(1_800, 200));

	const command = h.commands.get("btw")!.handler("side question", h.context) as Promise<void>;
	await waitFor(
		() => contexts.length === 1 && !!h.overlay?.render(120).join("\n").match(warning),
		"first side result did not retain its cache warning",
	);
	for (const char of "follow up anyway") h.overlay!.handleInput(char);
	h.overlay!.handleInput("\r");
	await waitFor(() => contexts.length === 2, "cache warning permanently disabled the follow-up");

	assert.equal(transportSessionIds[1], transportSessionIds[0]);
	for (const options of streamOptions) {
		assert.equal(options.transport, "sse");
		assert.equal(options.toolChoice, "none");
		assert.equal(options.maxRetries, 0);
		assert.deepEqual(options.env, { CUSTOM_PROVIDER_ENV: "kept" });
		assert.equal(typeof options.fetch, "function");
		assert.equal("cacheSessionId" in options, false);
	}
	assert.deepEqual(contexts[1]!.messages.map((message) => message.role), ["user", "assistant", "user", "assistant", "user"]);
	const historyText = JSON.stringify(contexts[1]!.messages);
	assert.match(historyText, /side question/);
	assert.match(historyText, /side answer/);
	assert.match(historyText, /follow up anyway/);
	h.overlay!.close();
	await command;
}

test("a successful side cache miss warns but dispatches a follow-up on the same thread and history", async () => {
	await assertSideCacheWarningAllowsFollowUp(0, /cache MISS/);
});

test("successful partial side cache coverage warns but dispatches a follow-up on the same thread and history", async () => {
	await assertSideCacheWarningAllowsFollowUp(1_799, /poor parent cache coverage: 89\.95%/);
});

test("a successful side response that expires before completion still blocks follow-ups", async () => {
	let streamCalls = 0;
	let h: ReturnType<typeof harness>;
	const mockStream = ((streamModel: Model<any>, streamContext: Context, options: SimpleStreamOptions = {}) => {
		streamCalls++;
		const stream = createAssistantMessageEventStream();
		queueMicrotask(async () => {
			try {
				await options.onPayload?.(candidatePayload(streamContext), streamModel);
				await options.onResponse?.({ status: 200, headers: {} }, streamModel);
				if (streamCalls === 1) h.advance(5 * 60_000);
				const result = sideResult(0);
				stream.push({ type: "done", reason: "stop", message: result });
				stream.end();
			} catch (error) {
				stream.end({ ...sideResult(1_800), stopReason: "error", errorMessage: String(error) });
			}
		});
		return stream;
	}) as ApiStreamSimpleFunction;
	h = harness(mockStream);
	await h.completeParent(assistant(1_800, 200));

	const command = h.commands.get("btw")!.handler("side question", h.context) as Promise<void>;
	await waitFor(
		() => !!h.overlay?.render(120).join("\n").match(/successful request is already 300s old/),
		"expired successful side request did not block follow-ups",
	);
	for (const char of "too late") h.overlay!.handleInput(char);
	h.overlay!.handleInput("\r");
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(streamCalls, 1);
	h.overlay!.close();
	await command;
});

test("side affinity fetch preserves Request and init headers while overriding final identity", async () => {
	const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
	const underlying = (async (input: RequestInfo | URL, init?: RequestInit) => {
		calls.push({ input, init });
		return new Response("ok");
	}) as typeof globalThis.fetch;
	const wrapped = sideAffinityFetch(underlying, "parent-session", "side-thread");

	await wrapped("https://example.invalid/string", { headers: new Headers({ "x-init": "kept" }) });
	const request = new Request("https://example.invalid/request", { headers: { "x-request": "kept" } });
	await wrapped(request);
	await wrapped(request, { headers: new Headers({ "x-init-override": "kept" }) });

	assert.equal(calls[0]!.input, "https://example.invalid/string");
	assert.equal(calls[1]!.input, request);
	assert.equal(new Headers(calls[0]!.init?.headers).get("x-init"), "kept");
	assert.equal(new Headers(calls[1]!.init?.headers).get("x-request"), "kept");
	assert.equal(new Headers(calls[2]!.init?.headers).get("x-init-override"), "kept");
	assert.equal(new Headers(calls[2]!.init?.headers).get("x-request"), null);
	for (const call of calls) {
		const headers = new Headers(call.init?.headers);
		assert.equal(headers.get("session-id"), "parent-session");
		assert.equal(headers.get("thread-id"), "side-thread");
		assert.equal(headers.get("x-client-request-id"), "side-thread");
	}
});

test("installed SSE adapter receives final affinity headers and isolates two side threads", async () => {
	const releaseRoot = process.env.PI_CODEX_ULTRA_RELEASE_ROOT
		?? join(homedir(), ".local/share/pi-codex-ultra/current");
	const installed = await import(`${releaseRoot}/node_modules/@earendil-works/pi-ai/dist/api/openai-codex-responses.js`);
	const installedStreamSimple = installed.streamSimple as ApiStreamSimpleFunction;
	const globalFetchBefore = globalThis.fetch;
	const requests: Array<{ headers: Headers; body: Record<string, unknown> }> = [];
	const mockFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
		const headers = new Headers(init?.headers);
		const wire = init?.body;
		assert.ok(typeof wire === "string" || wire instanceof Uint8Array);
		const bytes = typeof wire === "string" ? Buffer.from(wire) : Buffer.from(wire);
		const json = headers.get("content-encoding") === "zstd"
			? zstdDecompressSync(bytes).toString("utf8")
			: bytes.toString("utf8");
		requests.push({ headers, body: JSON.parse(json) as Record<string, unknown> });
		const response = {
			type: "response.completed",
			response: {
				id: `side-response-${requests.length}`,
				status: "completed",
				output: [],
				usage: {
					input_tokens: 2_000,
					input_tokens_details: { cached_tokens: 0 },
					output_tokens: 0,
					total_tokens: 2_000,
				},
			},
		};
		return new Response(`data: ${JSON.stringify(response)}\n\n`, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	}) as typeof globalThis.fetch;
	const parentBefore = structuredClone(parentPayload);
	const h = harness(installedStreamSimple, mockFetch);

	for (let index = 0; index < 2; index++) {
		await h.completeParent(assistant(0, 2_000));
		const command = h.commands.get("btw")!.handler(`side question ${index}`, h.context) as Promise<void>;
		await waitFor(
			() => requests.length === index + 1 && !!h.overlay?.render(120).join("\n").match(/cache MISS/),
			`side request ${index + 1} did not complete through the installed SSE adapter`,
		);
		await new Promise((resolve) => setTimeout(resolve, 10));
		assert.equal(requests.length, index + 1, "a completed cache miss must not retry automatically");
		h.overlay!.close();
		await command;
		h.advance(1);
	}

	assert.equal(globalThis.fetch, globalFetchBefore);
	assert.deepEqual(parentPayload, parentBefore);
	assert.notEqual(requests[0]!.headers.get("thread-id"), requests[1]!.headers.get("thread-id"));
	for (const { headers, body } of requests) {
		const sideThreadId = headers.get("thread-id");
		assert.ok(sideThreadId?.startsWith("session-1:btw:"));
		assert.equal(headers.get("session-id"), "session-1");
		assert.equal(headers.get("x-client-request-id"), sideThreadId);
		assert.equal(headers.get("x-custom-auth"), "kept");
		assert.equal(headers.get("openai-beta"), "responses=experimental");
		assert.equal(body.prompt_cache_key, parentPayload.prompt_cache_key);
		assert.equal(body.tool_choice, "none");
		assert.deepEqual(body.tools, parentPayload.tools);
		assert.deepEqual((body.input as unknown[]).slice(0, parentPayload.input.length), parentPayload.input);
		const { input: _parentInput, tool_choice: _parentToolChoice, ...parentBody } = parentPayload;
		const { input: _sideInput, tool_choice: _sideToolChoice, ...sideBody } = body;
		assert.deepEqual(sideBody, parentBody);
	}
});


function lunaResult(text = "luna answer"): AssistantMessage {
	return {
		...sideResult(0),
		provider: lunaModel.provider,
		model: lunaModel.id,
		responseId: `luna-${text}`,
		content: [{ type: "text", text }],
	};
}

function successfulLunaStream(
	contexts: Context[],
	optionsSeen: SimpleStreamOptions[] = [],
	expectedModel: Model<any> = lunaModel,
): ApiStreamSimpleFunction {
	return ((streamModel: Model<any>, streamContext: Context, options: SimpleStreamOptions = {}) => {
		assert.equal(streamModel.id, expectedModel.id);
		assert.equal(streamModel.contextWindow, expectedModel.contextWindow);
		contexts.push(structuredClone(streamContext));
		optionsSeen.push(options);
		const stream = createAssistantMessageEventStream();
		queueMicrotask(() => {
			const result = { ...lunaResult(), provider: expectedModel.provider, model: expectedModel.id };
			stream.push({ type: "text_delta", contentIndex: 0, delta: "luna answer", partial: result });
			stream.push({ type: "done", reason: "stop", message: result });
			stream.end();
		});
		return stream;
	}) as ApiStreamSimpleFunction;
}

test("/btw-luna persists initial and follow-up questions with their final answers", async () => {
	const contexts: Context[] = [];
	const h = harness(successfulLunaStream(contexts));

	const command = h.commands.get("btw-luna")!.handler("first Luna question", h.context) as Promise<void>;
	await waitFor(() => contexts.length === 1 && h.overlay?.isLoading === false, "first Luna turn did not complete");
	for (const char of "Luna follow-up") h.overlay!.handleInput(char);
	h.overlay!.handleInput("\r");
	await waitFor(() => contexts.length === 2 && h.overlay?.isLoading === false, "Luna follow-up did not complete");
	h.overlay!.close();
	await command;

	assert.deepEqual(persistedTurns(h).map((entry) => [entry.turnIndex, entry.status, entry.question, entry.answer]), [
		[0, "submitted", "first Luna question", undefined],
		[0, "completed", "first Luna question", "luna answer"],
		[1, "submitted", "Luna follow-up", undefined],
		[1, "completed", "Luna follow-up", "luna answer"],
	]);
	assert.ok(persistedTurns(h).every((entry) => entry.mode === "btw-luna"));
});

test("/btw-luna persists a partial answer when the user cancels", async () => {
	const partialStream = ((_model: Model<any>, _context: Context, options: SimpleStreamOptions = {}) => {
		const stream = createAssistantMessageEventStream();
		queueMicrotask(() => {
			const partial = lunaResult("partial Luna answer");
			stream.push({ type: "text_delta", contentIndex: 0, delta: "partial Luna answer", partial });
		});
		options.signal?.addEventListener("abort", () => {
			stream.end({ ...lunaResult(), stopReason: "aborted", errorMessage: "cancelled" });
		}, { once: true });
		return stream;
	}) as ApiStreamSimpleFunction;
	const h = harness(partialStream);

	const command = h.commands.get("btw-luna")!.handler("cancel after partial", h.context) as Promise<void>;
	await waitFor(() => h.overlay?.render(120).join("\n").includes("partial Luna answer") === true, "partial Luna answer did not stream");
	h.overlay!.handleInput("\u001b");
	await command;

	const terminal = persistedTurns(h).at(-1)!;
	assert.equal(terminal.status, "cancelled");
	assert.equal(terminal.answer, "partial Luna answer");
	assert.equal(terminal.reason, "escape");
});

test("/btw-luna persists a partial answer and error status on failure", async () => {
	const errorStream = (() => {
		const stream = createAssistantMessageEventStream();
		queueMicrotask(() => {
			const partial = lunaResult("partial before failure");
			stream.push({ type: "text_delta", contentIndex: 0, delta: "partial before failure", partial });
			stream.end({ ...partial, stopReason: "error", errorMessage: "provider failed" });
		});
		return stream;
	}) as ApiStreamSimpleFunction;
	const h = harness(errorStream);

	const command = h.commands.get("btw-luna")!.handler("fail after partial", h.context) as Promise<void>;
	await waitFor(() => persistedTurns(h).at(-1)?.status === "error", "Luna error was not persisted");
	const terminal = persistedTurns(h).at(-1)!;
	assert.equal(terminal.answer, "partial before failure");
	assert.match(terminal.error ?? "", /provider failed/);
	h.overlay!.close();
	await command;
});

test("session shutdown records pending Luna auth only in the old session", async () => {
	let resolveAuth: ((value: { ok: true; apiKey: string }) => void) | undefined;
	const h = harness(successfulStream(() => {}));
	(h.context.modelRegistry as any).getApiKeyAndHeaders = () => new Promise((resolve) => { resolveAuth = resolve; });

	const command = h.commands.get("btw-luna")!.handler("pending auth question", h.context) as Promise<void>;
	await waitFor(() => !!resolveAuth, "Luna authentication did not start");
	await h.emit("session_shutdown", { reason: "resume", targetSessionFile: "/new/session.jsonl" });
	h.setSessionId("session-2");
	resolveAuth!({ ok: true, apiKey: TEST_API_KEY });
	await command;

	const turns = persistedTurns(h);
	assert.deepEqual(turns.map((entry) => entry.status), ["submitted", "cancelled"]);
	assert.match(turns[1]!.reason ?? "", /session_shutdown:resume/);
	assert.ok(h.persistedEntries.every((entry) => entry.sessionId === "session-1"));
});

test("incomplete tool exchanges are removed as one batch while completed exchanges remain", () => {
	const user = { role: "user", content: [{ type: "text", text: "question" }], timestamp: 1 } as AgentMessage;
	const completedCall = {
		...assistant(0, 10),
		content: [{ type: "toolCall", id: "done", name: "read", arguments: {} }],
		stopReason: "toolUse",
	} as AgentMessage;
	const completedResult = {
		role: "toolResult",
		toolCallId: "done",
		toolName: "read",
		content: [{ type: "text", text: "result" }],
		isError: false,
		timestamp: 2,
	} as AgentMessage;
	const unfinishedCall = {
		...assistant(0, 10),
		content: [{ type: "toolCall", id: "running", name: "bash", arguments: { command: "sleep 30" } }],
		stopReason: "toolUse",
	} as AgentMessage;
	const afterUnfinished = { role: "user", content: [{ type: "text", text: "later" }], timestamp: 3 } as AgentMessage;

	assert.deepEqual(
		withoutIncompleteToolExchange([user, completedCall, completedResult, unfinishedCall, afterUnfinished]),
		[user, completedCall, completedResult],
	);
});

test("/btw-luna starts immediately from a restored session and keeps follow-ups on Luna", async () => {
	const contexts: Context[] = [];
	const optionsSeen: SimpleStreamOptions[] = [];
	const h = harness(successfulLunaStream(contexts, optionsSeen));
	const sessionUser = { role: "user", content: [{ type: "text", text: "restored context" }], timestamp: 1 } as AgentMessage;
	h.setSessionEntries([{ type: "message", id: "1", parentId: null, timestamp: "2026-01-01T00:00:00Z", message: sessionUser }]);

	const command = h.commands.get("btw-luna")!.handler("side question", h.context) as Promise<void>;
	await waitFor(() => contexts.length === 1 && h.overlay?.isLoading === false, "Luna did not answer immediately");
	assert.match(h.overlay!.render(120).join("\n"), /\/btw-luna/);
	assert.equal(contexts[0]!.systemPrompt.includes("effective parent system prompt"), true);
	assert.equal(contexts[0]!.systemPrompt.includes("/btw-luna side conversation"), true);
	assert.deepEqual(contexts[0]!.tools, []);
	assert.match(JSON.stringify(contexts[0]!.messages), /restored context/);
	assert.match(JSON.stringify(contexts[0]!.messages), /side question/);

	for (const char of "follow up") h.overlay!.handleInput(char);
	h.overlay!.handleInput("\r");
	await waitFor(() => contexts.length === 2, "Luna follow-up was not sent");
	assert.match(JSON.stringify(contexts[1]!.messages), /luna answer/);
	assert.equal(optionsSeen[0]!.sessionId, optionsSeen[1]!.sessionId);
	assert.equal(optionsSeen[0]!.maxRetries, 0);
	assert.equal(optionsSeen[0]!.transport, "auto");
	assert.equal(optionsSeen[0]!.reasoning, "high");
	assert.equal(h.context.model?.id, model.id);
	h.overlay!.close();
	await command;
});

for (const parentId of ["gpt-6.1-sol-long", "gpt-6-luna-long"]) {
	test(`/btw-luna preserves the Long tier and follow-ups for ${parentId}`, async () => {
		const contexts: Context[] = [];
		const longLuna = { ...lunaModel, id: "gpt-6-luna-long", contextWindow: 1_050_000, maxTokens: 128_000 };
		const h = harness(successfulLunaStream(contexts, [], longLuna));
		const parent = { ...model, id: parentId, contextWindow: 1_050_000 };
		(h.context as any).model = parent;
		(h.context.modelRegistry as any).find = (provider: string, id: string) => provider === parent.provider
			? id === longLuna.id ? longLuna : id === lunaModel.id ? lunaModel : undefined : undefined;
		const history = " x".repeat(280_000);
		h.setSessionEntries([{ type: "message", id: "large", parentId: null, timestamp: "2026-01-01T00:00:00Z", message: { role: "user", content: history, timestamp: 1 } }]);
		const command = h.commands.get("btw-luna")!.handler("side question", h.context) as Promise<void>;
		await waitFor(() => contexts.length === 1 && h.overlay?.isLoading === false, "Long Luna did not answer");
		assert.equal((contexts[0]!.messages[0] as any).content, history);
		for (const char of "follow up") h.overlay!.handleInput(char);
		h.overlay!.handleInput("\r");
		await waitFor(() => contexts.length === 2 && h.overlay?.isLoading === false, "Long Luna follow-up was not sent");
		assert.equal(h.context.model, parent);
		h.overlay!.close();
		await command;
	});
}

test("/btw-luna recognizes future registered Long models instead of a fixed parent whitelist", async () => {
	const root = mkdtempSync(join(homedir(), "tmp", "btw-luna-long-registry-"));
	const previous = process.env.PI_CODEX_ULTRA_RELEASE_ROOT;
	try {
		mkdirSync(join(root, "suite/runtime"), { recursive: true });
		writeFileSync(join(root, "suite/runtime/long-context-models.mjs"), 'export const getCodexLongContextModel = id => id === "gpt-future-astra-long" ? { baseId: "gpt-future-astra" } : undefined;\n');
		process.env.PI_CODEX_ULTRA_RELEASE_ROOT = root;
		const contexts: Context[] = [];
		const longLuna = { ...lunaModel, id: "gpt-6-luna-long", contextWindow: 1_050_000 };
		const h = harness(successfulLunaStream(contexts, [], longLuna));
		(h.context as any).model = { ...model, id: "gpt-future-astra-long", contextWindow: 1_050_000 };
		(h.context.modelRegistry as any).find = (provider: string, id: string) => provider === model.provider && id === longLuna.id ? longLuna : undefined;
		const command = h.commands.get("btw-luna")!.handler("future parent", h.context) as Promise<void>;
		await waitFor(() => contexts.length === 1 && h.overlay?.isLoading === false, "Future Long parent did not select Long Luna");
		h.overlay!.close(); await command;
	} finally {
		if (previous === undefined) delete process.env.PI_CODEX_ULTRA_RELEASE_ROOT;
		else process.env.PI_CODEX_ULTRA_RELEASE_ROOT = previous;
		rmSync(root, { recursive: true, force: true });
	}
});

test("/btw-luna refuses a smaller-window fallback when Long Luna is missing", async () => {
	let streams = 0, auth = 0;
	const h = harness(successfulStream(() => { streams++; }));
	(h.context as any).model = { ...model, id: "gpt-6.1-sol-long", contextWindow: 1_050_000 };
	(h.context.modelRegistry as any).getApiKeyAndHeaders = async () => { auth++; return { ok: true, apiKey: TEST_API_KEY }; };
	await h.commands.get("btw-luna")!.handler("missing Long target", h.context);
	assert.equal(streams, 0); assert.equal(auth, 0); assert.equal(h.customCalls, 0);
	assert.match(h.notifications.join("\n"), /does not expose gpt-6-luna-long/);
	assert.equal(persistedTurns(h).at(-1)?.status, "error");
});

test("/btw-luna uses the pre-tool snapshot while a parent tool is running", async () => {
	const contexts: Context[] = [];
	const h = harness(successfulLunaStream(contexts));
	await h.beginParent();

	const command = h.commands.get("btw-luna")!.handler("what stage?", h.context) as Promise<void>;
	await waitFor(() => contexts.length === 1 && h.overlay?.isLoading === false, "Luna did not answer during parent execution");
	assert.deepEqual(contexts[0]!.messages.map((message) => message.role), ["user", "user"]);
	assert.match(JSON.stringify(contexts[0]!.messages), /parent question/);
	h.overlay!.close();
	await command;
	await h.finishParent(assistant(0, 2_000));
});

test("/btw-luna does not silently select Luna from another provider", async () => {
	let streamCalls = 0;
	const h = harness(successfulStream(() => { streamCalls++; }));
	(h.context as any).model = { ...model, provider: "other-provider" };

	await h.commands.get("btw-luna")!.handler("side question", h.context);
	assert.equal(streamCalls, 0);
	assert.equal(h.customCalls, 0);
	assert.match(h.notifications.join("\n"), /active provider other-provider does not expose gpt-6-luna/);
});

test("session shutdown and model switch cancel /btw-luna while authentication is pending", async () => {
	for (const lifecycleEvent of ["session_shutdown", "model_select"] as const) {
		let resolveAuth: ((value: { ok: true; apiKey: string }) => void) | undefined;
		let streamCalls = 0;
		const h = harness(successfulStream(() => { streamCalls++; }));
		(h.context.modelRegistry as any).getApiKeyAndHeaders = () => new Promise((resolve) => {
			resolveAuth = resolve;
		});

		const command = h.commands.get("btw-luna")!.handler("side question", h.context) as Promise<void>;
		await waitFor(() => !!resolveAuth, "Luna authentication did not start");
		await h.emit(lifecycleEvent, lifecycleEvent === "session_shutdown" ? { reason: "switch" } : {});
		resolveAuth!({ ok: true, apiKey: TEST_API_KEY });
		await command;
		assert.equal(h.customCalls, 0, `${lifecycleEvent} opened a stale overlay`);
		assert.equal(streamCalls, 0, `${lifecycleEvent} sent a stale Luna request`);
	}
});

test("model switch releases a pending Luna auth reservation without waiting for stale auth", async () => {
	let resolveFirstAuth: ((value: { ok: true; apiKey: string }) => void) | undefined;
	let authCalls = 0;
	let streamCalls = 0;
	const h = harness(successfulStream(() => { streamCalls++; }));
	(h.context.modelRegistry as any).getApiKeyAndHeaders = () => {
		authCalls++;
		if (authCalls === 1) return new Promise((resolve) => { resolveFirstAuth = resolve; });
		return Promise.resolve({ ok: true, apiKey: TEST_API_KEY });
	};

	const staleCommand = h.commands.get("btw-luna")!.handler("stale question", h.context) as Promise<void>;
	await waitFor(() => !!resolveFirstAuth, "first Luna authentication did not start");
	await h.emit("model_select");
	const replacementCommand = h.commands.get("btw-luna")!.handler("replacement question", h.context) as Promise<void>;
	await waitFor(() => streamCalls === 1 && h.overlay?.isLoading === false, "replacement Luna request remained blocked by stale auth");
	resolveFirstAuth!({ ok: true, apiKey: TEST_API_KEY });
	await staleCommand;
	assert.equal(h.overlay!.isClosed, false, "stale auth cleanup closed the replacement overlay");
	h.overlay!.close();
	await replacementCommand;
});

test("/btw-luna reports rejected, missing, and thrown authentication errors", async () => {
	const failures = [
		{ auth: async () => ({ ok: false, error: "account unavailable" }), message: /account unavailable/ },
		{ auth: async () => ({ ok: true }), message: /No API key/ },
		{ auth: async () => { throw new Error("credential lookup failed"); }, message: /credential lookup failed/ },
	];
	for (const failure of failures) {
		let streamCalls = 0;
		const h = harness(successfulStream(() => { streamCalls++; }));
		(h.context.modelRegistry as any).getApiKeyAndHeaders = failure.auth;
		await h.commands.get("btw-luna")!.handler("side question", h.context);
		assert.equal(h.customCalls, 0);
		assert.equal(streamCalls, 0);
		assert.match(h.notifications.join("\n"), failure.message);
	}
});

test("Escape aborts and discards an in-flight /btw-luna request", async () => {
	let requestSignal: AbortSignal | undefined;
	const hangingStream = ((_streamModel: Model<any>, _context: Context, options: SimpleStreamOptions = {}) => {
		requestSignal = options.signal;
		const stream = createAssistantMessageEventStream();
		options.signal?.addEventListener("abort", () => {
			stream.end({ ...lunaResult(), stopReason: "aborted", errorMessage: "cancelled" });
		}, { once: true });
		return stream;
	}) as ApiStreamSimpleFunction;
	const h = harness(hangingStream);

	const command = h.commands.get("btw-luna")!.handler("cancel me", h.context) as Promise<void>;
	await waitFor(() => !!requestSignal && !!h.overlay, "Luna request did not start");
	h.overlay!.handleInput("\u001b");
	await command;
	assert.equal(requestSignal!.aborted, true);
});

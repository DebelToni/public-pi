import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const releaseRoot = process.env.PI_CODEX_ULTRA_RELEASE_ROOT;
assert.ok(releaseRoot && isAbsolute(releaseRoot), "PI_CODEX_ULTRA_RELEASE_ROOT must name the installed release");

const releaseImport = (relativePath: string) => import(pathToFileURL(join(releaseRoot, relativePath)).href);
const sdk = await releaseImport("node_modules/@earendil-works/pi-coding-agent/dist/index.js");
const ai = await releaseImport("node_modules/@earendil-works/pi-ai/dist/index.js");
const openAICompletions = await releaseImport(
	"node_modules/@earendil-works/pi-ai/dist/api/openai-completions.lazy.js",
);
const { createJiti } = await releaseImport(
	"node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti-static.mjs",
);

const extensionPath = join(dirname(fileURLToPath(import.meta.url)), "index.ts");
const manageReasoningPath = join(dirname(extensionPath), "../manage-reasoning/index.ts");
const modelStatusPath = join(releaseRoot, "suite/modules/model-status/index.ts");
const codexAccountsPath = join(releaseRoot, "suite/modules/codex-accounts/index.ts");
const tmpRoot = join(homedir(), "tmp");
mkdirSync(tmpRoot, { recursive: true });
process.env.PI_OFFLINE = "1";

const noCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const visibleLength = (text: string) => text.replaceAll(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").length;

function identityTheme() {
	return new Proxy({}, {
		get: () => (_value: unknown, text?: string) => text ?? String(_value),
	});
}

function createTestUI() {
	const notifications: Array<[string, string | undefined]> = [];
	const footerFactories: any[] = [];
	const ui: any = {
		theme: identityTheme(),
		select: async () => undefined,
		confirm: async () => false,
		input: async () => undefined,
		editor: async () => undefined,
		custom: async () => undefined,
		notify: (message: string, level?: string) => notifications.push([message, level]),
		onTerminalInput: () => () => {},
		setStatus: () => {},
		setWorkingMessage: () => {},
		setWorkingVisible: () => {},
		setWorkingIndicator: () => {},
		setHiddenThinkingLabel: () => {},
		setWidget: () => {},
		setFooter: (factory: any) => footerFactories.push(factory),
		setHeader: () => {},
		setTitle: () => {},
		pasteToEditor: () => {},
		setEditorText: () => {},
		getEditorText: () => "",
		addAutocompleteProvider: () => {},
		setEditorComponent: () => {},
		getEditorComponent: () => undefined,
		getAllThemes: () => [],
		getTheme: () => undefined,
		setTheme: () => ({ success: true }),
		getToolsExpanded: () => false,
		setToolsExpanded: () => {},
	};
	return { ui, notifications, footerFactories };
}

function createOfflineProvider(
	providerId: string,
	models: Array<Record<string, unknown>>,
	apiStreams?: Record<string, unknown>,
) {
	const faux = apiStreams ? undefined : ai.createFauxCore({ provider: providerId, models });
	const provider = ai.createProvider({
		id: providerId,
		auth: {
			apiKey: {
				name: "Offline test provider",
				check: async () => ({ source: "in-memory test auth", type: "api_key" }),
				resolve: async () => ({ auth: { apiKey: "offline-test-key" }, source: "in-memory test auth" }),
			},
		},
		models: faux?.models ?? models,
		api: apiStreams ?? {
			stream: faux.stream,
			streamSimple: faux.streamSimple,
			fetchDeferred: faux.fetchDeferred,
			cancelDeferred: faux.cancelDeferred,
		},
	});
	return { provider, faux };
}

type HarnessOptions = {
	providerFixture?: ReturnType<typeof createOfflineProvider>;
	modelId?: string;
	thinkingLevel?: string;
	sessionManager?: any;
	settings?: Record<string, unknown>;
	extensionPaths?: string[];
	eventBus?: any;
	agentDir?: string;
};

async function createHarness(root: string, options: HarnessOptions = {}) {
	mkdirSync(root, { recursive: true });
	const providerFixture = options.providerFixture ?? createOfflineProvider("max-context-offline", [
		{ id: "large-a", reasoning: true, input: ["text"], cost: noCost, contextWindow: 1_000_000, maxTokens: 32_000 },
		{ id: "large-b", reasoning: true, input: ["text"], cost: noCost, contextWindow: 750_000, maxTokens: 24_000 },
	]);
	const modelRuntime = await sdk.ModelRuntime.create({
		credentials: new ai.InMemoryCredentialStore(),
		modelsStore: new ai.InMemoryModelsStore(),
		modelsPath: null,
		refreshOnCreate: false,
	});
	modelRuntime.registerNativeProvider(providerFixture.provider);
	await modelRuntime.refresh({ allowNetwork: false, providers: [providerFixture.provider.id] });
	assert.equal(modelRuntime.hasConfiguredAuth(providerFixture.provider.id), true, "mock provider auth must be ready");

	const settingsManager = sdk.SettingsManager.inMemory({
		defaultThinkingLevel: "high",
		compaction: { enabled: true, reserveTokens: 1_000, keepRecentTokens: 128 },
		retry: { enabled: false },
		...options.settings,
	});
	const eventBus = options.eventBus ?? sdk.createEventBus();
	const agentDir = options.agentDir ?? join(root, "agent");
	mkdirSync(agentDir, { recursive: true });
	const resourceLoader = new sdk.DefaultResourceLoader({
		cwd: root,
		agentDir,
		settingsManager,
		eventBus,
		additionalExtensionPaths: options.extensionPaths ?? [extensionPath],
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		systemPrompt: "offline integration test",
	});
	await resourceLoader.reload();
	assert.deepEqual(resourceLoader.getExtensions().errors, [], "extensions must load through the installed loader");

	const sessionManager = options.sessionManager ?? sdk.SessionManager.inMemory(root);
	const registryModel = modelRuntime.getModel(providerFixture.provider.id, options.modelId ?? "large-a");
	assert.ok(registryModel);
	const { session } = await sdk.createAgentSession({
		cwd: root,
		agentDir,
		modelRuntime,
		model: registryModel,
		thinkingLevel: options.thinkingLevel ?? "high",
		sessionManager,
		settingsManager,
		resourceLoader,
		noTools: "all",
	});
	const uiState = createTestUI();
	const extensionErrors: unknown[] = [];
	await session.bindExtensions({
		uiContext: uiState.ui,
		mode: "tui",
		onError: (error: unknown) => extensionErrors.push(error),
	});
	return {
		session,
		sessionManager,
		modelRuntime,
		registryModel,
		providerFixture,
		eventBus,
		uiState,
		extensionErrors,
	};
}

async function closeHarness(harness: any) {
	if (harness.session.hasExtensionHandlers("session_shutdown")) {
		await harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
	}
	harness.session.dispose();
	assert.deepEqual(harness.extensionErrors, []);
}

function latestStateEntry(sessionManager: any) {
	return sessionManager.getEntries().filter(
		(entry: any) => entry.type === "custom" && entry.customType === "pi-max-context",
	).at(-1);
}

function assistantMessage(model: any, totalTokens: number, text = "done") {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: totalTokens,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens,
			cost: { ...noCost, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

test("/set-max-context installs a shallow active clone, preserves thinking, persists state, and resets to registry identity", async (t) => {
	assert.equal(existsSync(extensionPath), true, "parent extension index.ts must exist");
	const root = mkdtempSync(join(tmpRoot, "pi-max-context-command-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const harness = await createHarness(root, { thinkingLevel: "medium" });
	t.after(() => closeHarness(harness));
	const publications: unknown[] = [];
	harness.eventBus.on("model-status:prefix", (value: unknown) => publications.push(value));

	await harness.session.prompt("/set-max-context 256000");
	assert.notStrictEqual(harness.session.model, harness.registryModel);
	assert.deepEqual(harness.session.model, { ...harness.registryModel, contextWindow: 256_000 });
	assert.equal(harness.registryModel.contextWindow, 1_000_000, "registry models are immutable inputs to the override");
	assert.equal(harness.session.thinkingLevel, "medium", "nondefault reasoning survives the override");
	assert.deepEqual(latestStateEntry(harness.sessionManager).data, {
		version: 1,
		sessionId: harness.session.sessionId,
		value: 256_000,
	});
	assert.deepEqual(publications.at(-1), { key: "max-context", value: "max:256k", order: 90 });
	assert.equal(harness.session.getContextUsage().contextWindow, 256_000);

	await harness.session.prompt("/set-max-context");
	assert.strictEqual(harness.session.model, harness.registryModel);
	assert.equal(harness.session.thinkingLevel, "medium", "nondefault reasoning survives reset to registry identity");
	assert.equal(latestStateEntry(harness.sessionManager).data.value, null);
	assert.deepEqual(publications.at(-1), { key: "max-context", value: "", order: 90 });
});

test("nondefault thinking survives override, genuine selection, and reset alongside manage-reasoning", {
	// Keep this regression executable without changing the unrelated, already-dirty extension.
	todo: "manage-reasoning calls pi.getThinkingLevel() during factory load, before runtime actions are bound",
}, async (t) => {
	const root = mkdtempSync(join(tmpRoot, "pi-max-context-reasoning-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const previousSubagent = process.env.PI_SUBAGENT;
	delete process.env.PI_SUBAGENT;
	let harness: any;
	try {
		harness = await createHarness(root, {
			thinkingLevel: "medium",
			extensionPaths: [extensionPath, manageReasoningPath],
		});
	} finally {
		if (previousSubagent === undefined) delete process.env.PI_SUBAGENT;
		else process.env.PI_SUBAGENT = previousSubagent;
	}
	t.after(() => closeHarness(harness));
	assert.equal(harness.session.thinkingLevel, "medium");

	await harness.session.prompt("/set-max-context 256000");
	assert.equal(harness.session.thinkingLevel, "medium", "override must undo the core's default-high reset");
	const registryB = harness.modelRuntime.getModel(harness.registryModel.provider, "large-b");
	assert.ok(registryB);
	await harness.session.setModel(registryB);
	assert.equal(harness.session.model.contextWindow, 256_000);
	assert.equal(harness.session.thinkingLevel, "medium", "both model_select handlers preserve session reasoning");

	await harness.session.prompt("/set-max-context");
	assert.strictEqual(harness.session.model, registryB);
	assert.equal(harness.session.thinkingLevel, "medium", "reset to registry identity must also preserve reasoning");
});

test("default-equal overrides stay hidden, apply after model switching, and reset to the selected registry object", async (t) => {
	const root = mkdtempSync(join(tmpRoot, "pi-max-context-default-equal-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const harness = await createHarness(root);
	t.after(() => closeHarness(harness));
	const publications: any[] = [];
	harness.eventBus.on("model-status:prefix", (value: unknown) => publications.push(value));

	await harness.session.prompt("/set-max-context 1000000");
	assert.strictEqual(harness.session.model, harness.registryModel);
	assert.equal(publications.at(-1).value, "");
	assert.equal(latestStateEntry(harness.sessionManager).data.value, 1_000_000);

	const registryB = harness.modelRuntime.getModel(harness.registryModel.provider, "large-b");
	assert.ok(registryB);
	await harness.session.setModel(registryB);
	assert.equal(harness.session.model.contextWindow, 1_000_000);
	assert.notStrictEqual(harness.session.model, registryB);
	assert.equal(publications.at(-1).value, "max:1m");

	await harness.session.prompt("/set-max-context");
	assert.strictEqual(harness.session.model, registryB);
	assert.equal(publications.at(-1).value, "");
});

test("genuine model changes inherit the override, while same-ID replacement is repaired by input before the provider call", async (t) => {
	const root = mkdtempSync(join(tmpRoot, "pi-max-context-switch-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const harness = await createHarness(root);
	t.after(() => closeHarness(harness));
	await harness.session.prompt("/set-max-context 256000");

	const registryB = harness.modelRuntime.getModel(harness.registryModel.provider, "large-b");
	assert.ok(registryB);
	await harness.session.setModel(registryB);
	assert.equal(harness.session.model.id, "large-b");
	assert.equal(harness.session.model.contextWindow, 256_000);
	assert.notStrictEqual(harness.session.model, registryB);
	assert.equal(harness.session.thinkingLevel, "high");

	await harness.session.setModel(registryB);
	assert.strictEqual(harness.session.model, registryB, "core suppresses model_select for a same-provider/same-ID replacement");
	let requestModel: any;
	harness.providerFixture.faux.setResponses([
		(context: unknown, options: unknown, state: unknown, model: unknown) => {
			requestModel = model;
			return ai.fauxAssistantMessage("repaired");
		},
	]);
	await harness.session.prompt("repair before this request");
	assert.equal(requestModel.contextWindow, 256_000);
	assert.notStrictEqual(requestModel, registryB);
	assert.equal(harness.session.model.contextWindow, 256_000);
});

test("input repair restores the small window before core threshold compaction", async (t) => {
	const root = mkdtempSync(join(tmpRoot, "pi-max-context-compact-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const harness = await createHarness(root, {
		settings: { compaction: { enabled: true, reserveTokens: 1_000, keepRecentTokens: 128 } },
	});
	t.after(() => closeHarness(harness));
	await harness.session.prompt("/set-max-context 8000");

	for (let index = 0; index < 3; index++) {
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: `${index}: ${"history ".repeat(100)}` }],
			timestamp: Date.now(),
		});
		harness.sessionManager.appendMessage(assistantMessage(harness.registryModel, 7_500, `answer ${index}`));
	}
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
	assert.equal(harness.session.getContextUsage().contextWindow, 8_000);
	assert.ok(harness.session.getContextUsage().percent > 90);

	await harness.session.setModel(harness.registryModel);
	assert.equal(harness.session.getContextUsage().contextWindow, 1_000_000);
	const compactionReasons: string[] = [];
	harness.session.subscribe((event: any) => {
		if (event.type === "compaction_start") compactionReasons.push(event.reason);
	});
	harness.providerFixture.faux.setResponses([
		ai.fauxAssistantMessage("Summary of old offline turns."),
		ai.fauxAssistantMessage("post-compaction answer"),
	]);
	await harness.session.prompt("new prompt");

	assert.deepEqual(compactionReasons, ["threshold"]);
	assert.ok(harness.sessionManager.getEntries().some((entry: any) => entry.type === "compaction"));
	assert.equal(harness.providerFixture.faux.state.callCount, 2, "one summary and one user response are generated");
	assert.equal(harness.session.model.contextWindow, 8_000);
});

test("the active clone reaches a real provider adapter and clamps its output budget", async (t) => {
	const root = mkdtempSync(join(tmpRoot, "pi-max-context-clamp-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	let requestBody: any;
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
		requestBody = JSON.parse(String(init?.body));
		const chunks = [
			{ id: "offline", object: "chat.completion.chunk", created: 1, model: "adapter", choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }] },
			{ id: "offline", object: "chat.completion.chunk", created: 1, model: "adapter", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
		].map((value) => `data: ${JSON.stringify(value)}\n\n`).join("") + "data: [DONE]\n\n";
		return new Response(chunks, { status: 200, headers: { "content-type": "text/event-stream" } });
	}) as typeof fetch;
	t.after(() => { globalThis.fetch = originalFetch; });

	const providerFixture = createOfflineProvider("max-context-adapter", [{
		id: "adapter",
		name: "Adapter",
		api: "openai-completions",
		provider: "max-context-adapter",
		baseUrl: "https://offline.invalid/v1",
		reasoning: false,
		input: ["text"],
		cost: noCost,
		contextWindow: 100_000,
		maxTokens: 12_000,
	}], openAICompletions.openAICompletionsApi());
	const harness = await createHarness(root, { providerFixture, modelId: "adapter" });
	t.after(() => closeHarness(harness));

	await harness.session.prompt("/set-max-context 8192");
	await harness.session.prompt("exercise adapter clamp");
	assert.equal(harness.session.model.contextWindow, 8_192);
	assert.ok(requestBody.max_completion_tokens >= 1);
	assert.ok(requestBody.max_completion_tokens < 4_096, "adapter leaves context safety room instead of using registry maxTokens");
	assert.equal(requestBody.model, "adapter");
});

test("reload and resume restore only same-session state from all entries; an actual SessionManager fork and a new session do not inherit", async (t) => {
	const root = mkdtempSync(join(tmpRoot, "pi-max-context-restore-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const sessionDir = join(root, "sessions");
	const sourceManager = sdk.SessionManager.create(root, sessionDir);
	const source = await createHarness(root, { sessionManager: sourceManager });
	await source.session.prompt("/set-max-context 256000");
	const initialModelEntry = sourceManager.getEntries().find((entry: any) => entry.type === "model_change");
	assert.ok(initialModelEntry);

	sourceManager.appendCustomEntry("pi-max-context", { version: 2, sessionId: source.session.sessionId, value: 123_000 });
	sourceManager.appendCustomEntry("pi-max-context", { version: 1, sessionId: "foreign-session", value: 123_000 });
	sourceManager.appendCustomEntry("pi-max-context", { version: 1, sessionId: source.session.sessionId, value: "invalid" });
	await source.session.setModel(source.registryModel);
	await source.session.navigateTree(initialModelEntry.id, { summarize: false });
	assert.equal(source.session.model.contextWindow, 256_000, "session_tree reads the valid state outside the active branch");

	await source.session.setModel(source.registryModel);
	await source.session.reload();
	assert.equal(source.session.model.contextWindow, 256_000);
	assert.equal(source.session.thinkingLevel, "high");
	source.providerFixture.faux.setResponses([ai.fauxAssistantMessage("persist session fixture")]);
	await source.session.prompt("persist this session");
	const sourceFile = sourceManager.getSessionFile();
	assert.ok(sourceFile);
	await closeHarness(source);

	const resumed = await createHarness(root, { sessionManager: sdk.SessionManager.open(sourceFile, sessionDir) });
	assert.equal(resumed.session.sessionId, sourceManager.getSessionId());
	assert.equal(resumed.session.model.contextWindow, 256_000);
	await closeHarness(resumed);

	const forkManager = sdk.SessionManager.forkFrom(sourceFile, root, join(root, "forks"));
	assert.notEqual(forkManager.getSessionId(), sourceManager.getSessionId());
	const forked = await createHarness(root, { sessionManager: forkManager });
	assert.strictEqual(forked.session.model, forked.registryModel);
	assert.equal(forked.session.model.contextWindow, 1_000_000);
	await closeHarness(forked);

	const fresh = await createHarness(root, { sessionManager: sdk.SessionManager.create(root, join(root, "fresh")) });
	assert.strictEqual(fresh.session.model, fresh.registryModel);
	assert.equal(fresh.session.model.contextWindow, 1_000_000);
	await closeHarness(fresh);
});

test("installed modelsForAccount shallow-clones inputs and applies 372k to Ultra Codex models", async (t) => {
	const root = mkdtempSync(join(tmpRoot, "pi-max-context-model-catalog-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const originalFetch = globalThis.fetch;
	process.env.PI_CODING_AGENT_DIR = root;
	let fetchCount = 0;
	globalThis.fetch = (async () => {
		fetchCount++;
		throw new Error("network disabled in model catalog regression");
	}) as typeof fetch;
	try {
		const jiti = createJiti(import.meta.url, { fsCache: false, moduleCache: false });
		const { modelsForAccount } = await jiti.import(codexAccountsPath) as any;
		const sharedInput = Object.freeze(["text", "image"]);
		const baseModels = [
			{ id: "gpt-5.6-sol", name: "Sol", api: "openai-codex-responses", provider: "openai-codex", baseUrl: "https://offline.invalid", reasoning: true, input: sharedInput, cost: noCost, contextWindow: 272_000, maxTokens: 128_000 },
			{ id: "gpt-5.6-luna", name: "Luna", api: "openai-codex-responses", provider: "openai-codex", baseUrl: "https://offline.invalid", reasoning: true, input: sharedInput, cost: noCost, contextWindow: 400_000, maxTokens: 96_000 },
			{ id: "gpt-6-astra", name: "Astra", api: "openai-codex-responses", provider: "openai-codex", baseUrl: "https://offline.invalid", reasoning: true, input: sharedInput, cost: noCost, contextWindow: 512_000, maxTokens: 64_000 },
		];
		const originalModels = structuredClone(baseModels);
		const account = { label: "Fixture", providerId: "codex-fixture", seatManaged: true };
		const result = modelsForAccount(account, baseModels);

		assert.deepEqual(result.map((model: any) => model.contextWindow), [372_000, 372_000, 372_000]);
		assert.ok(result.every((model: any) => model.provider === "codex-fixture"));
		assert.deepEqual(result.map((model: any) => model.name), ["Fixture · Sol", "Fixture · Luna", "Fixture · Astra"]);
		for (let index = 0; index < result.length; index++) {
			assert.notStrictEqual(result[index], baseModels[index]);
			assert.strictEqual(result[index].input, sharedInput, "the shallow clone preserves nested model metadata");
		}
		assert.deepEqual(baseModels, originalModels, "the caller's model objects remain unchanged");
		assert.deepEqual(account, { label: "Fixture", providerId: "codex-fixture", seatManaged: true });
		assert.equal(fetchCount, 0, "importing and calling the catalog helper performs no network I/O");
	} finally {
		globalThis.fetch = originalFetch;
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	}
});

test("installed Ultra model-status owns the sole footer and composes max-context before the model at narrow widths", async (t) => {
	assert.equal(existsSync(modelStatusPath), true, "installed immutable Ultra model-status fixture is required");
	const root = mkdtempSync(join(tmpRoot, "pi-max-context-footer-"));
	const agentDir = join(root, "agent");
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const originalFetch = globalThis.fetch;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	let fetchCount = 0;
	globalThis.fetch = (async () => {
		fetchCount++;
		throw new Error("network disabled in integration test");
	}) as typeof fetch;
	t.after(() => {
		globalThis.fetch = originalFetch;
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	});

	const eventBus = sdk.createEventBus();
	const harness = await createHarness(root, {
		eventBus,
		agentDir,
		extensionPaths: [modelStatusPath, extensionPath],
	});
	t.after(() => closeHarness(harness));
	assert.equal(harness.uiState.footerFactories.length, 1, "max-context must not install a second footer");
	let renderRequests = 0;
	const footer = harness.uiState.footerFactories[0]({ requestRender() { renderRequests++; } }, harness.uiState.ui.theme, {});

	eventBus.emit("model-status:prefix", { key: "fixture-prefix", value: "seat:ok", order: 10 });
	assert.equal(renderRequests, 1);
	await harness.session.prompt("/set-max-context 256000");
	assert.equal(renderRequests, 2, "publishing max-context requests exactly one existing-footer refresh");
	const wide = footer.render(120)[0].trim();
	assert.match(wide, /^seat:ok max:256k large-a[hMxmln] c:/);
	assert.ok(wide.indexOf("max:256k") < wide.indexOf("large-a"));

	await harness.session.prompt("/usage status");
	await harness.session.prompt("/reset status");
	await harness.session.prompt("/tps status");
	assert.equal(footer.render(120)[0].trim(), wide, "quota/TPS status commands do not disturb prefixes or usage text");
	assert.equal(renderRequests, 2);
	assert.deepEqual(harness.uiState.notifications.slice(-3).map(([message]) => message), [
		"Usage display: on",
		"Reset display: on",
		"TPS display: off",
	]);

	const narrow = footer.render(22);
	assert.equal(narrow.length, 1);
	assert.ok(visibleLength(narrow[0]) <= 22);
	assert.match(narrow[0], /max:256k/);
	const veryNarrow = footer.render(12);
	assert.equal(veryNarrow.length, 1);
	assert.ok(visibleLength(veryNarrow[0]) <= 12);

	await harness.session.prompt("/set-max-context");
	assert.equal(renderRequests, 3, "reset requests one refresh while preserving other contributions");
	const reset = footer.render(120)[0];
	assert.match(reset, /seat:ok large-a[hMxmln] c:/);
	assert.doesNotMatch(reset, /max:/);
	assert.equal(fetchCount, 0, "the offline non-Codex fixture must not start background quota I/O");
});

import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, createBashToolDefinition, createEditToolDefinition, createWriteToolDefinition, initTheme } from "@earendil-works/pi-coding-agent";
import actionFusion from "./index.ts";

function tools() {
	const registered = new Map<string, any>();
	actionFusion({ registerTool(tool: any) { registered.set(tool.name, tool); } } as any);
	return registered;
}

async function fixture(run: (f: any) => Promise<void>) {
	const cwd = await mkdtemp(join(tmpdir(), "action-fusion-test-"));
	const calls: any[] = [];
	const bash = createBashToolDefinition(cwd);
	const ctx: any = {
		cwd,
		sessionManager: { getSessionId: () => "action-fusion-test", getSessionFile: () => undefined },
		async executeTool(name: string, args: any, options: any) {
			calls.push({ name, args, options });
			try {
				const result = await bash.execute("outer/1", args, options.signal, options.onUpdate, ctx);
				return { toolCall: { id: "outer/1", name, arguments: args }, result, isError: result.isError ?? false };
			} catch (error) {
				return { result: { content: [{ type: "text", text: (error as Error).message }], details: undefined }, isError: true };
			}
		},
	};
	try { await run({ cwd, calls, ctx, tools: tools() }); }
	finally { await rm(cwd, { recursive: true, force: true }); }
}

const text = (result: any) => result.content.map((part: any) => part.text).join("\n");

test("extends both original schemas without changing edit preparation or guidelines", () => {
	const registered = tools();
	for (const base of [createWriteToolDefinition(process.cwd()), createEditToolDefinition(process.cwd())]) {
		const fused = registered.get(base.name);
		assert.deepEqual(fused.parameters.required, base.parameters.required);
		for (const [key, schema] of Object.entries(base.parameters.properties)) {
			assert.deepEqual(fused.parameters.properties[key], schema);
		}
		assert.deepEqual(fused.parameters.properties.then_run.properties, createBashToolDefinition(process.cwd()).parameters.properties);
		assert.equal(fused.prepareArguments, base.prepareArguments);
		assert.deepEqual(fused.promptGuidelines, base.promptGuidelines);
	}
});

test("ordinary write and edit preserve native results and do not invoke bash", async () => fixture(async ({ cwd, calls, ctx, tools }) => {
	const written = await tools.get("write").execute("write", { path: "file.txt", content: "one\ntwo\n" }, undefined, undefined, ctx);
	assert.deepEqual(written, { content: [{ type: "text", text: "Successfully wrote to file.txt" }], details: undefined });
	const args = { path: "file.txt", edits: [{ oldText: "one", newText: "three" }] };
	const edited = await tools.get("edit").execute("edit", args, undefined, undefined, ctx);
	assert.ok(edited.details.diff);
	assert.ok(edited.details.patch);
	assert.equal(edited.details.thenRun, undefined);
	assert.equal(await readFile(join(cwd, "file.txt"), "utf8"), "three\ntwo\n");
	assert.equal(calls.length, 0);
}));

test("fused write executes only after mutation and forwards command, timeout, signal, and output updates", async () => fixture(async ({ cwd, calls, ctx, tools }) => {
	const controller = new AbortController();
	const updates: any[] = [];
	const result = await tools.get("write").execute("write", {
		path: "nested/file.txt", content: "fusion works\n",
		then_run: { command: "test \"$(<nested/file.txt)\" = 'fusion works' && printf 'WRITE_OK\\n'", timeout: 5 },
	}, controller.signal, (partial: any) => updates.push(partial), ctx);
	assert.equal(result.isError, false);
	assert.match(text(result), /then_run:succeeded/);
	assert.match(text(result), /WRITE_OK/);
	assert.equal(calls[0].name, "bash");
	assert.equal(calls[0].args.timeout, 5);
	assert.equal(calls[0].options.signal, controller.signal);
	assert.ok(updates.some((partial) => text(partial).includes("then_run:running")));
	assert.equal(result.details.thenRun.result.structuredContent.exit_code, 0);
	assert.equal(await readFile(join(cwd, "nested/file.txt"), "utf8"), "fusion works\n");
}));

test("fused edit preserves multi-edit semantics and diff details", async () => fixture(async ({ cwd, ctx, tools }) => {
	await writeFile(join(cwd, "file.txt"), "alpha\nbeta\n");
	const result = await tools.get("edit").execute("edit", {
		path: "file.txt", edits: [{ oldText: "alpha", newText: "gamma" }, { oldText: "beta", newText: "delta" }],
		then_run: { command: "test \"$(<file.txt)\" = $'gamma\\ndelta' && echo EDIT_OK" },
	}, undefined, undefined, ctx);
	assert.equal(result.isError, false);
	assert.match(text(result), /EDIT_OK/);
	assert.match(result.details.diff, /gamma/);
	assert.ok(result.details.patch);
}));

test("failed write or edit skips the follow-up", async () => fixture(async ({ cwd, calls, ctx, tools }) => {
	await writeFile(join(cwd, "file.txt"), "original");
	for (const [name, args] of [
		["write", { path: ".", content: "invalid" }],
		["edit", { path: "file.txt", edits: [{ oldText: "absent", newText: "new" }] }],
	] as const) {
		await assert.rejects(tools.get(name).execute("mutation", { ...args, then_run: { command: "touch should-not-exist" } }, undefined, undefined, ctx), /then_run:skipped/);
	}
	assert.equal(calls.length, 0);
	assert.equal(await readFile(join(cwd, "file.txt"), "utf8"), "original");
}));

test("command failure retains mutation and marks the fused result as an error", async () => fixture(async ({ cwd, ctx, tools }) => {
	const result = await tools.get("write").execute("write", {
		path: "file.txt", content: "retained", then_run: { command: "printf 'DIAGNOSTIC\\n' >&2; exit 7" },
	}, undefined, undefined, ctx);
	assert.equal(result.isError, true);
	assert.match(text(result), /then_run:failed/);
	assert.match(text(result), /DIAGNOSTIC/);
	assert.equal(result.details.thenRun.result.structuredContent.exit_code, 7);
	assert.equal(await readFile(join(cwd, "file.txt"), "utf8"), "retained");
}));

test("nested permission rejection is returned without reverting the mutation", async () => fixture(async ({ cwd, ctx, tools }) => {
	ctx.executeTool = async () => ({ result: { content: [{ type: "text", text: "Blocked by safety hook" }], details: undefined }, isError: true });
	const result = await tools.get("write").execute("write", { path: "file.txt", content: "retained", then_run: { command: "blocked" } }, undefined, undefined, ctx);
	assert.equal(result.isError, true);
	assert.match(text(result), /Blocked by safety hook/);
	assert.equal(await readFile(join(cwd, "file.txt"), "utf8"), "retained");
}));

test("timeout reports failure and retains mutation", async () => fixture(async ({ cwd, ctx, tools }) => {
	const result = await tools.get("write").execute("write", {
		path: "file.txt", content: "retained", then_run: { command: "sleep 5", timeout: 0.05 },
	}, undefined, undefined, ctx);
	assert.equal(result.isError, true);
	assert.match(text(result), /timed out/);
	assert.equal(await readFile(join(cwd, "file.txt"), "utf8"), "retained");
}));

test("pre-aborted mutation skips command; cancellation during command retains mutation", async () => fixture(async ({ cwd, calls, ctx, tools }) => {
	const cancelled = new AbortController();
	cancelled.abort();
	await assert.rejects(tools.get("write").execute("write", { path: "absent.txt", content: "no", then_run: { command: "echo no" } }, cancelled.signal, undefined, ctx), /then_run:skipped/);
	assert.equal(calls.length, 0);
	const active = new AbortController();
	const original = ctx.executeTool;
	ctx.executeTool = async (...args: any[]) => {
		setTimeout(() => active.abort(), 50);
		return original(...args);
	};
	const result = await tools.get("write").execute("write", { path: "file.txt", content: "retained", then_run: { command: "sleep 5" } }, active.signal, undefined, ctx);
	assert.equal(result.isError, true);
	assert.match(text(result), /Command aborted/);
	assert.equal(await readFile(join(cwd, "file.txt"), "utf8"), "retained");
}));

test("native bash truncation and full-output path survive fusion", async () => fixture(async ({ ctx, tools }) => {
	const result = await tools.get("write").execute("write", {
		path: "file.txt", content: "ok", then_run: { command: "printf '%060000d\\n' 0" },
	}, undefined, undefined, ctx);
	assert.equal(result.isError, false);
	assert.ok(result.details.thenRun.result.details.truncation.truncated);
	const path = result.details.thenRun.result.details.fullOutputPath;
	assert.equal((await readFile(path)).length, 60001);
	assert.match(text(result), /Full output:/);
	await rm(path);
}));

test("fused call and result render at narrow widths using native components", async () => fixture(async ({ ctx, tools }) => {
	initTheme("dark");
	// Native renderers accept the same semantic styling surface as Pi's theme.
	const identityTheme: any = { fg: (_: string, s: string) => s, bg: (_: string, s: string) => s, bold: (s: string) => s };
	for (const name of ["write", "edit"]) {
		const args: any = name === "write" ? { path: "file.txt", content: "a\n" } : { path: "file.txt", edits: [{ oldText: "a", newText: "b" }] };
		args.then_run = { command: "echo VISIBLE_OUTPUT" };
		const tool = tools.get(name);
		const result = await tool.execute("call", args, undefined, undefined, ctx);
		const context: any = { args, cwd: ctx.cwd, expanded: true, argsComplete: true, isPartial: false, isError: false, state: {}, invalidate() {} };
		const call = tool.renderCall(args, identityTheme, context).render(40).join("\n");
		const output = tool.renderResult(result, { expanded: true, isPartial: false }, identityTheme, context).render(40).join("\n");
		assert.match(call, /echo VISIBLE_OUTPUT/);
		assert.match(output, /VISIBLE_OUTPUT/);
		assert.doesNotThrow(() => tool.renderResult({ content: [{ type: "text", text: "Mutation failed" }], details: undefined }, { expanded: true, isPartial: false }, identityTheme, { ...context, isError: true, lastComponent: tool.renderCall(args, identityTheme, context) }).render(40));
	}
}));

test("real in-memory Pi SDK loads override and routes nested bash through permission hooks and shell settings", async () => fixture(async ({ cwd }) => {
	const settingsManager = SettingsManager.inMemory({ shellCommandPrefix: "export FUSION_PREFIX=prefix-ok" });
	const events: any[] = [];
	const resourceLoader = new DefaultResourceLoader({
		cwd, agentDir: cwd, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
		additionalExtensionPaths: [fileURLToPath(new URL("./index.ts", import.meta.url))],
		extensionFactories: [(pi) => {
			pi.on("tool_call", (event) => {
				events.push(event);
				if (event.toolName === "bash" && event.input.command === "blocked-by-test") return { block: true, reason: "Test permission rejection" };
			});
		}],
	});
	await resourceLoader.reload();
	assert.deepEqual(resourceLoader.getExtensions().errors, []);
	const modelRuntime = await ModelRuntime.create({ authPath: join(cwd, "auth.json"), modelsPath: join(cwd, "models.json") });
	const sessionManager = SessionManager.inMemory(cwd);
	// Seed an assistant turn so the real nested-call pipeline has an issuer,
	// without calling a model or reading the user's credentials.
	sessionManager.appendMessage({
		role: "assistant", content: [], api: "openai-responses", provider: "test", model: "test",
		stopReason: "toolUse", timestamp: Date.now(),
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	});
	const { session } = await createAgentSession({ cwd, agentDir: cwd, settingsManager, modelRuntime, resourceLoader, sessionManager });
	try {
		await session.bindExtensions({});
		const tool = session.agent.state.tools.find((tool) => tool.name === "write")!;
		assert.ok(tool.parameters.properties.then_run);
		const result = await tool.execute("sdk-write", { path: "sdk.txt", content: "sdk", then_run: { command: "test \"$(<sdk.txt)\" = sdk && echo $FUSION_PREFIX" } });
		assert.equal(result.isError, false, text(result));
		assert.match(text(result), /prefix-ok/);
		assert.ok(events.some((event) => event.toolName === "bash" && event.parentToolCallId === "sdk-write"));
		const rejected = await tool.execute("sdk-block", { path: "sdk.txt", content: "retained", then_run: { command: "blocked-by-test" } });
		assert.equal(rejected.isError, true);
		assert.match(text(rejected), /Test permission rejection/);
		assert.equal(await readFile(join(cwd, "sdk.txt"), "utf8"), "retained");
	} finally { session.dispose(); }
}));

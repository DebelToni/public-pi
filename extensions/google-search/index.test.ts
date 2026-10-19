import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import googleSearchExtension, {
	GOOGLE_PAUSED_ERROR,
	GOOGLE_PAUSE_INDICATOR,
	TOOL_DESCRIPTION,
	formatResults,
	parseResults,
	type GoogleSearchResult,
} from "./index.ts";

const UNPAUSED_STATE_PATH = join(tmpdir(), `pi-google-search-unpaused-${process.pid}.json`);

function eventBus() {
	const listeners = new Map<string, Set<(value: unknown) => void>>();
	return {
		on(channel: string, listener: (value: unknown) => void) {
			const current = listeners.get(channel) ?? new Set();
			current.add(listener);
			listeners.set(channel, current);
			return () => current.delete(listener);
		},
		emit(channel: string, value: unknown) {
			for (const listener of [...(listeners.get(channel) ?? [])]) listener(value);
		},
	};
}

function registeredTool(exec: (...args: any[]) => Promise<any>, statePath = UNPAUSED_STATE_PATH) {
	let tool: any;
	googleSearchExtension({
		registerTool(definition: unknown) { tool = definition; },
		registerCommand() {},
		on() {},
		events: eventBus(),
		exec,
	} as unknown as ExtensionAPI, statePath);
	return tool;
}

function extensionHarness(statePath: string) {
	const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
	const commands = new Map<string, any>();
	const statuses = new Map<string, string>();
	const notifications: string[] = [];
	const execCalls: any[][] = [];
	const events = eventBus();
	let footer: unknown;
	events.on("model-status:prefix", (value) => { footer = value; });
	const context = {
		mode: "tui",
		hasUI: true,
		ui: {
			theme: { fg: (_color: string, text: string) => text },
			setStatus(key: string, value: string | undefined) {
				if (value === undefined) statuses.delete(key);
				else statuses.set(key, value);
			},
			notify(message: string) { notifications.push(message); },
		},
	};
	googleSearchExtension({
		registerTool() {},
		registerCommand(name: string, command: unknown) { commands.set(name, command); },
		on(name: string, handler: (event: any, ctx: any) => unknown) {
			const current = handlers.get(name) ?? [];
			current.push(handler);
			handlers.set(name, current);
		},
		events,
		exec: async (...args: any[]) => {
			execCalls.push(args);
			if (args[1]?.[0] !== "--pause-toggle") {
				return { code: 0, stdout: "[]", stderr: "", killed: false };
			}
			let current = false;
			try { current = JSON.parse(await readFile(statePath, "utf8")).paused === true; } catch {}
			const paused = !current;
			await writeFile(statePath, `${JSON.stringify({ paused })}\n`, { mode: 0o600 });
			return { code: 0, stdout: `${JSON.stringify({ paused })}\n`, stderr: "", killed: false };
		},
	} as unknown as ExtensionAPI, statePath);
	const emitLifecycle = async (name: string) => {
		for (const handler of handlers.get(name) ?? []) await handler({}, context);
	};
	return { commands, statuses, notifications, execCalls, events, context, emitLifecycle, get footer() { return footer; } };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000) {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("Timed out waiting for synchronized Google pause state");
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

test("registers a concise Google search tool", () => {
	const tool = registeredTool(async () => ({ code: 0, stdout: "[]", stderr: "", killed: false }));
	assert.equal(tool.name, "google_search");
	assert.equal(tool.description, TOOL_DESCRIPTION);
	assert.match(tool.description, /Search once; fetch sparingly/);
	assert.match(tool.description, /exact facts, current pages, and ordinary lookups/);
	assert.ok(tool.description.length < 100);
	assert.equal(tool.parameters.properties.bot, undefined);
	assert.match(tool.promptGuidelines.join("\n"), /do not retry Google/i);
	assert.match(tool.promptGuidelines.join("\n"), /CAPTCHA or bot challenge/i);
	assert.match(tool.promptGuidelines.join("\n"), /exa_search.*numResults=3.*includeText=false/i);
	assert.match(tool.promptGuidelines.join("\n"), /\/pause-google/);
});

test("passes count and fetch to the CLI and formats fetched text", async () => {
	const calls: any[][] = [];
	const stdout = JSON.stringify([{
		title: "Python docs",
		url: "https://docs.python.org/3/",
		snippet: "Documentation",
		text: "Readable page text",
	}]);
	const tool = registeredTool(async (...args: any[]) => {
		calls.push(args);
		return { code: 0, stdout, stderr: "", killed: false };
	});
	const result = await tool.execute("call", { query: "python docs", count: 3, fetch: true });

	assert.match(calls[0][0], /\/bin\/google-search$/);
	assert.deepEqual(calls[0][1], ["--fetch", "python docs", "3"]);
	assert.equal(calls[0][2].timeout, 170_000);
	assert.match(result.content[0].text, /text:\nReadable page text/);
	assert.deepEqual(result.details, { count: 1, fetched: true });
});

test("headless search keeps a bounded tool timeout", async () => {
	const calls: any[][] = [];
	const tool = registeredTool(async (...args: any[]) => {
		calls.push(args);
		return { code: 0, stdout: "[]", stderr: "", killed: false };
	});
	await tool.execute("call", { query: "python docs", count: 4, fetch: true });

	assert.deepEqual(calls[0][1], ["--fetch", "python docs", "4"]);
	assert.equal(calls[0][2].timeout, 170_000);
});

test("paused Google fails before CLI execution and recommends minimal Exa", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-google-paused-tool-"));
	const statePath = join(directory, "state.json");
	let executions = 0;
	try {
		await writeFile(statePath, `${JSON.stringify({ paused: true })}\n`, { mode: 0o600 });
		const tool = registeredTool(async () => {
			executions++;
			return { code: 0, stdout: "[]", stderr: "", killed: false };
		}, statePath);
		await assert.rejects(
			() => tool.execute("call", { query: "python docs" }),
			(error: Error) => error.message === GOOGLE_PAUSED_ERROR,
		);
		assert.equal(executions, 0);
		assert.match(GOOGLE_PAUSED_ERROR, /exa_search.*numResults=3.*includeText=false/i);
		assert.match(GOOGLE_PAUSED_ERROR, /\/pause-google/);
		assert.doesNotMatch(await readFile(statePath, "utf8"), /python docs/);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("bot-challenge auto-pause guides but does not hard-block, and expires itself", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-google-bot-pause-"));
	const statePath = join(directory, "state.json");
	let executions = 0;
	try {
		await writeFile(statePath, `${JSON.stringify({ paused: true, reason: "bot_challenges", autoResumeAt: Date.now() + 60_000 })}\n`, { mode: 0o600 });
		const tool = registeredTool(async () => {
			executions++;
			return { code: 0, stdout: "[]", stderr: "", killed: false };
		}, statePath);
		await tool.execute("call", { query: "python docs" });
		assert.equal(executions, 1);

		await writeFile(statePath, `${JSON.stringify({ paused: true, reason: "bot_challenges", autoResumeAt: Date.now() - 1000 })}\n`);
		await tool.execute("call", { query: "python docs" });
		assert.equal(executions, 2);
		assert.equal(JSON.parse(await readFile(statePath, "utf8")).paused, false);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("/pause-google synchronizes every Pi instance and controls the model footer indicator", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-google-global-pause-"));
	const statePath = join(directory, "state.json");
	const first = extensionHarness(statePath);
	const second = extensionHarness(statePath);
	try {
		await first.emitLifecycle("session_start");
		await second.emitLifecycle("session_start");

		const command = first.commands.get("pause-google");
		assert.ok(command);
		await command.handler("", first.context);
		assert.deepEqual(first.execCalls[0][1], ["--pause-toggle"]);
		await waitFor(() => second.statuses.get("google-search-paused") === GOOGLE_PAUSE_INDICATOR);
		assert.equal(first.footer, GOOGLE_PAUSE_INDICATOR);
		assert.equal(first.statuses.get("google-search-paused"), GOOGLE_PAUSE_INDICATOR);
		assert.equal(second.footer, GOOGLE_PAUSE_INDICATOR);
		assert.match(first.notifications.at(-1) ?? "", /paused globally/i);

		await command.handler("", first.context);
		await waitFor(() => !second.statuses.has("google-search-paused"));
		assert.equal(first.footer, undefined);
		assert.equal(second.footer, undefined);
		assert.match(first.notifications.at(-1) ?? "", /resumed globally/i);

		await first.emitLifecycle("session_shutdown");
		await second.emitLifecycle("session_shutdown");
		await writeFile(statePath, `${JSON.stringify({ paused: true })}\n`);
		await new Promise((resolve) => setTimeout(resolve, 350));
		assert.equal(first.statuses.has("google-search-paused"), false);
		assert.equal(second.statuses.has("google-search-paused"), false);
	} finally {
		await first.emitLifecycle("session_shutdown");
		await second.emitLifecycle("session_shutdown");
		await rm(directory, { recursive: true, force: true });
	}
});

test("failed HTML fetches and PDFs remain plain URL results", () => {
	const formatted = formatResults([{
		title: "PDF result",
		url: "https://example.com/report.pdf",
		snippet: "Report",
	}], true);
	assert.match(formatted.text, /https:\/\/example\.com\/report\.pdf/);
	assert.doesNotMatch(formatted.text, /text:/);
	assert.doesNotMatch(formatted.text, /unavailable|warning/i);
});

test("successful execution does not expose soft fetch diagnostics", async () => {
	const stdout = JSON.stringify([{
		title: "PDF result",
		url: "https://example.com/report.pdf",
		snippet: "Report",
	}]);
	const tool = registeredTool(async () => ({
		code: 0,
		stdout,
		stderr: "google-search: fetch result 1 failed: HTTP 429",
		killed: false,
	}));
	const result = await tool.execute("call", { query: "report", fetch: true });
	assert.match(result.content[0].text, /report\.pdf/);
	assert.doesNotMatch(result.content[0].text, /429|Warnings/);
});

test("balances fetched text across all results within the tool budget", () => {
	const results: GoogleSearchResult[] = Array.from({ length: 10 }, (_, index) => ({
		title: `Result ${index}`,
		url: `https://example.com/${index}`,
		snippet: "Snippet",
		text: "x".repeat(20_000),
	}));
	const formatted = formatResults(results, true);
	assert.equal(formatted.trimmed, true);
	assert.ok(Buffer.byteLength(formatted.text) < 45 * 1024);
	for (let index = 0; index < 10; index++) {
		assert.match(formatted.text, new RegExp(`Result ${index}`));
	}
});

test("removes terminal control characters from web output", () => {
	const formatted = formatResults([{
		title: "\u001b[31mTitle",
		url: "https://example.com/\u0007",
		snippet: "Snippet",
		text: "\u001b[32mPage text",
	}], true);
	assert.equal(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(formatted.text), false);
});

test("rejects malformed CLI output", () => {
	assert.throws(() => parseResults("not json"), /invalid JSON/);
	assert.throws(() => parseResults('[{"title":"missing fields"}]'), /invalid result/);
});

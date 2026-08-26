import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import modelStatus, { codexAccountMarker, formatResetRemaining, quotaResetAtMs } from "./index.ts";

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

test("numbered business providers render a compact account marker", () => {
	assert.equal(codexAccountMarker("codex-pi19"), "a:19");
	assert.equal(codexAccountMarker("codex-pi1"), "a:1");
	assert.equal(codexAccountMarker("codex-pro"), undefined);
	assert.equal(codexAccountMarker("codex-team4"), undefined);
	assert.equal(codexAccountMarker("codex-pi0"), undefined);
});

test("quota reset timestamps support absolute and relative API fields", () => {
	const now = Date.UTC(2026, 7, 16, 12, 0, 0);
	const reset = now + 5 * DAY_MS;
	assert.equal(quotaResetAtMs({ reset_at: reset / 1000 }, now), reset);
	assert.equal(quotaResetAtMs({ reset_at: reset }, now), reset);
	assert.equal(quotaResetAtMs({ reset_after_seconds: 11 * 60 * 60 }, now), now + 11 * HOUR_MS);
});

test("reset countdown uses days, then hours below one day", () => {
	const now = Date.UTC(2026, 7, 16, 12, 0, 0);
	assert.equal(formatResetRemaining(now + 5 * DAY_MS, now), "r:5d");
	assert.equal(formatResetRemaining(now + 11 * HOUR_MS, now), "r:11h");
	assert.equal(formatResetRemaining(now + DAY_MS - 1, now), "r:23h");
	assert.equal(formatResetRemaining(now - 1, now), "r:0h");
});

test("status refresh is background-only and shared usage/reset data is throttled", async (t) => {
	const root = mkdtempSync("/tmp/pi-model-status-");
	const usageStatusConfigPath = join(root, "usage-status.json");
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const originalFetch = globalThis.fetch;
	const fetches: string[] = [];
	globalThis.fetch = (async (_input, init) => {
		const account = (init?.headers as Record<string, string>)["chatgpt-account-id"];
		fetches.push(account);
		return {
			ok: account !== "failure",
			async json() {
				return { rate_limit: { primary_window: { used_percent: 8, reset_after_seconds: (5 * 24 + 1) * 60 * 60 } } };
			},
		} as Response;
	}) as typeof fetch;
	t.after(() => { globalThis.fetch = originalFetch; });

	const commands = new Map<string, any>();
	const handlers = new Map<string, any[]>();
	const notifications: Array<[string, string]> = [];
	let footerFactory: any;
	const pi = {
		on(event: string, handler: any) { handlers.set(event, [...(handlers.get(event) ?? []), handler]); },
		events: { on() { return () => {}; } },
		registerCommand(name: string, command: any) { commands.set(name, command); },
	} as any;
	modelStatus(pi, { usageStatusConfigPath });
	const contextFor = (provider: string, account: string, hasUI = false) => {
		const payload = Buffer.from(JSON.stringify({
			"https://api.openai.com/auth": { chatgpt_account_id: account },
		})).toString("base64url");
		return {
			hasUI,
			model: { provider, id: "gpt-5.6-sol" },
			modelRegistry: { async getApiKeyForProvider() { return `header.${payload}.signature`; } },
			sessionManager: { getEntries: () => [], getBranch: () => [] },
			getContextUsage: () => ({ tokens: 1_000 }),
			ui: {
				theme: { fg: (_color: string, text: string) => text },
				setFooter(factory: any) { footerFactory = factory; },
				notify(message: string, level: string) { notifications.push([message, level]); },
			},
		} as any;
	};
	const context = contextFor("codex-pro", "personal", true);

	const result = handlers.get("session_start")![0]({}, context);
	assert.equal(result, undefined, "session startup must not await quota I/O");
	const business = contextFor("codex-pi5", "business");
	handlers.get("model_select")![0]({}, business);
	assert.equal(fetches.length, 0);
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.deepEqual(fetches, ["personal", "business"], "different providers may refresh concurrently");

	const footer = footerFactory({ requestRender() {} });
	assert.doesNotMatch(footer.render(120)[0], /a:/);
	context.model.provider = "codex-pi19";
	assert.match(footer.render(120)[0], /gpt-5\.6-solh a:19 c:1\.0k/);
	context.model.provider = "codex-pro";
	assert.match(footer.render(120)[0], /u:92% r:5d/);
	await commands.get("usage").handler("off", context);
	assert.doesNotMatch(footer.render(120)[0], /u:/);
	assert.match(footer.render(120)[0], /r:5d/);
	assert.deepEqual(JSON.parse(readFileSync(usageStatusConfigPath, "utf8")), { usage: false, reset: true });
	await commands.get("reset").handler("off", context);
	assert.doesNotMatch(footer.render(120)[0], /u:|r:/);
	assert.deepEqual(JSON.parse(readFileSync(usageStatusConfigPath, "utf8")), { usage: false, reset: false });
	await handlers.get("turn_end")![0]({}, context);
	assert.equal(fetches.length, 2, "disabling both displays must stop requests");
	await commands.get("usage").handler("", context);
	assert.match(footer.render(120)[0], /u:92%/);
	assert.doesNotMatch(footer.render(120)[0], /r:/);
	await commands.get("reset").handler("", context);
	assert.match(footer.render(120)[0], /u:92% r:5d/);
	assert.deepEqual(JSON.parse(readFileSync(usageStatusConfigPath, "utf8")), { usage: true, reset: true });
	await commands.get("usage").handler("typo", context);
	assert.deepEqual(notifications.at(-1), ["Usage: /usage [on|off|status]", "warning"]);
	assert.deepEqual(JSON.parse(readFileSync(usageStatusConfigPath, "utf8")), { usage: true, reset: true });

	handlers.get("model_select")![0]({}, context);
	handlers.get("model_select")![0]({}, contextFor("anthropic", "other"));
	handlers.get("model_select")![0]({}, context);
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.equal(fetches.length, 2, "switching away and back must retain each provider's throttle/cache");

	const failure = contextFor("codex-failure", "failure");
	handlers.get("model_select")![0]({}, failure);
	await new Promise((resolve) => setTimeout(resolve, 0));
	await handlers.get("turn_end")![0]({}, failure);
	assert.deepEqual(fetches, ["personal", "business", "failure"], "failed requests must also be throttled");
	await handlers.get("session_shutdown")![0]({}, context);
});

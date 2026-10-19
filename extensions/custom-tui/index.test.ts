import assert from "node:assert/strict";
import test from "node:test";
import installCustomTui, { compactResumeHint } from "./index.ts";

test("removes only the plain resume-hint label", () => {
	assert.equal(
		compactResumeHint("To resume this session: pi --session 01a00fba-0c13-777c-8853-f6274a1e5d3f\n"),
		"pi --session 01a00fba-0c13-777c-8853-f6274a1e5d3f\n",
	);
});

test("removes the ANSI-dimmed resume-hint label", () => {
	assert.equal(
		compactResumeHint("\x1b[2mTo resume this session:\x1b[22m pi --session abc\n"),
		"pi --session abc\n",
	);
});

test("factory hides only routine extension notices before session_start", async () => {
	const stateKey = Symbol.for("pi-codex-ultra.extension-policy.v1");
	const globals = globalThis as typeof globalThis & Record<symbol, unknown>;
	const previous = globals[stateKey];
	const state = { skipped: [], suppressed: [{ reason: "managed-command-conflict" }], loadedOptionalCount: 37 };
	const snapshot = structuredClone(state);
	globals[stateKey] = state;
	try {
		await installCustomTui({ on() {} } as any);
		const { InteractiveMode } = await import(new URL(
			"modes/interactive/interactive-mode.js", import.meta.resolve("@earendil-works/pi-coding-agent"),
		).href);
		const notify = InteractiveMode.prototype.showExtensionNotify;
		const calls: Array<[string, string]> = [];
		const sink = {
			showStatus: (message: string) => calls.push([message, "info"]),
			showWarning: (message: string) => calls.push([message, "warning"]),
			showError: (message: string) => calls.push([message, "error"]),
		};
		const healthy = "Extensions: 37 optional loaded · 0 skipped · 43 managed conflicts suppressed. Use /u d and /config for details.";
		notify.call(sink, healthy, "info");
		notify.call(sink, healthy);
		assert.deepEqual(calls, []);

		const skipped = healthy.replace("0 skipped", "1 skipped");
		for (const [message, type] of [
			[skipped, "warning"], [skipped, "info"], [healthy, "warning"], [healthy, "error"],
			["Pi Codex Ultra extension policy is unavailable.", "error"], ["Ordinary notification", "info"],
		] as const) {
			notify.call(sink, message, type);
			assert.deepEqual(calls.pop(), [message, type]);
		}
		assert.strictEqual(globals[stateKey], state);
		assert.deepEqual(state, snapshot);
		await installCustomTui({ on() {} } as any);
		assert.strictEqual(InteractiveMode.prototype.showExtensionNotify, notify);
	} finally {
		if (previous === undefined) delete globals[stateKey];
		else globals[stateKey] = previous;
	}
});

test("preserves session-directory arguments and unrelated output", () => {
	assert.equal(
		compactResumeHint("To resume this session: pi --session-dir '/tmp/custom dir' --session abc\n"),
		"pi --session-dir '/tmp/custom dir' --session abc\n",
	);
	assert.equal(compactResumeHint("Error: To resume this session: not a hint\n"), "Error: To resume this session: not a hint\n");
});

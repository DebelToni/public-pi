import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import toolHideExtension from "./index.ts";

const codingAgentEntry = import.meta.resolve("@earendil-works/pi-coding-agent");
const codingAgentInternal = (path: string) => new URL(path, codingAgentEntry).href;
const { initTheme } = await import(codingAgentInternal("modes/interactive/theme/theme.js"));
initTheme("dark", false);
const assistantModule = await import(codingAgentInternal("modes/interactive/components/assistant-message.js"));
const { AssistantMessageComponent } = assistantModule;

function assistant(content: any[], stopReason = "stop"): any {
	return {
		role: "assistant",
		content,
		api: "faux",
		provider: "faux",
		model: "faux-1",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: Date.now(),
	};
}

test("hidden tools add one separator above final answers only", async () => {
	const shortcuts = new Map<string, { handler: (ctx: ExtensionContext) => Promise<void> }>();
	await toolHideExtension({
		on() {},
		registerShortcut(key: string, definition: any) { shortcuts.set(key, definition); },
		registerCommand() {},
	} as unknown as ExtensionAPI);

	const final = new AssistantMessageComponent(assistant([{ type: "text", text: "Final answer" }]));
	assert.notEqual(final.render(80)[0], "---");

	const ctx = {
		ui: {
			theme: { fg: (_color: string, text: string) => text },
			setStatus() {},
			setHiddenThinkingLabel() {},
			notify() {},
		},
	} as unknown as ExtensionContext;
	await shortcuts.get("ctrl+alt+o")!.handler(ctx);
	assert.equal(final.render(80).filter((line: string) => line === "---").length, 1);
	assert.equal(final.render(80)[0], "---");

	const toolTurn = new AssistantMessageComponent(assistant([
		{ type: "toolCall", id: "call", name: "read", arguments: {} },
	], "toolUse"));
	assert.equal(toolTurn.render(80).includes("---"), false);

	const truncated = new AssistantMessageComponent(assistant([{ type: "text", text: "Partial" }], "length"));
	assert.equal(truncated.render(80).includes("---"), false);

	await shortcuts.get("ctrl+alt+o")!.handler(ctx);
	assert.equal(final.render(80).includes("---"), false);
});

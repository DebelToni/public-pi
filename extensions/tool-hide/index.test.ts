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
const { ToolExecutionComponent } = await import(codingAgentInternal("modes/interactive/components/tool-execution.js"));
const originalAssistantRender = AssistantMessageComponent.prototype.render;
const originalToolRender = ToolExecutionComponent.prototype.render;

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

	const local = new AssistantMessageComponent(assistant([{ type: "text", text: "Local transcript note" }]));
	Object.assign(local, { [Symbol.for("anton.pi.local-transcript-visibility")]: true });
	assert.equal(local.render(80).includes("---"), false);
	const tool = new ToolExecutionComponent("custom", "call", {}, { showImages: false }, undefined, { requestRender() {} } as any, process.cwd());
	assert.equal(tool.render(80).length, 0);
	Object.assign(tool, { [Symbol.for("anton.pi.local-transcript-visibility")]: true });
	assert.ok(tool.render(80).length > 0);

	await shortcuts.get("ctrl+alt+o")!.handler(ctx);
	assert.equal(final.render(80).includes("---"), false);
});

test("reload migrates legacy prototype patches without changing parent visibility", async () => {
	const toolKey = Symbol.for("anton.pi.tool-hide.state");
	const assistantKey = Symbol.for("anton.pi.tool-hide.assistant-render");
	const localKey = Symbol.for("anton.pi.local-transcript-visibility");
	const toolProto = ToolExecutionComponent.prototype;
	const assistantProto = AssistantMessageComponent.prototype;
	const saved = { tool: toolProto.render, state: toolProto[toolKey], assistant: assistantProto.render, version: assistantProto[assistantKey] };
	const legacyState: any = { hidden: true, originalRender: originalToolRender };
	toolProto[toolKey] = legacyState;
	toolProto.render = function (width: number) {
		return legacyState.hidden ? [] : originalToolRender.call(this, width);
	};
	assistantProto[assistantKey] = true;
	assistantProto.render = function (width: number) {
		const lines = originalAssistantRender.call(this, width);
		const final = this.lastMessage?.stopReason === "stop" && this.lastMessage.content?.some((part: any) => part.type === "text" && part.text?.trim());
		return legacyState.hidden && final && lines.length ? ["-".repeat(Math.min(3, width)), ...lines] : lines;
	};
	try {
		const localTool = new ToolExecutionComponent("custom", "local", {}, { showImages: false }, undefined, { requestRender() {} } as any, process.cwd());
		const parentTool = new ToolExecutionComponent("custom", "parent", {}, { showImages: false }, undefined, { requestRender() {} } as any, process.cwd());
		const final = new AssistantMessageComponent(assistant([{ type: "text", text: "Parent final" }]));
		const localFinal = new AssistantMessageComponent(assistant([{ type: "text", text: "Local final" }]));
		Object.assign(localTool, { [localKey]: true });
		Object.assign(localFinal, { [localKey]: true });
		assert.equal(localTool.render(80).length, 0, "the old patch ignores local visibility");
		assert.equal(localFinal.render(80)[0], "---");
		for (let reload = 0; reload < 2; reload++) {
			await toolHideExtension({ on() {}, registerShortcut() {}, registerCommand() {} } as unknown as ExtensionAPI);
			assert.equal(legacyState.hidden, true);
			assert.equal(legacyState.version, 2);
			assert.equal(parentTool.render(80).length, 0);
			assert.ok(localTool.render(80).length > 0);
			assert.equal(final.render(80).filter((line: string) => line === "---").length, 1);
			assert.equal(localFinal.render(80).includes("---"), false);
		}
	} finally {
		toolProto.render = saved.tool;
		toolProto[toolKey] = saved.state;
		assistantProto.render = saved.assistant;
		assistantProto[assistantKey] = saved.version;
	}
});

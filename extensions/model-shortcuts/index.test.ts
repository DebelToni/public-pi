import { describe, expect, test } from "bun:test";
import modelShortcuts from "./index.js";

function setup(provider = "codex-pi20", model = "gpt-6.1-sol") {
	const commands = new Map<string, any>();
	const shortcuts = new Map<string, any>();
	const selected: any[] = [];
	const thinkingLevels: string[] = [];
	const notifications: Array<[string, string]> = [];
	const models = new Map([
		[`${provider}/gpt-5.3-codex-spark`, { provider, id: "gpt-5.3-codex-spark" }],
		[`${provider}/gpt-6-luna`, { provider, id: "gpt-6-luna" }],
		[`${provider}/gpt-6.1-sol`, { provider, id: "gpt-6.1-sol" }],
		[`${provider}/gpt-6-astra`, { provider, id: "gpt-6-astra" }],
	]);
	modelShortcuts({
		registerCommand(name: string, command: any) { commands.set(name, command); },
		registerShortcut(name: string, shortcut: any) { shortcuts.set(name, shortcut); },
		async setModel(target: any) { selected.push(target); return true; },
		setThinkingLevel(level: string) { thinkingLevels.push(level); },
	} as any);
	const context = {
		model: { provider, id: model },
		modelRegistry: { find: (targetProvider: string, targetModel: string) => models.get(`${targetProvider}/${targetModel}`) },
		ui: { notify: (message: string, level: string) => notifications.push([message, level]) },
	};
	return { commands, shortcuts, context, selected, thinkingLevels, notifications };
}

describe("Codex model shortcuts", () => {
	test("/luna, /sol, /spark, and /astra retain the current Codex account", async () => {
		const luna = setup("codex-pro");
		await luna.commands.get("luna").handler("", luna.context);
		expect(luna.selected).toEqual([{ provider: "codex-pro", id: "gpt-6-luna" }]);
		expect(luna.thinkingLevels).toEqual(["high"]);

		const sol = setup("codex-pi7", "gpt-6-luna");
		await sol.commands.get("sol").handler("", sol.context);
		expect(sol.selected).toEqual([{ provider: "codex-pi7", id: "gpt-6.1-sol" }]);
		expect(sol.thinkingLevels).toEqual(["high"]);

		const spark = setup("codex-pro");
		await spark.commands.get("spark").handler("", spark.context);
		expect(spark.selected).toEqual([{ provider: "codex-pro", id: "gpt-5.3-codex-spark" }]);
		expect(spark.thinkingLevels).toEqual(["medium"]);

		const astra = setup("codex-pi16");
		await astra.commands.get("astra").handler("", astra.context);
		expect(astra.selected).toEqual([{ provider: "codex-pi16", id: "gpt-6-astra" }]);
		expect(astra.thinkingLevels).toEqual(["max"]);
	});

	test("Option+L and Option+S invoke the Luna and Sol shortcuts", async () => {
		const luna = setup("codex-pro", "gpt-6.1-sol");
		await luna.shortcuts.get("alt+l").handler(luna.context);
		expect(luna.selected).toEqual([{ provider: "codex-pro", id: "gpt-6-luna" }]);
		expect(luna.thinkingLevels).toEqual(["high"]);

		const sol = setup("codex-pro", "gpt-6-luna");
		await sol.shortcuts.get("alt+s").handler(sol.context);
		expect(sol.selected).toEqual([{ provider: "codex-pro", id: "gpt-6.1-sol" }]);
		expect(sol.thinkingLevels).toEqual(["high"]);
	});

	test("refuses to guess an account outside account-specific Codex providers", async () => {
		const setupResult = setup("openai-codex");
		await setupResult.commands.get("luna").handler("", setupResult.context);
		expect(setupResult.selected).toEqual([]);
		expect(setupResult.notifications.at(-1)).toEqual([
			"This shortcut requires a current Codex account.",
			"warning",
		]);
	});
});

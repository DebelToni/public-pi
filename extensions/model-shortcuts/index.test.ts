import { describe, expect, test } from "bun:test";
import modelShortcuts from "./index.js";

function setup(provider = "codex-pi20", model = "gpt-5.6-sol") {
	const commands = new Map<string, any>();
	const selected: any[] = [];
	const notifications: Array<[string, string]> = [];
	const models = new Map([
		[`${provider}/gpt-5.3-codex-spark`, { provider, id: "gpt-5.3-codex-spark" }],
		[`${provider}/gpt-5.6-luna`, { provider, id: "gpt-5.6-luna" }],
		[`${provider}/gpt-5.6-sol`, { provider, id: "gpt-5.6-sol" }],
	]);
	modelShortcuts({
		registerCommand(name: string, command: any) { commands.set(name, command); },
		async setModel(target: any) { selected.push(target); return true; },
	} as any);
	const context = {
		model: { provider, id: model },
		modelRegistry: { find: (targetProvider: string, targetModel: string) => models.get(`${targetProvider}/${targetModel}`) },
		ui: { notify: (message: string, level: string) => notifications.push([message, level]) },
	};
	return { commands, context, selected, notifications };
}

describe("Codex model shortcuts", () => {
	test("/luna, /sol, and /spark retain the current Codex account", async () => {
		const luna = setup("codex-pro");
		await luna.commands.get("luna").handler("", luna.context);
		expect(luna.selected).toEqual([{ provider: "codex-pro", id: "gpt-5.6-luna" }]);

		const sol = setup("codex-pi7", "gpt-5.6-luna");
		await sol.commands.get("sol").handler("", sol.context);
		expect(sol.selected).toEqual([{ provider: "codex-pi7", id: "gpt-5.6-sol" }]);

		const spark = setup("codex-pro");
		await spark.commands.get("spark").handler("", spark.context);
		expect(spark.selected).toEqual([{ provider: "codex-pro", id: "gpt-5.3-codex-spark" }]);
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

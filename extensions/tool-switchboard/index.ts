import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, type SettingItem, SettingsList, Text } from "@earendil-works/pi-tui";
import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const configPath = () => join(getAgentDir(), "disabled-tools.json");

function readDisabled(): Set<string> {
	let text: string;
	try {
		text = readFileSync(configPath(), "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Set();
		throw error;
	}
	const names: unknown = JSON.parse(text);
	if (!Array.isArray(names) || !names.every((name) => typeof name === "string")) {
		throw new Error(`${configPath()} must contain an array of tool names`);
	}
	return new Set(names);
}

function saveDisabled(names: Set<string>) {
	const path = configPath();
	const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
	writeFileSync(temporary, `${JSON.stringify([...names].sort(), null, 2)}\n`);
	renameSync(temporary, path);
}

export default function toolSwitchboard(pi: ExtensionAPI) {
	// Remember only tools this extension removed, so enabling one cannot override
	// a tool disabled for another reason (for example, a session's tool loadout).
	const suppressed = new Set<string>();

	function apply() {
		const disabled = readDisabled();
		const active = new Set(pi.getActiveTools());
		const available = new Set(pi.getAllTools().map((tool) => tool.name));
		for (const name of suppressed) {
			if (!disabled.has(name)) {
				if (available.has(name)) active.add(name);
				suppressed.delete(name);
			}
		}
		for (const name of disabled) {
			if (active.delete(name)) suppressed.add(name);
		}
		const current = pi.getActiveTools();
		if (active.size !== current.length || current.some((name) => !active.has(name))) {
			pi.setActiveTools([...active]);
		}
	}

	function toggle(name: string, enabled?: boolean) {
		const disabled = readDisabled();
		const shouldEnable = enabled ?? disabled.has(name);
		if (shouldEnable) disabled.delete(name);
		else disabled.add(name);
		saveDisabled(disabled);
		apply();
		return shouldEnable;
	}

	pi.on("session_start", () => {
		suppressed.clear();
		apply();
	});
	pi.on("before_agent_start", () => apply());
	pi.on("context", () => apply());

	pi.registerCommand("tools", {
		description: "Enable or disable model-callable tools globally",
		handler: async (args, ctx) => {
			const names = pi.getAllTools().map((tool) => tool.name).sort();
			const [name, action, ...extra] = args.trim().split(/\s+/);
			if (name && names.includes(name) && extra.length === 0 && (!action || ["on", "off"].includes(action))) {
				const enabled = toggle(name, action ? action === "on" : undefined);
				ctx.ui.notify(`${name}: ${enabled ? "allowed" : "blocked"}`, "info");
				return;
			}
			if (args.trim()) {
				ctx.ui.notify("Usage: /tools [tool_name [on|off]]", "warning");
				return;
			}
			if (!ctx.hasUI) return;
			if (ctx.mode === "tui") {
				const disabled = readDisabled();
				const items: SettingItem[] = names.map((tool) => ({
					id: tool,
					label: tool,
					currentValue: disabled.has(tool) ? "blocked" : "allowed",
					values: ["allowed", "blocked"],
				}));
				await ctx.ui.custom((tui, theme, _keys, done) => {
					const list = new SettingsList(
						items,
						Math.min(items.length, 10, Math.max(1, tui.terminal.rows - 12)),
						{
							label: (text, selected) => selected ? theme.fg("accent", text) : text,
							value: (text, selected) => theme.fg(selected ? "accent" : "muted", text),
							description: (text) => theme.fg("dim", text),
							cursor: theme.fg("accent", "→ "),
							hint: (text) => theme.fg("dim", text),
						},
						(tool, value) => toggle(tool, value === "allowed"),
						() => done(undefined),
						{ enableSearch: true },
					);
					const container = new Container();
					container.addChild(new Text(theme.fg("accent", "Model tools"), 0, 0));
					container.addChild(list);
					return {
						render: (width: number) => container.render(width),
						invalidate: () => container.invalidate(),
						handleInput: (data: string) => { list.handleInput(data); tui.requestRender(); },
					};
				});
				return;
			}
			while (true) {
				const disabled = readDisabled();
				const labels = names.map((tool) => `${disabled.has(tool) ? "blocked" : "allowed"}  ${tool}`);
				const selected = await ctx.ui.select("Model tools (Esc to close)", labels);
				if (!selected) return;
				const index = labels.indexOf(selected);
				if (index !== -1) toggle(names[index]);
			}
		},
	});
}

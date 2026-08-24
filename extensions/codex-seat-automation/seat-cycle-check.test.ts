import { expect, test } from "bun:test";
import {
	installCodexSelectionTestMode,
	installSeatCycleCheck,
	soleUsableProvider,
} from "./seat-cycle-check.js";

const before = [
	{ label: "Y Ananas", providerId: "codex-y-ananas", usage: { score: 80, label: "80% left" } },
	{ label: "X Banan", providerId: "codex-x-banan", usage: { score: -1, label: "usage-based/skipped" } },
];
const after = [
	{ label: "Y Ananas", providerId: "codex-y-ananas", usage: { score: -1, label: "usage-based/skipped" } },
	{ label: "X Banan", providerId: "codex-x-banan", usage: { score: 100, label: "100% left" } },
];

test("sole usable provider requires one known positive account", () => {
	expect(soleUsableProvider(before)).toBe("codex-y-ananas");
	expect(soleUsableProvider([...before, { label: "broken", providerId: "codex-broken" }])).toBeUndefined();
});

test("test mode blocks account selection commands synchronously", () => {
	let listener: ((value: unknown) => void) | undefined;
	const pi = {
		events: {
			on(_channel: string, handler: (value: unknown) => void) {
				listener = handler;
				return () => {};
			},
		},
	};
	installCodexSelectionTestMode(pi as never);
	const mode = { version: 1, selectionDisabled: false };
	listener?.(mode);
	expect(mode.selectionDisabled).toBe(true);
});

test("seat-cycle-check rotates once, prints changed usage, and never selects a model", async () => {
	const commands = new Map<string, any>();
	const listeners = new Map<string, any[]>();
	const notifications: Array<[string, string]> = [];
	const pi = {
		on(event: string, handler: any) {
			listeners.set(event, [...(listeners.get(event) ?? []), handler]);
		},
		registerCommand(name: string, command: any) {
			commands.set(name, command);
		},
	};
	let queries = 0;
	let rotations = 0;
	installSeatCycleCheck(pi as never, {
		query: async () => queries++ === 0 ? before : after,
		rotate: async (_pi, _context, guard) => {
			expect(guard()).toBe(true);
			rotations++;
			return { version: 1, status: "succeeded" };
		},
		sleep: async () => {},
	});
	for (const handler of listeners.get("session_start") ?? []) handler({}, {});
	const context = {
		ui: {
			notify(message: string, level: string) {
				notifications.push([message, level]);
			},
		},
	};
	await commands.get("seat-cycle-check").handler("", context);
	expect(rotations).toBe(1);
	expect(queries).toBe(2);
	expect(notifications[0][0]).toContain("Before seat rotation:\nY Ananas: 80% left");
	expect(notifications.at(-1)?.[0]).toContain("Seat usage moved to codex-x-banan.");
	expect("setModel" in context.ui).toBe(false);
});

test("seat-cycle-check refuses an ambiguous baseline before mutation", async () => {
	const commands = new Map<string, any>();
	const listeners = new Map<string, any[]>();
	let rotations = 0;
	const pi = {
		on(event: string, handler: any) {
			listeners.set(event, [...(listeners.get(event) ?? []), handler]);
		},
		registerCommand(name: string, command: any) {
			commands.set(name, command);
		},
	};
	installSeatCycleCheck(pi as never, {
		query: async () => [
			before[0],
			{ label: "unknown", providerId: "codex-unknown", error: "query failed" },
		],
		rotate: async () => { rotations++; return { version: 1, status: "succeeded" }; },
		sleep: async () => {},
	});
	for (const handler of listeners.get("session_start") ?? []) handler({}, {});
	const notifications: string[] = [];
	await commands.get("seat-cycle-check").handler("", {
		ui: { notify(message: string) { notifications.push(message); } },
	});
	expect(rotations).toBe(0);
	expect(notifications.at(-1)).toContain("no seat was rotated");
});

test("seat-cycle-check stops after a failed rotation", async () => {
	const commands = new Map<string, any>();
	const listeners = new Map<string, any[]>();
	let queries = 0;
	const pi = {
		on(event: string, handler: any) {
			listeners.set(event, [...(listeners.get(event) ?? []), handler]);
		},
		registerCommand(name: string, command: any) {
			commands.set(name, command);
		},
	};
	installSeatCycleCheck(pi as never, {
		query: async () => { queries++; return before; },
		rotate: async () => ({ version: 1, status: "failed", message: "safe failure" }),
		sleep: async () => { throw new Error("must not poll"); },
	});
	for (const handler of listeners.get("session_start") ?? []) handler({}, {});
	const notifications: string[] = [];
	await commands.get("seat-cycle-check").handler("", {
		ui: { notify(message: string) { notifications.push(message); } },
	});
	expect(queries).toBe(1);
	expect(notifications.at(-1)).toContain("Seat rotation failed: safe failure");
});

import { expect, test } from "bun:test";
import {
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

function eventBus() {
	const handlers = new Map<string, Set<(value: unknown) => void>>();
	return {
		on(channel: string, handler: (value: unknown) => void) {
			const listeners = handlers.get(channel) ?? new Set();
			listeners.add(handler);
			handlers.set(channel, listeners);
			return () => listeners.delete(handler);
		},
		emit(channel: string, value: unknown) {
			for (const handler of handlers.get(channel) ?? []) handler(value);
		},
	};
}

test("sole usable provider requires one known positive account", () => {
	expect(soleUsableProvider(before)).toBe("codex-y-ananas");
	expect(soleUsableProvider([...before, { label: "broken", providerId: "codex-broken" }])).toBeUndefined();
});

test("seat-cycle-check rotates once, prints changed usage, and never selects a model", async () => {
	const commands = new Map<string, any>();
	const listeners = new Map<string, any[]>();
	const notifications: Array<[string, string]> = [];
	const events = eventBus();
	const pi = {
		events,
		on(event: string, handler: any) {
			listeners.set(event, [...(listeners.get(event) ?? []), handler]);
		},
		registerCommand(name: string, command: any) {
			commands.set(name, command);
		},
	};
	let queries = 0;
	let rotations = 0;
	const selectionBlocks: boolean[] = [];
	installSeatCycleCheck(pi as never, {
		query: async () => {
			const mode = { version: 1, selectionDisabled: false };
			events.emit("codex-accounts:selection-mode:v1", mode);
			selectionBlocks.push(mode.selectionDisabled);
			return queries++ === 0 ? before : after;
		},
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
	expect(selectionBlocks).toEqual([true, true]);
	const afterCheck = { version: 1, selectionDisabled: false };
	events.emit("codex-accounts:selection-mode:v1", afterCheck);
	expect(afterCheck.selectionDisabled).toBe(false);
	expect(notifications[0][0]).toContain("Before seat rotation:\nY Ananas: 80% left");
	expect(notifications.at(-1)?.[0]).toContain("Seat usage moved to codex-x-banan.");
	expect("setModel" in context.ui).toBe(false);
});

test("seat-cycle-check refuses an ambiguous baseline before mutation", async () => {
	const commands = new Map<string, any>();
	const listeners = new Map<string, any[]>();
	let rotations = 0;
	const pi = {
		events: eventBus(),
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
		events: eventBus(),
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

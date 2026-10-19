import { ExtensionRunner, SessionManager, type ExtensionAPI, type ExtensionContext, type SessionEntry } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import harnessTiming from "./index.ts";

const HOUR = 3_600_000;
const START = Date.parse("2026-10-08T09:15:00+03:00");

function user(at: number, content: any = "Continue."): SessionEntry {
	return {
		type: "message", id: String(at), parentId: null,
		timestamp: new Date(at).toISOString(),
		message: { role: "user", timestamp: at, content },
	};
}

function assistant(at: number, stopReason = "stop", started = START): SessionEntry {
	return {
		type: "message", id: `a-${at}`, parentId: null,
		timestamp: new Date(at).toISOString(),
		message: {
			role: "assistant", timestamp: started, stopReason,
			content: [{ type: "text", text: "Done." }],
		},
	} as SessionEntry;
}

function receive(branch: SessionEntry[], message: AgentMessage) {
	let handler: any;
	harnessTiming({ on(name: string, fn: any) {
		expect(name).toBe("message_end");
		handler = fn;
	} } as unknown as ExtensionAPI);
	return handler({ type: "message_end", message }, {
		sessionManager: { getBranch: () => branch },
	} as unknown as ExtensionContext)?.message ?? message;
}

function accept(entries: SessionEntry[]) {
	return receive(entries.slice(0, -1), (entries.at(-1) as any).message) as AgentMessage;
}

function text(message: AgentMessage) {
	if (message.role !== "user") throw new Error("Expected a user message");
	return typeof message.content === "string" ? message.content
		: message.content.filter((block) => block.type === "text").map((block) => block.text).join("");
}

describe("persisted harness timing", () => {
	test("first messages and rapid chats receive no tag", () => {
		const first = user(START);
		expect(accept([first])).toBe((first as any).message);
		const next = user(START + 60_000);
		expect(accept([first, assistant(START + 10_000), next])).toBe((next as any).message);
	});

	test("three hours is excluded; one millisecond more is included", () => {
		expect(text(accept([user(START), user(START + 3 * HOUR)]))).toBe("Continue.");
		expect(text(accept([user(START), user(START + 3 * HOUR + 1)]))).toBe(
			"<harness_timing>\nprevious user: Oct 8 09:15\ncurrent user: Oct 8 12:15\n</harness_timing>\n\nContinue.",
		);
	});

	test("long run uses completion time, not assistant generation time", () => {
		expect(text(accept([user(START), assistant(START + HOUR + 1), user(START + HOUR + 60_000)]))).toBe(
			"<harness_timing>\nagent started: Oct 8 09:15\nagent finished: Oct 8 10:15\n</harness_timing>\n\nContinue.",
		);
	});

	test("one hour is excluded, and user waiting is not work", () => {
		expect(text(accept([user(START), assistant(START + HOUR), user(START + 2 * HOUR)]))).toBe("Continue.");
		const result = text(accept([user(START), assistant(START + 60_000), user(START + 5 * HOUR)]));
		expect(result).toContain("previous user:");
		expect(result).not.toContain("agent finished:");
	});

	test("both conditions share the start timestamp", () => {
		expect(text(accept([user(START), assistant(START + 2 * HOUR), user(START + 5 * HOUR)]))).toBe(
			"<harness_timing>\nprevious user: Oct 8 09:15\nagent finished: Oct 8 11:15\ncurrent user: Oct 8 14:15\n</harness_timing>\n\nContinue.",
		);
	});

	test("tool turns, errors, aborts and incomplete replies are not final replies", () => {
		for (const reason of ["toolUse", "error", "aborted", "length", "pending", "deferred"]) {
			expect(text(accept([user(START), assistant(START + 2 * HOUR, reason), user(START + 2 * HOUR + 60_000)]))).toBe("Continue.");
		}
		expect(text(accept([user(START), assistant(START + 2 * HOUR), assistant(START + 2 * HOUR + 1, "error"), user(START + 2 * HOUR + 60_000)]))).toBe("Continue.");
	});

	test("the latest final reply wins across assistant turns", () => {
		expect(text(accept([user(START), assistant(START + 60_000), assistant(START + 2 * HOUR), user(START + 2 * HOUR + 60_000)]))).toContain("agent finished: Oct 8 11:15");
	});

	test("returns augmented content for persistence while preserving images and timestamps", () => {
		const image = { type: "image", data: "image-data", mimeType: "image/png" };
		const entries = [user(START), user(START + 4 * HOUR, [image, { type: "text", text: "Look." }])];
		const snapshot = JSON.stringify(entries);
		const result = accept(entries) as any;
		expect(result.content[0].text).toStartWith("<harness_timing>");
		expect(result.content[1]).toBe(image);
		expect(result.content[2].text).toBe("Look.");
		expect(result.timestamp).toBe(START + 4 * HOUR);
		expect(JSON.stringify(entries)).toBe(snapshot);
	});

	test("does not duplicate an existing tag in string or array content", () => {
		const entries = [user(START), user(START + 4 * HOUR)];
		const result = accept(entries);
		expect(receive(entries.slice(0, -1), result)).toBe(result);
		const arrayResult = accept([user(START), user(START + 4 * HOUR, [{ type: "text", text: "Hi." }])]);
		expect(receive(entries.slice(0, -1), arrayResult)).toBe(arrayResult);
	});

	test("ignores assistant, system and custom messages", () => {
		for (const message of [
			(assistant(START + 2 * HOUR) as any).message,
			{ role: "system", content: "Instructions.", timestamp: START + 4 * HOUR },
			{ role: "custom", customType: "note", content: "Note.", timestamp: START + 4 * HOUR },
		]) expect(receive([user(START)], message)).toBe(message);
		const custom = { type: "custom_message", timestamp: new Date(START + 2 * HOUR).toISOString(), customType: "note", content: "note" } as SessionEntry;
		expect(text(accept([user(START), custom, user(START + 4 * HOUR)]))).toContain("previous user: Oct 8 09:15");
	});

	test("equal-millisecond queued messages use the previously accepted user", () => {
		const at = START + 4 * HOUR;
		const first = accept([user(START), user(at, "First.")]);
		expect(text(first)).toStartWith("<harness_timing>");
		expect(text(accept([user(START), { ...user(at), message: first } as SessionEntry, user(at, "Second.")]))).toBe("Second.");
	});

	test("a queued user received before completion does not claim a completed run", () => {
		expect(text(accept([user(START), assistant(START + 2 * HOUR), user(START + 1.5 * HOUR)]))).toBe("Continue.");
	});

	test("formats midnight and year boundaries without year, seconds or UTC", () => {
		const before = Date.parse("2026-12-31T20:00:00+02:00");
		const after = Date.parse("2027-01-01T00:05:00+02:00");
		const result = text(accept([user(before), user(after)]));
		expect(result).toContain("previous user: Dec 31 20:00");
		expect(result).toContain("current user: Jan 1 00:05");
		expect(result).not.toMatch(/2026|2027|UTC|timezone/);
	});

	test("quoted literal markers remain user text and do not suppress timing", () => {
		for (const literal of [
			'Please explain "<harness_timing>".',
			'```xml\n<harness_timing>\nprevious user: example\n</harness_timing>\n```',
			'> <harness_timing>\n> previous user: example\n> </harness_timing>',
		]) {
			const result = text(accept([user(START), user(START + 4 * HOUR, literal)]));
			expect(result).toStartWith("<harness_timing>\nprevious user: Oct 8 09:15\ncurrent user: Oct 8 13:15\n</harness_timing>\n\n");
			expect(result.endsWith(literal)).toBe(true);
		}
	});

	test("interactive terminal and extension phone input share the persisted envelope", async () => {
		const loader = new URL("./core/extensions/loader.js", import.meta.resolve("@earendil-works/pi-coding-agent"));
		const { loadExtensions } = await import(loader.href);
		const loaded = await loadExtensions([join(import.meta.dir, "index.ts")], import.meta.dir);
		expect(loaded.errors).toEqual([]);
		for (const source of ["interactive", "extension"] as const) {
			const manager = SessionManager.inMemory();
			manager.appendMessage((user(START) as any).message);
			const runner = new ExtensionRunner(loaded.extensions, loaded.runtime, import.meta.dir, manager, {} as any);
			// This is Pi's input boundary; timing intentionally does not transform it.
			expect(await runner.emitInput("Continue.", undefined, source)).toEqual({ action: "continue" });
			const incoming = (user(START + 4 * HOUR) as any).message;
			const before = JSON.stringify(incoming);
			const replacement = await runner.emitMessageEnd({ type: "message_end", message: incoming });
			expect(text(replacement!)).toBe("<harness_timing>\nprevious user: Oct 8 09:15\ncurrent user: Oct 8 13:15\n</harness_timing>\n\nContinue.");
			expect(JSON.stringify(incoming)).toBe(before);
			const id = manager.appendMessage(replacement!);
			expect((manager.getEntry(id) as any).message).toEqual(replacement);
			expect(await runner.emitMessageEnd({ type: "message_end", message: replacement! })).toBeUndefined();
			expect(runner.hasHandlers("context")).toBe(false);
			expect(runner.hasHandlers("context_with_system")).toBe(false);
		}
	});

	test("Pi loader persists the replacement in JSONL and replays it through reload, branches and compaction", async () => {
		const loader = new URL("./core/extensions/loader.js", import.meta.resolve("@earendil-works/pi-coding-agent"));
		const { loadExtensions } = await import(loader.href);
		const loaded = await loadExtensions([join(import.meta.dir, "index.ts")], import.meta.dir);
		expect(loaded.errors).toEqual([]);
		expect(loaded.extensions).toHaveLength(1);
		const dir = mkdtempSync(join(homedir(), "tmp", "harness-timing-test-"));
		try {
			const manager = SessionManager.create(dir, dir);
			const now = Date.now();
			const oldUserId = manager.appendMessage((user(now - 2 * HOUR) as any).message);
			manager.appendMessage((assistant(now, "stop", now - 2 * HOUR) as any).message);
			const runner = new ExtensionRunner(loaded.extensions, loaded.runtime, dir, manager, {} as any);
			const errors: any[] = [];
			runner.onError((error) => errors.push(error));
			expect(runner.hasHandlers("context")).toBe(false);
			const incoming = (user(now + 60_000) as any).message;
			const replacement = await runner.emitMessageEnd({ type: "message_end", message: incoming });
			expect(replacement).toBeDefined();
			const newUserId = manager.appendMessage(replacement!);
			const file = manager.getSessionFile()!;
			const saved = readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line));
			expect(saved.find((entry) => entry.id === newUserId).message).toEqual(replacement);
			expect(text(replacement!)).toContain("agent finished:");
			const reopened = SessionManager.open(file, dir);
			expect(reopened.getEntry(newUserId)).toEqual(manager.getEntry(newUserId));
			const reloaded = new ExtensionRunner(loaded.extensions, loaded.runtime, dir, reopened, {} as any);
			const context = reopened.buildSessionContext().messages;
			expect(await reloaded.emitContext(context)).toEqual(context);
			expect(await reloaded.emitMessageEnd({ type: "message_end", message: replacement! })).toBeUndefined();
			expect(text((reopened.getEntry(oldUserId) as any).message)).toBe("Continue.");

			// Navigating away does not rewrite the saved tag, and abandoned users
			// cannot become the previous user for the new branch.
			reopened.branch(oldUserId);
			const branchMessage = (user(now + 2 * HOUR) as any).message;
			const branched = await reloaded.emitMessageEnd({ type: "message_end", message: branchMessage });
			expect(text(branched!)).toContain(`current user:`);
			expect(text(branched!)).not.toContain("agent finished:");
			expect(reopened.getEntry(newUserId)).toEqual(manager.getEntry(newUserId));

			reopened.branch(newUserId);
			reopened.appendCompaction("Summary.", newUserId, 100);
			expect(text(reopened.buildSessionContext().messages.at(-1)!)).toEqual(text(replacement!));
			const next = (user(now + 5 * HOUR) as any).message;
			const afterCompaction = await reloaded.emitMessageEnd({ type: "message_end", message: next });
			expect(text(afterCompaction!)).toContain("previous user:");
			expect(errors).toEqual([]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

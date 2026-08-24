import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import moveSessionExtension from "./index.ts";
import {
	CWD_CHANGE_MESSAGE_TYPE,
	prepareSessionMove,
	removeSourceIfUnchanged,
	replacementMatches,
	resolveTargetCwd,
} from "./move-session.ts";

function assistant(text: string) {
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text }],
		api: "openai-codex-responses" as const,
		provider: "codex-test",
		model: "gpt-test",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop" as const,
		timestamp: Date.now(),
	};
}

function persistedSession(cwd: string) {
	const manager = SessionManager.create(cwd);
	const firstUser = manager.appendMessage({ role: "user", content: "first", timestamp: Date.now() });
	const firstAssistant = manager.appendMessage(assistant("first answer"));
	manager.appendMessage({ role: "user", content: "abandoned branch", timestamp: Date.now() });
	manager.appendMessage(assistant("abandoned answer"));
	manager.branch(firstAssistant);
	return { manager, firstUser, firstAssistant };
}

function withAgentDir(run: (root: string, agentDir: string) => Promise<void> | void) {
	const root = mkdtempSync(join(tmpdir(), "pi-move-session-"));
	const agentDir = join(root, "agent");
	mkdirSync(agentDir, { recursive: true });
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	return Promise.resolve().then(() => run(root, agentDir)).finally(() => {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(root, { recursive: true, force: true });
	});
}

test("validates and canonicalizes an existing directory", async () => withAgentDir((root) => {
	const current = join(root, "current");
	const target = join(root, "target with spaces");
	mkdirSync(current);
	mkdirSync(target);
	assert.equal(resolveTargetCwd('"../target with spaces"', current), realpathSync.native(target));
	const file = join(root, "file");
	writeFileSync(file, "x");
	assert.throws(() => resolveTargetCwd(file, current), /Not a directory/);
	assert.throws(() => resolveTargetCwd("missing", current), /does not exist/);
}));

test("prepares a verified target session and anchors the hidden notice to the active leaf", async () => withAgentDir((root) => {
	const sourceCwd = join(root, "wiki");
	const targetCwd = join(root, "project");
	mkdirSync(sourceCwd);
	mkdirSync(targetCwd);
	const { manager, firstAssistant } = persistedSession(sourceCwd);
	const sourcePath = manager.getSessionFile()!;
	const sourceEntries = manager.getEntries().length;

	const move = prepareSessionMove(manager, targetCwd);
	assert.equal(existsSync(sourcePath), true);
	assert.equal(dirname(move.destinationPath), SessionManager.create(realpathSync.native(targetCwd)).getSessionDir());
	const moved = SessionManager.open(move.destinationPath);
	assert.equal(moved.getSessionId(), manager.getSessionId());
	assert.equal(moved.getCwd(), realpathSync.native(targetCwd));
	assert.equal(moved.getEntries().length, sourceEntries + 1);
	const notice = moved.getLeafEntry();
	assert.equal(notice?.type, "custom_message");
	if (notice?.type !== "custom_message") throw new Error("missing notice");
	assert.equal(notice.customType, CWD_CHANGE_MESSAGE_TYPE);
	assert.equal(notice.display, false);
	assert.equal(notice.parentId, firstAssistant);
	assert.match(String(notice.content), new RegExp(targetCwd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	assert.equal(removeSourceIfUnchanged(move), true);
	assert.equal(existsSync(sourcePath), false);
}));

test("repairs a session whose header cwd and physical storage directory disagree", async () => withAgentDir((root) => {
	const targetCwd = join(root, "wiki");
	const misplacedCwd = join(targetCwd, "wiki");
	mkdirSync(misplacedCwd, { recursive: true });
	const canonicalTargetCwd = realpathSync.native(targetCwd);
	const { manager } = persistedSession(canonicalTargetCwd);
	const originalPath = manager.getSessionFile()!;
	const sourceEntries = manager.getEntries().length;
	const misplacedDirectory = SessionManager.create(misplacedCwd).getSessionDir();
	const misplacedPath = join(misplacedDirectory, basename(originalPath));
	renameSync(originalPath, misplacedPath);

	const misplaced = SessionManager.open(misplacedPath);
	const sourceLeafId = misplaced.getLeafId();
	assert.equal(realpathSync.native(misplaced.getCwd()), canonicalTargetCwd);
	const move = prepareSessionMove(misplaced, canonicalTargetCwd);
	assert.equal(dirname(move.destinationPath), SessionManager.create(canonicalTargetCwd).getSessionDir());

	const repaired = SessionManager.open(move.destinationPath);
	assert.equal(repaired.getEntries().length, sourceEntries + 1);
	assert.equal(repaired.getLeafId(), move.noticeEntryId);
	const notice = repaired.getLeafEntry();
	assert.equal(notice?.type, "custom_message");
	if (notice?.type !== "custom_message") throw new Error("missing storage repair notice");
	assert.equal(notice.customType, CWD_CHANGE_MESSAGE_TYPE);
	assert.equal(notice.display, false);
	assert.equal(notice.parentId, sourceLeafId);
	assert.equal((notice.details as { storageRepair?: boolean })?.storageRepair, true);
	assert.match(String(notice.content), /Session-storage update/);
	assert.match(String(notice.content), /working directory remains/);
	assert.equal(replacementMatches(move, repaired), true);
	assert.equal(removeSourceIfUnchanged(move), true);
	assert.equal(existsSync(misplacedPath), false);
}));

test("still rejects a no-op when cwd and storage directory already match", async () => withAgentDir((root) => {
	const cwd = join(root, "wiki");
	mkdirSync(cwd);
	const canonicalCwd = realpathSync.native(cwd);
	const { manager } = persistedSession(canonicalCwd);
	assert.throws(
		() => prepareSessionMove(manager, canonicalCwd),
		/Session already uses cwd and storage directory/,
	);
}));

test("encoded-directory collisions use a new conventional filename without overwriting the source", async () => withAgentDir((root) => {
	const sourceCwd = join(root, "a-b", "c");
	const targetCwd = join(root, "a", "b-c");
	mkdirSync(sourceCwd, { recursive: true });
	mkdirSync(targetCwd, { recursive: true });
	const { manager } = persistedSession(realpathSync.native(sourceCwd));
	const sourcePath = manager.getSessionFile()!;
	const move = prepareSessionMove(manager, targetCwd);
	assert.equal(dirname(move.destinationPath), dirname(sourcePath));
	assert.notEqual(move.destinationPath, sourcePath);
	assert.equal(existsSync(sourcePath), true);
	assert.equal(existsSync(move.destinationPath), true);
}));

test("command switches to the relocated session and removes only the old JSONL", async () => withAgentDir(async (root) => {
	const sourceCwd = join(root, "wiki");
	const targetCwd = join(root, "project");
	mkdirSync(sourceCwd);
	mkdirSync(targetCwd);
	const { manager } = persistedSession(sourceCwd);
	const sourcePath = manager.getSessionFile()!;
	let command: any;
	const pi: any = { registerCommand(_name: string, value: unknown) { command = value; } };
	moveSessionExtension(pi);
	const notifications: Array<{ message: string; level: string }> = [];
	let switchedPath: string | undefined;
	const ctx: any = {
		sessionManager: manager,
		ui: { notify(message: string, level: string) { notifications.push({ message, level }); } },
		async waitForIdle() {},
		async switchSession(path: string, options: any) {
			switchedPath = path;
			const reopened = SessionManager.open(path);
			await options.withSession({
				sessionManager: reopened,
				ui: { notify(message: string, level: string) { notifications.push({ message, level }); } },
			});
			return { cancelled: false };
		},
	};

	await command.handler(targetCwd, ctx);
	assert.ok(switchedPath);
	assert.equal(existsSync(switchedPath!), true);
	assert.equal(existsSync(sourcePath), false);
	const canonicalTarget = realpathSync.native(targetCwd);
	assert.equal(SessionManager.open(switchedPath!).getCwd(), canonicalTarget);
	assert.deepEqual(readdirSync(targetCwd), []);
	assert.deepEqual(notifications.at(-1), { message: `Session moved to ${canonicalTarget}.`, level: "info" });
}));

test("canceled switching removes the prepared copy and leaves the source untouched", async () => withAgentDir(async (root) => {
	const sourceCwd = join(root, "wiki");
	const targetCwd = join(root, "project");
	mkdirSync(sourceCwd);
	mkdirSync(targetCwd);
	const { manager } = persistedSession(sourceCwd);
	const sourcePath = manager.getSessionFile()!;
	let command: any;
	const pi: any = { registerCommand(_name: string, value: unknown) { command = value; } };
	moveSessionExtension(pi);
	const notifications: string[] = [];
	const ctx: any = {
		sessionManager: manager,
		ui: { notify(message: string) { notifications.push(message); } },
		async waitForIdle() {},
		async switchSession() { return { cancelled: true }; },
	};

	await command.handler(targetCwd, ctx);
	assert.equal(existsSync(sourcePath), true);
	const targetSessionRoot = SessionManager.create(targetCwd).getSessionDir();
	assert.deepEqual(readdirSync(targetSessionRoot).filter((name) => name.endsWith(".jsonl")), []);
	assert.equal(notifications.at(-1), "Session move canceled.");
}));

test("a concurrently changed source is retained after the runtime switches", async () => withAgentDir(async (root) => {
	const sourceCwd = join(root, "wiki");
	const targetCwd = join(root, "project");
	mkdirSync(sourceCwd);
	mkdirSync(targetCwd);
	const { manager } = persistedSession(sourceCwd);
	const sourcePath = manager.getSessionFile()!;
	let command: any;
	const pi: any = { registerCommand(_name: string, value: unknown) { command = value; } };
	moveSessionExtension(pi);
	const notifications: Array<{ message: string; level: string }> = [];
	const ctx: any = {
		sessionManager: manager,
		ui: { notify(message: string, level: string) { notifications.push({ message, level }); } },
		async waitForIdle() {},
		async switchSession(path: string, options: any) {
			appendFileSync(sourcePath, "\n");
			await options.withSession({
				sessionManager: SessionManager.open(path),
				ui: { notify(message: string, level: string) { notifications.push({ message, level }); } },
			});
			return { cancelled: false };
		},
	};

	await command.handler(targetCwd, ctx);
	assert.equal(existsSync(sourcePath), true);
	assert.equal(notifications.at(-1)?.level, "warning");
	assert.match(notifications.at(-1)?.message ?? "", /old JSONL was kept/);
}));

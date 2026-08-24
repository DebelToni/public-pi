import { SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
	insertionArguments,
	parseTmuxWindow,
	parseTmuxWindowIds,
	piLaunchCommand,
	prepareForkSession,
	type ForkSessionCopy,
} from "./fork-tmux.js";

type Dependencies = {
	openSession(path: string, sessionDir: string): ForkSessionCopy;
	fileExists(path: string): boolean;
	removeFile(path: string): void;
	createPromptFile(prompt: string): string;
	readPromptFile(path: string): string;
	isPromptFile(path: string): boolean;
	schedulePromptCleanup(path: string): void;
	runTmux(args: string[]): string;
	piPath: string;
	tmuxPane(): string | undefined;
};

const DEFAULT_DEPENDENCIES: Dependencies = {
	openSession: (path, sessionDir) => SessionManager.open(path, sessionDir),
	fileExists: existsSync,
	removeFile: unlinkSync,
	createPromptFile: (prompt) => {
		const path = join(tmpdir(), `pi-fork-tmux-${process.pid}-${randomUUID()}.md`);
		writeFileSync(path, prompt, { encoding: "utf8", mode: 0o600, flag: "wx" });
		return path;
	},
	readPromptFile: (path) => readFileSync(path, "utf8"),
	isPromptFile: (path) => {
		if (dirname(path) !== tmpdir() || !/^pi-fork-tmux-\d+-[0-9a-f-]+\.md$/.test(basename(path))) return false;
		try {
			const stat = lstatSync(path);
			return stat.isFile() && (typeof process.getuid !== "function" || stat.uid === process.getuid());
		} catch {
			return false;
		}
	},
	schedulePromptCleanup: (path) => {
		const cleanup = spawn("/bin/sh", ["-c", "/bin/sleep 600; /bin/rm -f \"$1\"", "pi-fork-clean", path], {
			detached: true,
			stdio: "ignore",
		});
		cleanup.on("error", () => {});
		cleanup.unref();
	},
	runTmux: (args) => execFileSync("tmux", args, {
		encoding: "utf8",
		env: process.env,
		stdio: ["ignore", "pipe", "pipe"],
	}).trim(),
	piPath: process.env.PI_FORK_TMUX_LAUNCHER
		?? process.argv[1]
		?? join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "bin", "pi"),
	tmuxPane: () => process.env.TMUX && process.env.TMUX_PANE ? process.env.TMUX_PANE : undefined,
};

function errorText(error: unknown) {
	if (error && typeof error === "object" && "stderr" in error) {
		const stderr = String((error as { stderr?: unknown }).stderr ?? "").trim();
		if (stderr) return stderr;
	}
	return error instanceof Error ? error.message : String(error);
}

export function installForkTmux(pi: ExtensionAPI, overrides: Partial<Dependencies> = {}) {
	const dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides };
	pi.registerFlag("fork-tmux-prompt-file", {
		description: "Internal prompt handoff for /fork-tmux",
		type: "string",
	});
	let launchTimer: NodeJS.Timeout | undefined;
	let launchedPromptFile: string | undefined;
	let launchedPromptText: string | undefined;
	let wirePromptText: string | undefined;
	let launchInputAccepted = false;

	pi.on("session_start", (_event, ctx) => {
		const flag = pi.getFlag("fork-tmux-prompt-file");
		if (typeof flag !== "string" || !dependencies.isPromptFile(flag)) return;
		launchedPromptFile = flag;
		launchTimer = setTimeout(() => {
			launchTimer = undefined;
			try {
				launchedPromptText = dependencies.readPromptFile(flag);
				wirePromptText = `\u2063pi-fork-tmux:${basename(flag)}\u2063${launchedPromptText}`;
				pi.sendUserMessage(wirePromptText);
			} catch (error) {
				ctx.ui.notify(`Could not submit the forked message: ${errorText(error)}`, "error");
			}
		}, 0);
	});

	pi.on("input", (event) => {
		if (!wirePromptText || !launchedPromptText || event.source !== "extension" || event.text !== wirePromptText) return;
		launchInputAccepted = true;
		return { action: "transform", text: launchedPromptText };
	});

	pi.on("message_end", (event) => {
		if (!launchInputAccepted || !launchedPromptText || !launchedPromptFile || event.message.role !== "user") return;
		const text = typeof event.message.content === "string"
			? event.message.content
			: event.message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
		if (text !== launchedPromptText) return;
		try { dependencies.removeFile(launchedPromptFile); } catch {}
		launchedPromptFile = undefined;
		launchedPromptText = undefined;
		wirePromptText = undefined;
		launchInputAccepted = false;
	});

	pi.on("session_shutdown", () => {
		if (launchTimer) clearTimeout(launchTimer);
		launchTimer = undefined;
	});

	pi.registerCommand("fork-tmux", {
		description: "Fork the current conversation into the next tmux window and submit a message",
		handler: async (args, ctx) => {
			if (!args.trim()) {
				ctx.ui.notify("Usage: /fork-tmux <message>", "warning");
				return;
			}
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/fork-tmux is available only in interactive TUI mode.", "error");
				return;
			}
			const pane = dependencies.tmuxPane();
			if (!pane) {
				ctx.ui.notify("/fork-tmux requires Pi to be running inside tmux.", "error");
				return;
			}

			await ctx.waitForIdle();

			let current;
			try {
				current = parseTmuxWindow(dependencies.runTmux([
					"display-message",
					"-t",
					pane,
					"-p",
					"#{session_id}|#{window_id}|#{window_index}",
				]));
			} catch (error) {
				ctx.ui.notify(`Could not locate the current tmux window: ${errorText(error)}`, "error");
				return;
			}

			let existingWindows: Set<string>;
			try {
				existingWindows = parseTmuxWindowIds(dependencies.runTmux([
					"list-windows",
					"-a",
					"-F",
					"#{window_id}",
				]));
			} catch (error) {
				ctx.ui.notify(`Could not inspect the current tmux session: ${errorText(error)}`, "error");
				return;
			}

			if (!dependencies.fileExists(dependencies.piPath)) {
				ctx.ui.notify(`The Pi launcher is unavailable: ${dependencies.piPath}`, "error");
				return;
			}

			let fork;
			let promptFile: string | undefined;
			try {
				fork = prepareForkSession(ctx.sessionManager, dependencies.openSession, dependencies.fileExists);
				promptFile = dependencies.createPromptFile(args);
				dependencies.schedulePromptCleanup(promptFile);
			} catch (error) {
				if (fork) try { dependencies.removeFile(fork.forkFile); } catch {}
				if (promptFile) try { dependencies.removeFile(promptFile); } catch {}
				ctx.ui.notify(`Could not prepare the forked Pi session: ${errorText(error)}`, "error");
				return;
			}

			let launched: string;
			try {
				launched = dependencies.runTmux(insertionArguments(
					current,
					fork.cwd,
					piLaunchCommand(dependencies.piPath, fork.forkFile, promptFile),
				));
			} catch (error) {
				let noWindowCreated = false;
				try {
					const currentWindows = parseTmuxWindowIds(dependencies.runTmux([
						"list-windows", "-a", "-F", "#{window_id}",
					]));
					noWindowCreated = [...currentWindows].every((windowId) => existingWindows.has(windowId));
				} catch {}
				if (noWindowCreated) {
					try { dependencies.removeFile(fork.forkFile); } catch {}
					try { dependencies.removeFile(promptFile); } catch {}
				}
				ctx.ui.notify(
					noWindowCreated
						? `Could not create the forked tmux window: ${errorText(error)}`
						: `The tmux launch result was uncertain, so the forked session was preserved: ${errorText(error)}`,
					noWindowCreated ? "error" : "warning",
				);
				return;
			}

			try {
				const next = parseTmuxWindow(launched);
				if (next.sessionId !== current.sessionId || next.windowIndex !== current.windowIndex + 1) {
					ctx.ui.notify("The fork launched, but tmux did not place it immediately after the original window.", "warning");
				}
			} catch {
				ctx.ui.notify("The fork launched, but its tmux position could not be verified.", "warning");
			}
		},
	});
}

export default function forkTmux(pi: ExtensionAPI) {
	installForkTmux(pi);
}

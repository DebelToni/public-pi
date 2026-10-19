import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const runFile = promisify(execFile);

export async function copyViaClip(text: string, environment: NodeJS.ProcessEnv = process.env) {
	const bin = join(environment.HOME ?? homedir(), "bin");
	const env: NodeJS.ProcessEnv = { ...environment, PATH: `${bin}:${environment.PATH ?? "/usr/bin:/bin"}` };
	// A long-lived Pi can predate an SSH attachment. tmux updates its session
	// environment on attach, but cannot update the already-running Pi process.
	if (!env.SSH_CONNECTION && !env.SSH_CLIENT && !env.SSH_TTY && env.TMUX && env.TMUX_PANE) {
		try {
			const { stdout } = await runFile("tmux", ["show-environment", "-t", env.TMUX_PANE, "SSH_CONNECTION"], {
				env, timeout: 2000, maxBuffer: 4096,
			});
			const match = /^SSH_CONNECTION=([^\r\n]+)\r?\n?$/.exec(stdout);
			if (match) env.SSH_CONNECTION = match[1];
		} catch {
			// An unset tmux variable is normal for locally attached sessions.
		}
	}
	await new Promise<void>((resolve, reject) => {
		const child = execFile(join(bin, "clip"), [], { env, timeout: 5000, maxBuffer: 64 * 1024 }, (error) => {
			if (error) reject(new Error("clip failed; clipboard delivery was not confirmed."));
			else resolve();
		});
		// Handle early child exit (including a missing clip executable) without an
		// unhandled EPIPE. The execFile callback owns success/failure reporting.
		child.stdin?.on("error", () => {});
		child.stdin?.end(text);
	});
}

type CopyOptions = { preferSelection?: boolean; flashConfirmation?: boolean };
type CopyHost = {
	session: { getLastAssistantText(): string | undefined };
	ui: {
		getCopyOnSelect?(): boolean;
		hasActiveSelection?(): boolean;
		flash?(text: string): void;
	};
	showError(text: string): void;
	showStatus(text: string): void;
};
type CopyMethod = (this: CopyHost, options?: CopyOptions) => Promise<void>;

export function installClipCopy(prototype: { handleCopyCommand: CopyMethod }, copy = copyViaClip) {
	const original = prototype.handleCopyCommand;
	if (typeof original !== "function") throw new Error("Pi's copy handler is unavailable.");
	let copying = false;
	const replacement: CopyMethod = async function (options = {}) {
		// Preserve Pi's contextual fullscreen-selection behavior. Tree copying has
		// its own handler and is deliberately not intercepted.
		if (options.preferSelection && this.ui.getCopyOnSelect?.() === false && this.ui.hasActiveSelection?.()) {
			return original.call(this, options);
		}
		if (copying) return;
		const text = this.session.getLastAssistantText();
		if (!text) {
			this.showError("No agent messages to copy yet.");
			return;
		}
		copying = true;
		try {
			await copy(text);
			if (options.flashConfirmation && this.ui.flash) this.ui.flash("Copied via clip!");
			else this.showStatus("Copied last agent message via clip");
		} catch {
			this.showError("clip failed; clipboard delivery was not confirmed.");
		} finally {
			copying = false;
		}
	};
	prototype.handleCopyCommand = replacement;
	return () => {
		if (prototype.handleCopyCommand === replacement) prototype.handleCopyCommand = original;
	};
}

export default function (pi: ExtensionAPI) {
	let restore: (() => void) | undefined;
	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui" || restore) return;
		try {
			// Ctrl+X is reserved against registerShortcut overrides. Patch only the
			// existing last-message action, using this process's own Pi module.
			const module = await import(new URL("modes/interactive/interactive-mode.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href);
			restore = installClipCopy(module.InteractiveMode.prototype);
		} catch {
			ctx.ui.notify("clip-copy could not load; Pi's built-in clipboard handling is unchanged.", "warning");
		}
	});
	pi.on("session_shutdown", () => {
		restore?.();
		restore = undefined;
	});
}

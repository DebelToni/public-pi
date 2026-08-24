import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	chmodSync,
	closeSync,
	existsSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	unlinkSync,
	watch,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const CONFIG_PATH = join(homedir(), ".config", "pi-prompt-editor", "config.json");
const RUNTIME_ROOT = join(tmpdir(), `pi-prompt-editor-${typeof process.getuid === "function" ? process.getuid() : "user"}`);
const POLL_MS = 750;

type Config = { version: 1; enabled: boolean };
type Metadata = {
	version: 1;
	paneId: string;
	sourcePane: string;
	promptFile: string;
	lastAppliedHash: string;
};
type Watcher = { close(): void };
type Dependencies = {
	configPath: string;
	runtimeRoot: string;
	tmuxPane(): string | undefined;
	runTmux(args: string[]): Promise<string>;
	watchDirectory(path: string, onChange: () => void): Watcher;
	setInterval(callback: () => void, milliseconds: number): NodeJS.Timeout;
	clearInterval(timer: NodeJS.Timeout): void;
};
type ActiveEditor = {
	context: ExtensionContext;
	directory: string;
	promptFile: string;
	metadata: Metadata;
	watcher?: Watcher;
	timer?: NodeJS.Timeout;
	syncPromise?: Promise<void>;
	stopped: boolean;
	reportedSyncError: boolean;
	checkingPane: boolean;
	generation: number;
};

const DEFAULT_DEPENDENCIES: Dependencies = {
	configPath: CONFIG_PATH,
	runtimeRoot: RUNTIME_ROOT,
	tmuxPane: () => process.env.TMUX && process.env.TMUX_PANE ? process.env.TMUX_PANE : undefined,
	runTmux: async (args) => {
		const { stdout } = await execFileAsync("tmux", args, {
			encoding: "utf8",
			env: process.env,
			timeout: 5_000,
			maxBuffer: 64 * 1024,
		});
		return stdout.trim();
	},
	watchDirectory: (path, onChange) => watch(path, { persistent: false }, onChange),
	setInterval: (callback, milliseconds) => {
		const timer = setInterval(callback, milliseconds);
		timer.unref();
		return timer;
	},
	clearInterval,
};

function errorText(error: unknown) {
	if (error && typeof error === "object" && "stderr" in error) {
		const stderr = String((error as { stderr?: unknown }).stderr ?? "").trim();
		if (stderr) return stderr;
	}
	return error instanceof Error ? error.message : String(error);
}

function fsyncDirectory(path: string) {
	const descriptor = openSync(path, "r");
	try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

function ensurePrivateDirectory(path: string) {
	mkdirSync(path, { recursive: true, mode: 0o700 });
	const stat = lstatSync(path);
	if (!stat.isDirectory() || stat.isSymbolicLink() || (typeof process.getuid === "function" && stat.uid !== process.getuid())) {
		throw new Error(`Refusing unsafe Pi prompt editor directory: ${path}`);
	}
	chmodSync(path, 0o700);
}

function writePrivateJson(path: string, value: object) {
	const directory = dirname(path);
	ensurePrivateDirectory(directory);
	const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
	let descriptor: number | undefined;
	try {
		descriptor = openSync(temporary, "wx", 0o600);
		writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf8");
		fsyncSync(descriptor);
		closeSync(descriptor);
		descriptor = undefined;
		renameSync(temporary, path);
		chmodSync(path, 0o600);
		fsyncDirectory(directory);
	} finally {
		if (descriptor !== undefined) closeSync(descriptor);
		try { unlinkSync(temporary); } catch {}
	}
}

function readConfig(path: string): Config {
	if (!existsSync(path)) return { version: 1, enabled: true };
	const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<Config>;
	if (raw.version !== 1 || typeof raw.enabled !== "boolean" || Object.keys(raw).some((key) => key !== "version" && key !== "enabled")) {
		throw new Error("Pi prompt editor config is invalid.");
	}
	return raw as Config;
}

function shellQuote(value: string) {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

function promptText(raw: string) {
	if (raw.endsWith("\r\n")) return raw.slice(0, -2);
	if (raw.endsWith("\n")) return raw.slice(0, -1);
	return raw;
}

function contentHash(content: string) {
	return createHash("sha256").update(content).digest("hex");
}

function sessionDirectory(root: string, sessionId: string, sourcePane: string) {
	const key = createHash("sha256").update(sessionId).update("\0").update(sourcePane).digest("hex").slice(0, 24);
	return join(root, key);
}

function readMetadata(path: string): Metadata | undefined {
	if (!existsSync(path)) return undefined;
	try {
		const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<Metadata>;
		if (
			raw.version !== 1 ||
			typeof raw.paneId !== "string" || !/^%\d+$/.test(raw.paneId) ||
			typeof raw.sourcePane !== "string" || !/^%\d+$/.test(raw.sourcePane) ||
			typeof raw.promptFile !== "string" ||
			typeof raw.lastAppliedHash !== "string" || !/^[0-9a-f]{64}$/.test(raw.lastAppliedHash)
		) return undefined;
		return raw as Metadata;
	} catch {
		return undefined;
	}
}

function transientReadError(error: unknown) {
	return Boolean(error && typeof error === "object" && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT");
}

export class PiPromptEditorController {
	private active?: ActiveEditor;
	private opening?: Promise<void>;
	private generation = 0;

	constructor(private readonly dependencies: Dependencies = DEFAULT_DEPENDENCIES) {}

	beginSession() {
		return ++this.generation;
	}

	isActive() {
		return Boolean(this.active && !this.active.stopped);
	}

	async adopt(context: ExtensionContext, generation = this.generation) {
		if (generation !== this.generation || this.active) return;
		const sourcePane = this.dependencies.tmuxPane();
		if (!sourcePane) return;
		const directory = sessionDirectory(this.dependencies.runtimeRoot, context.sessionManager.getSessionId(), sourcePane);
		const promptFile = join(directory, "prompt.md");
		const metadata = readMetadata(join(directory, "state.json"));
		if (!metadata || metadata.sourcePane !== sourcePane || metadata.promptFile !== promptFile) return;

		const paneAlive = await this.paneExists(metadata.paneId);
		if (generation !== this.generation) return;
		if (!paneAlive) {
			await this.applySavedContent(context, directory, promptFile, metadata, generation);
			if (generation === this.generation) rmSync(directory, { recursive: true, force: true });
			return;
		}
		this.startWatching(context, directory, promptFile, metadata, generation);
		await this.syncFromDisk(this.active!);
	}

	async open(context: ExtensionContext) {
		if (this.opening) return this.opening;
		const generation = this.generation;
		this.opening = this.openInternal(context, generation).finally(() => { this.opening = undefined; });
		return this.opening;
	}

	detach() {
		this.generation++;
		if (!this.active) return;
		this.stopWatching(this.active);
		this.active = undefined;
	}

	private async openInternal(context: ExtensionContext, generation: number) {
		if (generation !== this.generation) return;
		if (this.active && await this.paneExists(this.active.metadata.paneId)) {
			try {
				await this.dependencies.runTmux(["select-pane", "-t", this.active.metadata.paneId]);
				return;
			} catch {
				await this.finish(this.active);
			}
		}
		if (this.active) await this.finish(this.active);
		if (generation !== this.generation) return;

		const sourcePane = this.dependencies.tmuxPane();
		if (!sourcePane) {
			context.ui.notify("Pi prompt editor requires Pi to be running inside tmux.", "error");
			return;
		}
		const directory = sessionDirectory(this.dependencies.runtimeRoot, context.sessionManager.getSessionId(), sourcePane);
		const promptFile = join(directory, "prompt.md");
		const existing = readMetadata(join(directory, "state.json"));
		if (existing && existing.sourcePane === sourcePane && existing.promptFile === promptFile && await this.paneExists(existing.paneId)) {
			if (generation !== this.generation) return;
			this.startWatching(context, directory, promptFile, existing, generation);
			await this.syncFromDisk(this.active!);
			try {
				await this.dependencies.runTmux(["select-pane", "-t", existing.paneId]);
				return;
			} catch {
				await this.finish(this.active!);
			}
		}

		ensurePrivateDirectory(this.dependencies.runtimeRoot);
		rmSync(directory, { recursive: true, force: true });
		ensurePrivateDirectory(directory);
		const currentText = context.ui.getEditorText();
		writeFileSync(promptFile, currentText, { encoding: "utf8", flag: "wx", mode: 0o600 });
		fsyncDirectory(directory);

		let paneId: string | undefined;
		try {
			const command = `exec env PI_PROMPT_EDITOR=1 nvim -- ${shellQuote(promptFile)}`;
			paneId = await this.dependencies.runTmux([
				"split-window", "-h", "-p", "50", "-t", sourcePane,
				"-c", context.cwd, "-P", "-F", "#{pane_id}", command,
			]);
			if (!/^%\d+$/.test(paneId)) throw new Error("tmux returned an invalid pane identifier");
			await this.dependencies.runTmux(["set-option", "-p", "-t", paneId, "remain-on-exit", "off"]);
			const metadata: Metadata = {
				version: 1,
				paneId,
				sourcePane,
				promptFile,
				lastAppliedHash: contentHash(currentText),
			};
			writePrivateJson(join(directory, "state.json"), metadata);
			if (generation === this.generation) this.startWatching(context, directory, promptFile, metadata, generation);
		} catch (error) {
			if (paneId && /^%\d+$/.test(paneId)) {
				try { await this.dependencies.runTmux(["kill-pane", "-t", paneId]); } catch {}
			}
			rmSync(directory, { recursive: true, force: true });
			if (generation === this.generation) context.ui.notify(`Could not open Pi prompt editor: ${errorText(error)}`, "error");
		}
	}

	private startWatching(context: ExtensionContext, directory: string, promptFile: string, metadata: Metadata, generation: number) {
		const active: ActiveEditor = {
			context,
			directory,
			promptFile,
			metadata,
			stopped: false,
			reportedSyncError: false,
			checkingPane: false,
			generation,
		};
		try { active.watcher = this.dependencies.watchDirectory(directory, () => void this.syncFromDisk(active)); } catch {}
		active.timer = this.dependencies.setInterval(() => void this.poll(active), POLL_MS);
		this.active = active;
	}

	private syncFromDisk(active: ActiveEditor) {
		if (active.stopped || this.active !== active || active.generation !== this.generation) return Promise.resolve();
		if (active.syncPromise) return active.syncPromise;
		active.syncPromise = this.applySavedContent(
			active.context,
			active.directory,
			active.promptFile,
			active.metadata,
			active.generation,
		).then(() => { active.reportedSyncError = false; }).catch((error) => {
			if (transientReadError(error)) return;
			if (!active.stopped && !active.reportedSyncError && active.generation === this.generation) {
				active.reportedSyncError = true;
				active.context.ui.notify(`Pi prompt editor could not apply a save: ${errorText(error)}`, "error");
			}
		}).finally(() => { active.syncPromise = undefined; });
		return active.syncPromise;
	}

	private async applySavedContent(
		context: ExtensionContext,
		directory: string,
		promptFile: string,
		metadata: Metadata,
		generation: number,
	) {
		const content = promptText(readFileSync(promptFile, "utf8"));
		const hash = contentHash(content);
		if (hash === metadata.lastAppliedHash || generation !== this.generation) return;
		context.ui.setEditorText(content);
		metadata.lastAppliedHash = hash;
		writePrivateJson(join(directory, "state.json"), metadata);
	}

	private async poll(active: ActiveEditor) {
		if (active.stopped || this.active !== active || active.generation !== this.generation) return;
		await this.syncFromDisk(active);
		if (active.checkingPane) return;
		active.checkingPane = true;
		try {
			if (!(await this.paneExists(active.metadata.paneId))) await this.finish(active);
		} finally {
			active.checkingPane = false;
		}
	}

	private async paneExists(paneId: string) {
		try {
			return await this.dependencies.runTmux(["display-message", "-p", "-t", paneId, "#{pane_id}"]) === paneId;
		} catch {
			return false;
		}
	}

	private async finish(active: ActiveEditor) {
		if (active.stopped) return;
		await this.syncFromDisk(active);
		await this.syncFromDisk(active);
		this.stopWatching(active);
		if (this.active === active) this.active = undefined;
		rmSync(active.directory, { recursive: true, force: true });
	}

	private stopWatching(active: ActiveEditor) {
		active.stopped = true;
		try { active.watcher?.close(); } catch {}
		if (active.timer) this.dependencies.clearInterval(active.timer);
		active.watcher = undefined;
		active.timer = undefined;
	}
}

export function installPiPromptEditor(pi: ExtensionAPI, overrides: Partial<Dependencies> = {}) {
	const dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides };
	const controller = new PiPromptEditorController(dependencies);
	let adoptionTimer: NodeJS.Timeout | undefined;

	pi.registerShortcut("ctrl+g", {
		description: "Open the current prompt in a right-side Neovim pane",
		handler: (context) => {
			let enabled: boolean;
			try { enabled = readConfig(dependencies.configPath).enabled; }
			catch (error) { context.ui.notify(errorText(error), "error"); return; }
			if (!enabled) {
				context.ui.notify("Pi prompt editor is off. Run /prompt-editor on to enable it.", "warning");
				return;
			}
			void controller.open(context).catch((error) => {
				context.ui.notify(`Could not open Pi prompt editor: ${errorText(error)}`, "error");
			});
		},
	});

	pi.registerCommand("prompt-editor", {
		description: "Enable, disable, or inspect the Pi Neovim prompt editor",
		handler: async (args, context) => {
			const action = args.trim().toLowerCase() || "status";
			if (action === "on" || action === "off") {
				const enabled = action === "on";
				writePrivateJson(dependencies.configPath, { version: 1, enabled } satisfies Config);
				context.ui.notify(`Pi prompt editor ${enabled ? "enabled" : "disabled"}.`, enabled ? "info" : "warning");
				return;
			}
			if (action !== "status") {
				context.ui.notify("Usage: /prompt-editor on|off|status", "warning");
				return;
			}
			try {
				const config = readConfig(dependencies.configPath);
				context.ui.notify(`Pi prompt editor is ${config.enabled ? "on" : "off"}; pane ${controller.isActive() ? "active" : "inactive"}.`, "info");
			} catch (error) {
				context.ui.notify(errorText(error), "error");
			}
		},
	});

	pi.on("session_start", (_event, context) => {
		if (adoptionTimer) clearTimeout(adoptionTimer);
		const generation = controller.beginSession();
		adoptionTimer = setTimeout(() => {
			adoptionTimer = undefined;
			void controller.adopt(context, generation);
		}, 0);
	});
	pi.on("session_shutdown", () => {
		if (adoptionTimer) clearTimeout(adoptionTimer);
		adoptionTimer = undefined;
		controller.detach();
	});

	return controller;
}

export default function piPromptEditor(pi: ExtensionAPI) {
	installPiPromptEditor(pi);
}

import { createHash, randomUUID } from "node:crypto";
import {
	chmodSync,
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	readdirSync,
	renameSync,
	statSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { DraftTabsSnapshot } from "./tabbed-editor.ts";

export const DURABLE_PROMPT_TABS_VERSION = 1;

export type DurablePromptTabsState = {
	version: typeof DURABLE_PROMPT_TABS_VERSION;
	recordId: string;
	sessionId: string;
	sessionFile: string;
	updatedAt: number;
	selectedIndex: number;
	tabs: Array<{ text: string }>;
};

export type DurablePromptTabsLoadResult = {
	snapshot?: DraftTabsSnapshot;
	diagnostics: string[];
};

export type AtomicWriteHooks = {
	beforeRename?: () => void;
};

type Candidate = {
	state: DurablePromptTabsState;
	match: "exact" | "moved" | "different";
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validRecordId(value: unknown): value is string {
	return typeof value === "string"
		&& /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function validState(value: unknown, sessionId: string, fileName: string): value is DurablePromptTabsState {
	if (!isRecord(value)
		|| value.version !== DURABLE_PROMPT_TABS_VERSION
		|| !validRecordId(value.recordId)
		|| fileName !== `${value.recordId}.json`
		|| value.sessionId !== sessionId
		|| typeof value.sessionFile !== "string"
		|| typeof value.updatedAt !== "number"
		|| !Number.isFinite(value.updatedAt)
		|| typeof value.selectedIndex !== "number"
		|| !Number.isInteger(value.selectedIndex)
		|| !Array.isArray(value.tabs)
		|| value.tabs.length === 0
		|| !value.tabs.every((tab) => isRecord(tab) && typeof tab.text === "string")) {
		return false;
	}
	return value.selectedIndex >= 0 && value.selectedIndex < value.tabs.length;
}

function validSnapshot(snapshot: DraftTabsSnapshot) {
	return Array.isArray(snapshot.texts)
		&& snapshot.texts.length > 0
		&& snapshot.texts.every((text) => typeof text === "string")
		&& Number.isInteger(snapshot.activeIndex)
		&& snapshot.activeIndex >= 0
		&& snapshot.activeIndex < snapshot.texts.length;
}

function ensurePrivateDirectory(path: string) {
	const created = !existsSync(path);
	mkdirSync(path, { recursive: true, mode: 0o700 });
	chmodSync(path, 0o700);
	return created;
}

function fsyncDirectory(path: string) {
	const fd = openSync(path, "r");
	try {
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}

function writeAll(fd: number, data: Buffer) {
	let offset = 0;
	while (offset < data.length) {
		const written = writeSync(fd, data, offset, data.length - offset);
		if (written <= 0) throw new Error("Short write while persisting prompt tabs.");
		offset += written;
	}
}

export function atomicWritePromptTabsState(
	path: string,
	state: DurablePromptTabsState,
	hooks: AtomicWriteHooks = {},
) {
	const directory = dirname(path);
	const temporary = join(directory, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
	const data = Buffer.from(`${JSON.stringify(state)}\n`, "utf8");
	let fd: number | undefined;
	try {
		fd = openSync(temporary, "wx", 0o600);
		writeAll(fd, data);
		fsyncSync(fd);
		closeSync(fd);
		fd = undefined;
		hooks.beforeRename?.();
		renameSync(temporary, path);
		chmodSync(path, 0o600);
		fsyncDirectory(directory);
	} catch (error) {
		if (fd !== undefined) {
			try {
				closeSync(fd);
			} catch {
				// Preserve the original persistence failure.
			}
		}
		try {
			unlinkSync(temporary);
		} catch {
			// The temporary file may not exist or may already have been renamed.
		}
		throw error;
	}
}

function classifySessionFile(storedPath: string, currentPath: string): Candidate["match"] {
	const stored = resolve(storedPath);
	const current = resolve(currentPath);
	if (stored === current) return "exact";
	let currentStat;
	try {
		currentStat = statSync(current);
	} catch {
		return "different";
	}
	try {
		const storedStat = statSync(stored);
		return storedStat.dev === currentStat.dev && storedStat.ino === currentStat.ino ? "exact" : "different";
	} catch (error) {
		// A moved session has a live destination and a vanished source. A copied
		// duplicate keeps the source alive and therefore fails closed.
		return (error as NodeJS.ErrnoException).code === "ENOENT" ? "moved" : "different";
	}
}

function newestCandidate(left: Candidate, right: Candidate) {
	return right.state.updatedAt - left.state.updatedAt || left.state.recordId.localeCompare(right.state.recordId);
}

export function promptTabsRoot() {
	return join(getAgentDir(), "prompt-tabs");
}

export class DurablePromptTabsStore {
	private readonly sessionId: string;
	private readonly sessionFile: string;
	private readonly root: string;
	private readonly directory: string;
	private recordId: string | undefined;

	constructor(sessionId: string, sessionFile: string, root = promptTabsRoot()) {
		this.sessionId = sessionId;
		this.sessionFile = resolve(sessionFile);
		this.root = root;
		this.directory = join(root, createHash("sha256").update(sessionId).digest("hex"));
	}

	load(): DurablePromptTabsLoadResult {
		if (!existsSync(this.directory)) return { diagnostics: [] };
		const diagnostics: string[] = [];
		const candidates: Candidate[] = [];
		let malformed = 0;
		for (const name of readdirSync(this.directory)) {
			if (!name.endsWith(".json")) continue;
			const path = join(this.directory, name);
			let parsed: unknown;
			try {
				parsed = JSON.parse(readFileSync(path, "utf8"));
			} catch {
				malformed++;
				continue;
			}
			if (!validState(parsed, this.sessionId, name)) {
				malformed++;
				continue;
			}
			candidates.push({
				state: parsed,
				match: classifySessionFile(parsed.sessionFile, this.sessionFile),
			});
		}
		if (malformed > 0) {
			diagnostics.push(`Retained ${malformed} malformed prompt-tab state record${malformed === 1 ? "" : "s"}.`);
		}

		const exact = candidates.filter((candidate) => candidate.match === "exact").sort(newestCandidate);
		let selected = exact[0];
		if (exact.length > 1) {
			diagnostics.push(`Found ${exact.length} prompt-tab records for this session file; restored the newest.`);
		}
		if (!selected) {
			const moved = candidates.filter((candidate) => candidate.match === "moved").sort(newestCandidate);
			if (moved.length === 1) selected = moved[0];
			else if (moved.length > 1) {
				diagnostics.push("Prompt-tab state was not restored because multiple vanished source paths matched this moved session.");
			}
		}
		if (!selected) return { diagnostics };

		this.recordId = selected.state.recordId;
		return {
			snapshot: {
				texts: selected.state.tabs.map((tab) => tab.text),
				activeIndex: selected.state.selectedIndex,
			},
			diagnostics,
		};
	}

	discard() {
		if (!this.recordId) return;
		const path = join(this.directory, `${this.recordId}.json`);
		try {
			unlinkSync(path);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}

	save(snapshot: DraftTabsSnapshot) {
		if (!validSnapshot(snapshot)) throw new Error("Refusing to persist an invalid prompt-tab snapshot.");
		const rootCreated = ensurePrivateDirectory(this.root);
		if (rootCreated) fsyncDirectory(dirname(this.root));
		const directoryCreated = ensurePrivateDirectory(this.directory);
		if (directoryCreated) fsyncDirectory(this.root);
		this.recordId ??= randomUUID();
		const state: DurablePromptTabsState = {
			version: DURABLE_PROMPT_TABS_VERSION,
			recordId: this.recordId,
			sessionId: this.sessionId,
			sessionFile: this.sessionFile,
			updatedAt: Date.now(),
			selectedIndex: snapshot.activeIndex,
			tabs: snapshot.texts.map((text) => ({ text })),
		};
		atomicWritePromptTabsState(join(this.directory, `${this.recordId}.json`), state);
	}
}

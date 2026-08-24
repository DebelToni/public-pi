export const FAST_MODE_ENTRY_TYPE = "openai-plus-fast-mode";
export const FAST_MODE_CHANGED_CHANNEL = "openai-plus:fast-mode-changed";
export const FAST_MODE_USAGE = "Usage: /fast on|off|status | /fast global on|off|status | /fast inherit";

export type FastSessionMode = "on" | "off" | "inherit";

export type FastSessionState = {
	version: 1;
	mode: FastSessionMode;
	updatedAt: number;
};

export type FastModeState = {
	sessionMode: FastSessionMode;
	globalDefault: boolean;
	effective: boolean;
};

export type FastCommand =
	| { scope: "session"; action: "on" | "off" | "status" | "inherit" }
	| { scope: "global"; action: "on" | "off" | "status" };

type EntryLike = {
	type?: unknown;
	customType?: unknown;
	data?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseSessionState(value: unknown): FastSessionState | undefined {
	if (!isRecord(value) || value.version !== 1) return undefined;
	if (value.mode !== "on" && value.mode !== "off" && value.mode !== "inherit") return undefined;
	if (typeof value.updatedAt !== "number" || !Number.isFinite(value.updatedAt)) return undefined;
	return value as FastSessionState;
}

/** Resolve the latest valid setting across the whole session file, independent of the active branch. */
export function getFastSessionMode(entries: readonly unknown[]): FastSessionMode {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index] as EntryLike | undefined;
		if (entry?.type !== "custom" || entry.customType !== FAST_MODE_ENTRY_TYPE) continue;
		const state = parseSessionState(entry.data);
		if (state) return state.mode;
	}
	return "inherit";
}

export function resolveFastMode(entries: readonly unknown[], globalDefault: boolean): FastModeState {
	const sessionMode = getFastSessionMode(entries);
	return {
		sessionMode,
		globalDefault,
		effective: sessionMode === "inherit" ? globalDefault : sessionMode === "on",
	};
}

export function parseFastCommand(input: string): FastCommand | undefined {
	const parts = input.trim().toLowerCase().split(/\s+/).filter(Boolean);
	if (parts.length === 1) {
		const [action] = parts;
		if (action === "on" || action === "off" || action === "status" || action === "inherit") {
			return { scope: "session", action };
		}
	}
	if (parts.length === 2 && parts[0] === "global") {
		const action = parts[1];
		if (action === "on" || action === "off" || action === "status") {
			return { scope: "global", action };
		}
	}
	return undefined;
}

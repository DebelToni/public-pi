import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const STATE_PATH = join(getAgentDir(), "codex-provider-sync.json");
const CONFIG_PATH = join(getAgentDir(), "codex-provider-sync.local.json");
const POLL_MS = 1_000;
const PID = process.pid;

function isCodexProvider(provider?: string) {
	return provider === "openai-codex" || !!provider?.startsWith("codex-");
}

type SyncState = {
	version: 1;
	provider: string;
	modelId?: string;
	updatedAt: number;
	pid: number;
};

function readJson(path: string) {
	try {
		if (!existsSync(path)) return undefined;
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return undefined;
	}
}

function readState(): SyncState | undefined {
	const raw = readJson(STATE_PATH);
	if (raw?.version !== 1 || typeof raw.provider !== "string" || !isCodexProvider(raw.provider)) return undefined;
	return {
		version: 1,
		provider: raw.provider,
		...(typeof raw.modelId === "string" && raw.modelId.trim() ? { modelId: raw.modelId.trim() } : {}),
		updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : 0,
		pid: typeof raw.pid === "number" ? raw.pid : 0,
	};
}

function readEnabled() {
	const raw = readJson(CONFIG_PATH);
	return raw?.enabled !== false;
}

function writeEnabled(enabled: boolean) {
	mkdirSync(dirname(CONFIG_PATH), { recursive: true });
	writeFileSync(CONFIG_PATH, `${JSON.stringify({ enabled }, null, 2)}\n`, "utf8");
}

function writeState(provider: string, modelId?: string) {
	mkdirSync(dirname(STATE_PATH), { recursive: true });
	const state: SyncState = { version: 1, provider, ...(modelId ? { modelId } : {}), updatedAt: Date.now(), pid: PID };
	writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, "utf8");
	return state;
}

export default function (pi: ExtensionAPI) {
	let ctx: ExtensionContext | undefined;
	let enabled = readEnabled();
	let applying = false;
	let lastSeenUpdatedAt = readState()?.updatedAt ?? 0;
	let lastMtimeMs = existsSync(STATE_PATH) ? statSync(STATE_PATH).mtimeMs : 0;

	async function apply(provider: string, modelId?: string) {
		if (!enabled || !ctx || applying) return;
		const current = ctx.model;
		if (!current || !isCodexProvider(current.provider)) return;
		const targetId = modelId || current.id;
		if (current.provider === provider && current.id === targetId) return;
		const target = ctx.modelRegistry.find(provider, targetId);
		if (!target) return;
		applying = true;
		try {
			await pi.setModel(target);
		} catch (error) {
			ctx.ui.notify(`Codex provider sync failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
		} finally {
			applying = false;
		}
	}

	async function pull() {
		if (!enabled) return;
		let mtimeMs = 0;
		try {
			mtimeMs = existsSync(STATE_PATH) ? statSync(STATE_PATH).mtimeMs : 0;
		} catch {
			return;
		}
		if (mtimeMs <= lastMtimeMs) return;
		lastMtimeMs = mtimeMs;
		const state = readState();
		if (!state || state.updatedAt <= lastSeenUpdatedAt || state.pid === PID) return;
		lastSeenUpdatedAt = state.updatedAt;
		await apply(state.provider, state.modelId);
	}

	function publish(provider: string, modelId?: string) {
		if (!enabled || !isCodexProvider(provider)) return;
		const state = writeState(provider, modelId);
		lastSeenUpdatedAt = state.updatedAt;
		try {
			lastMtimeMs = statSync(STATE_PATH).mtimeMs;
		} catch {}
	}

	const timer = setInterval(() => void pull().catch(() => {}), POLL_MS);
	if (typeof timer.unref === "function") timer.unref();

	pi.on("session_start", async (_event, eventCtx) => {
		ctx = eventCtx;
		const state = readState();
		if (state) {
			lastSeenUpdatedAt = Math.max(lastSeenUpdatedAt, state.updatedAt);
			await apply(state.provider, state.modelId);
		} else if (isCodexProvider(eventCtx.model?.provider)) {
			publish(eventCtx.model!.provider);
		}
	});

	pi.on("session_shutdown", async () => {
		clearInterval(timer);
	});

	pi.on("model_select", async (event, eventCtx) => {
		ctx = eventCtx;
		if (applying || !enabled || event.source === "restore") return;
		if (isCodexProvider(event.model.provider)) publish(event.model.provider);
	});

	pi.registerCommand("codex-sync", {
		description: "Sync only the selected Codex account/provider across Pi processes",
		handler: async (args, commandCtx) => {
			ctx = commandCtx;
			const arg = args.trim().toLowerCase();
			if (arg === "on" || arg === "off") {
				enabled = arg === "on";
				writeEnabled(enabled);
				if (enabled && isCodexProvider(commandCtx.model?.provider)) publish(commandCtx.model!.provider);
				commandCtx.ui.notify(`Codex provider sync ${enabled ? "on" : "off"}`, "info");
				return;
			}
			if (arg === "pull") {
				const state = readState();
				if (state) await apply(state.provider, state.modelId);
				commandCtx.ui.notify(`Codex provider sync pulled ${state?.provider ?? "nothing"}${state?.modelId ? `/${state.modelId}` : ""}`, "info");
				return;
			}
			if (arg === "push") {
				if (!isCodexProvider(commandCtx.model?.provider)) {
					commandCtx.ui.notify("Current model is not a Codex provider.", "warning");
					return;
				}
				publish(commandCtx.model!.provider);
				commandCtx.ui.notify(`Codex provider sync pushed ${commandCtx.model!.provider}`, "info");
				return;
			}
			const state = readState();
			commandCtx.ui.notify(`Codex provider sync ${enabled ? "on" : "off"}; global=${state?.provider ?? "unset"}; current=${commandCtx.model?.provider ?? "unknown"}/${commandCtx.model?.id ?? "unknown"}`, "info");
		},
	});
}

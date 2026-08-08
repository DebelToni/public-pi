import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const COORDINATOR = resolve(dirname(fileURLToPath(import.meta.url)), "coordinator.py");

export const AUTO_RECOVERY_RUNTIME = join(getAgentDir(), "codex-auto-recovery-runtime");
export const AUTO_RECOVERY_CONFIG_PATH = join(AUTO_RECOVERY_RUNTIME, "config.json");
export const AUTO_RECOVERY_STATE_PATH = join(AUTO_RECOVERY_RUNTIME, "state.json");
export const CODEX_PROVIDER_SYNC_PATH = join(getAgentDir(), "codex-provider-sync.json");
export const MODEL_STATUS_PREFIX_CHANNEL = "model-status:prefix";
export const AUTO_RECOVERY_PREFIX_KEY = "codex-auto-recovery";
export type RecoveryStatus = "idle" | "switching" | "succeeded" | "failed";

export type RecoveryState = {
	version: 1;
	generation: number;
	status: RecoveryStatus;
	incidentId?: string;
	failedProvider?: string;
	failedModel?: string;
	failedSyncId?: string;
	startedAt?: number;
	completedAt?: number;
	leaderPid?: number;
	selectedProvider?: string;
	selectedModel?: string;
	selectedSyncId?: string;
	failureCode?: string;
};

export type RecoveryJoin = {
	action: "disabled" | "leader" | "stale" | "wait";
	state?: RecoveryState;
};

export type RecoveryCompletion = {
	committed: boolean;
	state?: RecoveryState;
};

export type RecoveryAbandonment = {
	abandoned: boolean;
	state?: RecoveryState;
};

export type RecoveryCoordinatorStatus = {
	config: { version: 1; enabled: boolean };
	state?: RecoveryState;
	syncId?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function readJson(path: string): unknown {
	try {
		if (!existsSync(path)) return undefined;
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return undefined;
	}
}

export function readAutoRecoveryEnabled() {
	const value = readJson(AUTO_RECOVERY_CONFIG_PATH);
	return isRecord(value) && value.version === 1 && value.enabled === true;
}

export function readRecoveryState(): RecoveryState | undefined {
	const value = readJson(AUTO_RECOVERY_STATE_PATH);
	if (
		!isRecord(value) ||
		value.version !== 1 ||
		typeof value.generation !== "number" ||
		!Number.isInteger(value.generation) ||
		value.generation < 0 ||
		!(["idle", "switching", "succeeded", "failed"] as unknown[]).includes(value.status)
	) {
		return undefined;
	}
	return value as unknown as RecoveryState;
}

function providerSyncIdentity(value: Record<string, unknown>) {
	if (typeof value.changeId === "string" && value.changeId) return value.changeId.slice(0, 200);
	const updatedAt = typeof value.updatedAt === "number" ? Math.trunc(value.updatedAt) : 0;
	const pid = typeof value.pid === "number" ? Math.trunc(value.pid) : 0;
	const provider = typeof value.provider === "string" ? value.provider : "";
	const modelId = typeof value.modelId === "string" ? value.modelId : "";
	return `legacy:${updatedAt}:${pid}:${provider}:${modelId}`.slice(0, 500);
}

export function readProviderSyncId(provider: string, modelId: string) {
	const value = readJson(CODEX_PROVIDER_SYNC_PATH);
	if (!isRecord(value) || value.version !== 1 || value.provider !== provider) return undefined;
	if (typeof value.modelId === "string" && value.modelId && value.modelId !== modelId) return undefined;
	return providerSyncIdentity(value);
}

async function coordinator<T>(args: string[]) {
	const result = await execFileAsync(
		COORDINATOR,
		[
			"--runtime",
			AUTO_RECOVERY_RUNTIME,
			"--sync-state",
			CODEX_PROVIDER_SYNC_PATH,
			...args,
		],
		{ timeout: 10_000, maxBuffer: 64 * 1024 },
	);
	try {
		return JSON.parse(String(result.stdout)) as T;
	} catch {
		throw new Error("Codex recovery coordinator returned invalid output.");
	}
}

export function setAutoRecoveryEnabled(enabled: boolean) {
	return coordinator<{ config: { version: 1; enabled: boolean } }>([
		"set-enabled",
		enabled ? "true" : "false",
		"--pid",
		String(process.pid),
	]);
}

export function readCoordinatorStatus() {
	return coordinator<RecoveryCoordinatorStatus>(["status"]);
}

export function joinRecovery(provider: string, model: string, requestSyncId?: string) {
	return coordinator<RecoveryJoin>([
		"join",
		"--provider",
		provider,
		"--model",
		model,
		...(requestSyncId ? ["--request-sync-id", requestSyncId] : []),
		"--pid",
		String(process.pid),
	]);
}

export function abandonRecovery(generation: number) {
	return coordinator<RecoveryAbandonment>([
		"abandon",
		"--generation",
		String(generation),
	]);
}

export function completeRecovery(
	generation: number,
	result: "succeeded" | "failed",
	selection?: { provider: string; model: string; syncId: string },
	failureCode?: string,
) {
	return coordinator<RecoveryCompletion>([
		"complete",
		"--generation",
		String(generation),
		"--pid",
		String(process.pid),
		"--result",
		result,
		...(selection
			? [
					"--selected-provider",
					selection.provider,
					"--selected-model",
					selection.model,
					"--selected-sync-id",
					selection.syncId,
				]
			: []),
		...(failureCode ? ["--failure-code", failureCode] : []),
	]);
}

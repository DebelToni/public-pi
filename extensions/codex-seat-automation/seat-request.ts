import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { createHash, randomUUID } from "node:crypto";
import {
	chmodSync,
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import lockfile from "proper-lockfile";
import {
	CODEX_SEAT_REQUEST_CHANNEL,
	type CodexSeatRequestResultV1,
	type CodexSeatRequestV1,
} from "../codex-accounts/index.js";
import {
	newOperationId,
	rotateSeat,
	seatStatus,
	type VerifiedWebhookResult,
	type WebhookOptions,
} from "./webhook-client.mjs";

const CONFIG_PATH = join(getAgentDir(), "codex-seat-automation.local.json");
const RUNTIME_DIR = join(getAgentDir(), "codex-seat-automation-runtime");
const PENDING_PATH = join(RUNTIME_DIR, "pending.json");
const REQUEST_TIMEOUT_MS = 15_000;
const OPERATION_TIMEOUT_MS = 6 * 60_000;
const POLL_INTERVAL_MS = 1_000;
const RETRY_INTERVAL_MS = 2_000;
const CONFIG_KEYS = new Set([
	"version",
	"enabled",
	"automaticRecovery",
	"keyId",
	"privateKeyPath",
	"macPublicKeyPath",
	"url",
]);

export type SeatAutomationConfigV1 = {
	version: 1;
	enabled: boolean;
	automaticRecovery: boolean;
	keyId: string;
	privateKeyPath: string;
	macPublicKeyPath: string;
	url: string;
};

type PendingOperationV1 = {
	version: 1;
	operationId: string;
	createdAt: number;
	configurationId: string;
};

type TransportDependencies = {
	rotate(options: WebhookOptions): Promise<VerifiedWebhookResult>;
	status(options: WebhookOptions): Promise<VerifiedWebhookResult>;
	newOperationId(): string;
	now(): number;
	sleep(milliseconds: number): Promise<void>;
	loadConfig(): SeatAutomationConfigV1 | undefined;
	withLock<T>(operation: () => Promise<T>): Promise<T>;
	readPending(): PendingOperationV1 | undefined;
	writePending(pending: PendingOperationV1): void;
	clearPending(operationId: string): void;
};

export type CodexSeatRequestTransportV1 = (
	request: Readonly<Pick<CodexSeatRequestV1, "version" | "context" | "guard">>,
) => Promise<CodexSeatRequestResultV1>;

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: Set<string>) {
	const keys = Object.keys(value);
	return keys.length === expected.size && keys.every((key) => expected.has(key));
}

function expandHome(path: string) {
	if (path === "~") return process.env.HOME ?? path;
	if (path.startsWith("~/")) return join(process.env.HOME ?? "~", path.slice(2));
	return path;
}

function assertOwnerOnly(path: string, label: string) {
	const mode = statSync(path).mode & 0o777;
	if ((mode & 0o077) !== 0) throw new Error(`${label} must not be accessible by group or other users.`);
}

export function readSeatAutomationConfig(): SeatAutomationConfigV1 | undefined {
	if (!existsSync(CONFIG_PATH)) return undefined;
	assertOwnerOnly(CONFIG_PATH, "Codex seat automation config");
	const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as unknown;
	if (!isRecord(raw) || !exactKeys(raw, CONFIG_KEYS) || raw.version !== 1) {
		throw new Error("Codex seat automation config does not match version 1.");
	}
	if (typeof raw.enabled !== "boolean" || typeof raw.automaticRecovery !== "boolean") {
		throw new Error("Codex seat automation config has invalid feature flags.");
	}
	if (typeof raw.keyId !== "string" || !/^[A-Za-z0-9_-]{1,32}$/.test(raw.keyId)) {
		throw new Error("Codex seat automation key ID is invalid.");
	}
	if (typeof raw.privateKeyPath !== "string" || typeof raw.macPublicKeyPath !== "string") {
		throw new Error("Codex seat automation key paths are invalid.");
	}
	const privateKeyPath = resolve(expandHome(raw.privateKeyPath));
	const macPublicKeyPath = resolve(expandHome(raw.macPublicKeyPath));
	if (!existsSync(privateKeyPath) || !statSync(privateKeyPath).isFile()) {
		throw new Error("Codex seat request private key is unavailable.");
	}
	if (!existsSync(macPublicKeyPath) || !statSync(macPublicKeyPath).isFile()) {
		throw new Error("Mac webhook public key is unavailable.");
	}
	assertOwnerOnly(privateKeyPath, "Codex seat request private key");
	if (typeof raw.url !== "string") throw new Error("Codex seat webhook URL is invalid.");
	const url = new URL(raw.url);
	if (
		url.protocol !== "https:" ||
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		url.toString() !== raw.url
	) {
		throw new Error("Codex seat webhook URL must be one canonical HTTPS URL.");
	}
	return {
		version: 1,
		enabled: raw.enabled,
		automaticRecovery: raw.automaticRecovery,
		keyId: raw.keyId,
		privateKeyPath,
		macPublicKeyPath,
		url: raw.url,
	};
}

function fsyncDirectory(path: string) {
	const descriptor = openSync(path, "r");
	try {
		fsyncSync(descriptor);
	} finally {
		closeSync(descriptor);
	}
}

function ensureRuntimeDirectory() {
	const existed = existsSync(RUNTIME_DIR);
	mkdirSync(RUNTIME_DIR, { recursive: true, mode: 0o700 });
	chmodSync(RUNTIME_DIR, 0o700);
	if (!existed) fsyncDirectory(dirname(RUNTIME_DIR));
}

function readPendingOperation(): PendingOperationV1 | undefined {
	if (!existsSync(PENDING_PATH)) return undefined;
	assertOwnerOnly(PENDING_PATH, "Codex seat pending-operation state");
	const raw = JSON.parse(readFileSync(PENDING_PATH, "utf8")) as unknown;
	if (
		!isRecord(raw) ||
		!exactKeys(raw, new Set(["version", "operationId", "createdAt", "configurationId"])) ||
		raw.version !== 1 ||
		typeof raw.operationId !== "string" ||
		!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(raw.operationId) ||
		typeof raw.createdAt !== "number" ||
		!Number.isSafeInteger(raw.createdAt) ||
		raw.createdAt <= 0 ||
		typeof raw.configurationId !== "string" ||
		!/^[0-9a-f]{64}$/.test(raw.configurationId)
	) {
		throw new Error("Codex seat pending-operation state is invalid; refusing to create another operation.");
	}
	return raw as PendingOperationV1;
}

function writePendingOperation(pending: PendingOperationV1) {
	ensureRuntimeDirectory();
	const temporary = `${PENDING_PATH}.${process.pid}.${randomUUID()}.tmp`;
	let descriptor: number | undefined;
	try {
		descriptor = openSync(temporary, "wx", 0o600);
		writeFileSync(descriptor, `${JSON.stringify(pending, null, 2)}\n`, "utf8");
		fsyncSync(descriptor);
		closeSync(descriptor);
		descriptor = undefined;
		renameSync(temporary, PENDING_PATH);
		chmodSync(PENDING_PATH, 0o600);
		fsyncDirectory(RUNTIME_DIR);
	} finally {
		if (descriptor !== undefined) closeSync(descriptor);
		try { unlinkSync(temporary); } catch {}
	}
}

function clearPendingOperation(operationId: string) {
	const current = readPendingOperation();
	if (!current || current.operationId !== operationId) return;
	unlinkSync(PENDING_PATH);
}

async function withOperationLock<T>(operation: () => Promise<T>): Promise<T> {
	ensureRuntimeDirectory();
	const release = await lockfile.lock(RUNTIME_DIR, {
		realpath: false,
		stale: 10 * 60_000,
		update: 10_000,
		retries: { retries: 30, factor: 1.2, minTimeout: 100, maxTimeout: 1_000, randomize: true },
	});
	try {
		return await operation();
	} finally {
		await release();
	}
}

function wait(milliseconds: number) {
	return new Promise<void>((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

const DEFAULT_DEPENDENCIES: TransportDependencies = {
	rotate: rotateSeat,
	status: seatStatus,
	newOperationId,
	now: Date.now,
	sleep: wait,
	loadConfig: readSeatAutomationConfig,
	withLock: withOperationLock,
	readPending: readPendingOperation,
	writePending: writePendingOperation,
	clearPending: clearPendingOperation,
};

function guardAllows(request: Pick<CodexSeatRequestV1, "guard">) {
	try { return request.guard(); } catch { return false; }
}

function failed(message: string): CodexSeatRequestResultV1 {
	return { version: 1, status: "failed", message };
}

function unavailable(message: string): CodexSeatRequestResultV1 {
	return { version: 1, status: "unavailable", message };
}

function configurationId(config: SeatAutomationConfigV1) {
	return createHash("sha256").update(JSON.stringify({
		keyId: config.keyId,
		privateKeyPath: config.privateKeyPath,
		macPublicKeyPath: config.macPublicKeyPath,
		url: config.url,
	})).digest("hex");
}

function commonOptions(config: SeatAutomationConfigV1, operationId: string): WebhookOptions {
	return {
		privateKeyPath: config.privateKeyPath,
		operationId,
		keyId: config.keyId,
		macPublicKeyPath: config.macPublicKeyPath,
		url: config.url,
		audience: config.url,
		timeoutMs: REQUEST_TIMEOUT_MS,
	};
}

function terminalResult(result: VerifiedWebhookResult, operationId: string, dependencies: TransportDependencies) {
	const job = result.job;
	if (!job?.isTerminal) return undefined;
	if (job.state === "uncertain") {
		return failed("The Mac reported an uncertain seat outcome; Anton must review it before another switch.");
	}
	dependencies.clearPending(operationId);
	if (job.state === "succeeded" && job.result?.ok === true) {
		return { version: 1, status: "succeeded" } satisfies CodexSeatRequestResultV1;
	}
	return failed(job.result?.message || "The Mac rejected the seat operation.");
}

export async function executeSeatRequestV1(
	request: Readonly<Pick<CodexSeatRequestV1, "version" | "context" | "guard">>,
	overrides: Partial<TransportDependencies> = {},
): Promise<CodexSeatRequestResultV1> {
	const dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides };
	if (!guardAllows(request)) return failed("Codex seat request was cancelled.");
	let config: SeatAutomationConfigV1 | undefined;
	try {
		config = dependencies.loadConfig();
	} catch (error) {
		return unavailable(error instanceof Error ? error.message : String(error));
	}
	if (!config?.enabled) return unavailable("Codex seat automation is not configured on this machine.");

	try {
		return await dependencies.withLock(async () => {
			const expectedConfigurationId = configurationId(config!);
			let pending = dependencies.readPending();
			if (pending && pending.configurationId !== expectedConfigurationId) {
				return failed(
					"A pending seat operation belongs to different client configuration; its operation ID was preserved.",
				);
			}
			if (!pending) {
				pending = {
					version: 1,
					operationId: dependencies.newOperationId(),
					createdAt: dependencies.now(),
					configurationId: expectedConfigurationId,
				};
				dependencies.writePending(pending);
			}
			const operationId = pending.operationId;
			const options = commonOptions(config!, operationId);
			const deadline = dependencies.now() + OPERATION_TIMEOUT_MS;
			let admitted = false;
			let consecutiveTransportErrors = 0;

			while (dependencies.now() < deadline) {
				if (!guardAllows(request)) return failed("Codex seat request was cancelled; its operation ID was preserved.");
				let response: VerifiedWebhookResult;
				try {
					response = admitted
						? await dependencies.status(options)
						: await dependencies.rotate(options);
					consecutiveTransportErrors = 0;
				} catch (error) {
					consecutiveTransportErrors++;
					if (consecutiveTransportErrors >= 3) {
						return failed(
							`The signed seat request could not be confirmed; the operation ID was preserved: ${error instanceof Error ? error.message : String(error)}`,
						);
					}
					await dependencies.sleep(
						Math.min(RETRY_INTERVAL_MS, Math.max(0, deadline - dependencies.now())),
					);
					continue;
				}

				const terminal = terminalResult(response, operationId, dependencies);
				if (terminal) return terminal;
				if (response.job) {
					admitted = true;
					await dependencies.sleep(
						Math.min(POLL_INTERVAL_MS, Math.max(0, deadline - dependencies.now())),
					);
					continue;
				}
				if (response.code === "JOB_NOT_FOUND") {
					admitted = false;
					await dependencies.sleep(
						Math.min(RETRY_INTERVAL_MS, Math.max(0, deadline - dependencies.now())),
					);
					continue;
				}
				if (response.code === "ACTION_IN_PROGRESS") {
					await dependencies.sleep(
						Math.min(RETRY_INTERVAL_MS, Math.max(0, deadline - dependencies.now())),
					);
					continue;
				}
				if (response.code === "ACTION_SUCCESS_COOLDOWN" || response.code === "ACTION_FAILURE_COOLDOWN") {
					await dependencies.sleep(
						Math.min(
							(response.retryAfterSeconds ?? 1) * 1_000,
							Math.max(0, deadline - dependencies.now()),
						),
					);
					continue;
				}
				return failed(response.message);
			}
			return failed("The seat operation did not finish before the polling deadline; its operation ID was preserved.");
		});
	} catch (error) {
		return failed(error instanceof Error ? error.message : String(error));
	}
}

export const seatRequestTransportV1: CodexSeatRequestTransportV1 = (request) =>
	executeSeatRequestV1(request);

function isSeatRequest(value: unknown): value is CodexSeatRequestV1 {
	if (!value || typeof value !== "object") return false;
	const request = value as Partial<CodexSeatRequestV1>;
	return request.version === 1 &&
		!!request.context && typeof request.context === "object" &&
		typeof request.guard === "function";
}

export function installSeatRequestHook(
	pi: ExtensionAPI,
	transport: CodexSeatRequestTransportV1 = seatRequestTransportV1,
) {
	const unsubscribe = pi.events.on(CODEX_SEAT_REQUEST_CHANNEL, (value) => {
		if (!isSeatRequest(value) || value.run) return;
		value.run = Promise.resolve().then(() => transport({
			version: 1,
			context: value.context,
			guard: value.guard,
		}));
	});
	pi.on("session_shutdown", unsubscribe);
	return unsubscribe;
}

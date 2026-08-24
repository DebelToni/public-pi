import { createHash, randomUUID } from "node:crypto";
import {
	chmodSync,
	closeSync,
	constants,
	fchmodSync,
	lstatSync,
	mkdirSync,
	openSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { isRecord } from "./cache.ts";

export const BTW_LOG_SCHEMA_VERSION = 2;
export const BTW_LOG_DIR = join(getAgentDir(), "btw-logs");

function safeFilePart(value: string) {
	return value.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 100) || "unknown-session";
}

function jsonText(value: unknown) {
	return JSON.stringify(value) ?? "undefined";
}

export function payloadDiagnostics(payload: unknown) {
	const serialized = jsonText(payload);
	const input = isRecord(payload) && Array.isArray(payload.input) ? payload.input : [];
	return {
		bytes: Buffer.byteLength(serialized),
		sha256: createHash("sha256").update(serialized).digest("hex"),
		inputItems: input.length,
		promptCacheKey: isRecord(payload) && typeof payload.prompt_cache_key === "string"
			? payload.prompt_cache_key
			: undefined,
	};
}

export function errorDiagnostics(error: unknown) {
	if (error instanceof Error) {
		return { name: error.name, message: error.message, stack: error.stack };
	}
	return { name: typeof error, message: String(error) };
}

export class BtwRunLogger {
	readonly runId = randomUUID();
	readonly path: string;
	readonly sessionId: string;
	private readonly enabled: boolean;
	private readonly startedAt = performance.now();
	private sequence = 0;
	private writeError?: ReturnType<typeof errorDiagnostics>;

	constructor(sessionId: string, rootDir?: string) {
		this.sessionId = sessionId;
		this.enabled = rootDir !== undefined || process.env.PI_BTW_DIAGNOSTICS === "1";
		if (!this.enabled) {
			this.path = "";
			return;
		}
		const destination = rootDir ?? BTW_LOG_DIR;
		mkdirSync(destination, { recursive: true, mode: 0o700 });
		const resolvedRoot = realpathSync(destination);
		chmodSync(resolvedRoot, 0o700);
		this.path = join(resolvedRoot, `${safeFilePart(sessionId)}.jsonl`);
		try {
			if (lstatSync(this.path).isSymbolicLink()) throw new Error(`/btw log file cannot be a symbolic link: ${this.path}`);
		} catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
		}
	}

	get lastError() {
		return this.writeError;
	}

	write(event: string, data: Record<string, unknown> = {}) {
		if (!this.enabled) return true;
		try {
			const record = {
				schemaVersion: BTW_LOG_SCHEMA_VERSION,
				timestamp: new Date().toISOString(),
				timestampMs: Date.now(),
				elapsedMs: Number((performance.now() - this.startedAt).toFixed(3)),
				sequence: this.sequence++,
				pid: process.pid,
				sessionId: this.sessionId,
				runId: this.runId,
				event,
				...data,
			};
			const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0);
			const fd = openSync(this.path, flags, 0o600);
			try {
				fchmodSync(fd, 0o600);
				writeFileSync(fd, `${jsonText(record)}\n`, "utf8");
			} finally {
				closeSync(fd);
			}
			return true;
		} catch (error) {
			this.writeError = errorDiagnostics(error);
			return false;
		}
	}
}

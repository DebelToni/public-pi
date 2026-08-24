import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import {
	chmodSync,
	closeSync,
	existsSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

const VERSION = 1;
const AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const ROOT = join(AGENT_DIR, "agent-time-telemetry");

type Writer = {
	processId: string;
	write(event: Record<string, unknown>, durable?: boolean): void;
	close(): void;
};

type Operations = {
	createWriter(context: ExtensionContext): Writer;
	now(): number;
	monotonic(): number;
	randomId(): string;
};

function privateDirectory(path: string) {
	if (existsSync(path)) {
		const stat = lstatSync(path);
		if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Unsafe telemetry directory: ${path}`);
	} else {
		mkdirSync(path, { recursive: true, mode: 0o700 });
	}
	chmodSync(path, 0o700);
}

function defaultWriter(context: ExtensionContext): Writer {
	privateDirectory(ROOT);
	const sessionId = context.sessionManager.getSessionId();
	const sessionRoot = join(ROOT, sessionId);
	privateDirectory(sessionRoot);
	const processId = randomUUID();
	const path = join(sessionRoot, `${Date.now()}-${processId}.jsonl`);
	const descriptor = openSync(path, "wx", 0o600);
	let closed = false;
	const write = (event: Record<string, unknown>, durable = false) => {
		if (closed) return;
		writeSync(descriptor, `${JSON.stringify(event)}\n`, undefined, "utf8");
		if (durable) fsyncSync(descriptor);
	};
	write({
		version: VERSION,
		type: "telemetry_header",
		processId,
		sessionId,
		cwd: context.cwd,
		processKind: process.env.PI_SUBAGENT === "1" ? "subagent" : "topLevel",
		sessionFile: context.sessionManager.getSessionFile() ? "persisted" : "ephemeral",
		createdAtMs: Date.now(),
	}, true);
	return {
		processId,
		write,
		close() {
			if (closed) return;
			closed = true;
			try { fsyncSync(descriptor); } catch {}
			closeSync(descriptor);
		},
	};
}

const DEFAULT_OPERATIONS: Operations = {
	createWriter: defaultWriter,
	now: Date.now,
	monotonic: () => performance.now(),
	randomId: randomUUID,
};

function usageSummary(message: any) {
	const usage = message?.usage;
	if (!usage || typeof usage !== "object") return undefined;
	return {
		input: usage.input,
		output: usage.output,
		cacheRead: usage.cacheRead,
		cacheWrite: usage.cacheWrite,
		totalTokens: usage.totalTokens,
		cost: usage.cost?.total,
	};
}

function meaningfulUpdateType(value: unknown) {
	if (!value || typeof value !== "object") return undefined;
	const type = (value as { type?: unknown }).type;
	if (typeof type !== "string") return undefined;
	return type.endsWith("_delta") || type === "toolcall_start" ? type : undefined;
}

export function installAgentTimeTelemetry(pi: ExtensionAPI, overrides: Partial<Operations> = {}) {
	const operations = { ...DEFAULT_OPERATIONS, ...overrides };
	let writer: Writer | undefined;
	let sequence = 0;
	let activityId: string | undefined;
	let runId: string | undefined;
	let turnIndex: number | undefined;
	let firstMeaningfulRecorded = false;
	let compactionId: string | undefined;
	let treeId: string | undefined;

	const record = (type: string, data: Record<string, unknown> = {}, durable = false) => {
		if (!writer) return;
		writer.write({
			version: VERSION,
			type,
			sequence: sequence++,
			atMs: operations.now(),
			monotonicMs: operations.monotonic(),
			processId: writer.processId,
			...(runId ? { runId } : {}),
			...(turnIndex !== undefined ? { turnIndex } : {}),
			...data,
		}, durable);
	};

	pi.on("session_start", (_event, context) => {
		try {
			writer = operations.createWriter(context);
			sequence = 0;
			record("session_start", {}, true);
		} catch (error) {
			context.ui.notify(`Agent-time telemetry unavailable: ${error instanceof Error ? error.message : String(error)}`, "warning");
		}
	});

	pi.on("before_agent_start", () => {
		if (!activityId) {
			activityId = operations.randomId();
			record("activity_start", { activityId }, true);
		}
		record("before_agent_start", { activityId });
	});
	pi.on("agent_start", () => {
		if (!activityId) {
			activityId = operations.randomId();
			record("activity_start", { activityId }, true);
		}
		runId = operations.randomId();
		turnIndex = undefined;
		record("agent_start");
	});
	pi.on("turn_start", (event) => {
		turnIndex = event.turnIndex;
		firstMeaningfulRecorded = false;
		record("turn_start");
	});
	pi.on("before_provider_request", () => record("before_provider_request"));
	pi.on("after_provider_response", (event) => record("after_provider_response", { status: event.status }));
	pi.on("message_start", (event) => {
		if (event.message.role !== "assistant") return;
		record("assistant_message_start", {
			messageTimestampMs: event.message.timestamp,
			provider: event.message.provider,
			model: event.message.model,
			api: event.message.api,
		});
	});
	pi.on("message_update", (event) => {
		if (firstMeaningfulRecorded) return;
		const updateType = meaningfulUpdateType(event.assistantMessageEvent);
		if (!updateType) return;
		firstMeaningfulRecorded = true;
		record("assistant_first_meaningful_update", { updateType });
	});
	pi.on("message_end", (event) => {
		if (event.message.role !== "assistant") return;
		record("assistant_message_end", {
			messageTimestampMs: event.message.timestamp,
			responseId: (event.message as any).responseId,
			provider: event.message.provider,
			model: event.message.model,
			api: event.message.api,
			stopReason: event.message.stopReason,
			usage: usageSummary(event.message),
		}, true);
	});
	pi.on("tool_execution_start", (event) => record("tool_execution_start", {
		toolCallId: event.toolCallId,
		toolName: event.toolName,
	}));
	pi.on("tool_execution_end", (event) => record("tool_execution_end", {
		toolCallId: event.toolCallId,
		toolName: event.toolName,
		isError: event.isError,
	}));
	pi.on("turn_end", (event) => record("turn_end", { stopReason: (event.message as any).stopReason }, true));
	pi.on("agent_end", () => record("agent_end", {}, true));
	pi.on("agent_settled", () => {
		record("agent_settled", { activityId }, true);
		if (activityId) record("activity_end", { activityId }, true);
		activityId = undefined;
		runId = undefined;
		turnIndex = undefined;
	});
	pi.on("session_before_compact", (event) => {
		compactionId = operations.randomId();
		record("compaction_start", { compactionId, reason: event.reason });
	});
	pi.on("session_compact", (event) => {
		record("compaction_end", { compactionId, reason: event.reason }, true);
		compactionId = undefined;
	});
	pi.on("session_before_tree", () => {
		treeId = operations.randomId();
		record("tree_navigation_start", { treeId });
	});
	pi.on("session_tree", () => {
		record("tree_navigation_end", { treeId }, true);
		treeId = undefined;
	});
	pi.on("session_shutdown", () => {
		record("session_shutdown", {}, true);
		writer?.close();
		writer = undefined;
		activityId = undefined;
		runId = undefined;
		turnIndex = undefined;
	});
}

export default function agentTimeTelemetry(pi: ExtensionAPI) {
	installAgentTimeTelemetry(pi);
}

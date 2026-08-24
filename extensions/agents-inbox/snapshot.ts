import { execFileSync } from "node:child_process";
import { closeSync, fstatSync, openSync, readFileSync, readSync, realpathSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export type AgentCategory = "working" | "ready" | "attention";

export type RuntimeState = {
	running: boolean;
	lastEvent?: string;
	lastProgressAt?: number;
	activeTool?: { id: string; name: string; startedAt?: number };
};

export type TmuxAgentPane = {
	tmuxSessionId: string;
	tmuxSessionName: string;
	windowId: string;
	windowIndex: number;
	paneId: string;
	paneIndex: number;
	panePid: number;
	piPid: number;
	processState: string;
	cwd: string;
	title: string;
	sessionId?: string;
	sessionFile?: string;
	telemetryFile?: string;
	runtime: RuntimeState;
};

export type PaneContext = {
	previousAssistant: string;
	lastPrompt: string;
	tools: string;
	current: string;
	hasFinalOutput: boolean;
	finalStopReason?: string;
	lastToolTimeoutMs?: number;
	unmatchedToolCall: boolean;
	lastToolError: boolean;
	contextUnavailable?: boolean;
};

export type AgentInboxItem = TmuxAgentPane & {
	context: PaneContext;
	category: AgentCategory;
	status: string;
	pending: boolean;
	fingerprint: string;
};

type CommandRunner = (command: string, args: string[]) => string;

export type SnapshotDependencies = {
	run?: CommandRunner;
	agentDir?: string;
	now?: () => number;
};

const TMUX_FORMAT = [
	"#{session_id}",
	"#{session_name}",
	"#{window_id}",
	"#{window_index}",
	"#{pane_id}",
	"#{pane_index}",
	"#{pane_pid}",
	"#{pane_current_command}",
	"#{pane_current_path}",
	"#{pane_title}",
	"#{pane_dead}",
].join("\t");

function defaultRun(command: string, args: string[]) {
	return execFileSync(command, args, {
		encoding: "utf8",
		env: process.env,
		maxBuffer: 32 * 1024 * 1024,
		stdio: ["ignore", "pipe", "pipe"],
	});
}

function cleanTitle(value: string) {
	return value.replace(/^[●✓○π!]\s*/u, "").replace(/^pi\s*-\s*/i, "").trim();
}

function readTail(path: string, maxBytes: number) {
	const descriptor = openSync(path, "r");
	try {
		const size = fstatSync(descriptor).size;
		const start = Math.max(0, size - maxBytes);
		const buffer = Buffer.allocUnsafe(size - start);
		readSync(descriptor, buffer, 0, buffer.length, start);
		let text = buffer.toString("utf8");
		if (start > 0) {
			const newline = text.indexOf("\n");
			text = newline === -1 ? "" : text.slice(newline + 1);
		}
		return text;
	} finally {
		closeSync(descriptor);
	}
}

function telemetryState(path: string): RuntimeState {
	let records: any[] = [];
	try {
		records = readTail(path, 1024 * 1024)
			.split("\n")
			.filter(Boolean)
			.map((line) => {
				try { return JSON.parse(line); } catch { return undefined; }
			})
			.filter(Boolean);
	} catch {
		return { running: false };
	}
	const last = records.at(-1);
	let lastActivityStart = -1;
	let lastActivityEnd = -1;
	const activeTools = new Map<string, { id: string; name: string; startedAt?: number }>();
	for (let index = 0; index < records.length; index++) {
		const record = records[index];
		if (record.type === "activity_start") lastActivityStart = index;
		if (record.type === "activity_end" || record.type === "agent_settled" || record.type === "session_shutdown") {
			lastActivityEnd = index;
		}
		if (record.type === "tool_execution_start" && typeof record.toolCallId === "string") {
			activeTools.set(record.toolCallId, { id: record.toolCallId, name: String(record.toolName ?? "tool"), startedAt: record.atMs });
		}
		if (record.type === "tool_execution_end" && typeof record.toolCallId === "string") {
			activeTools.delete(record.toolCallId);
		}
	}
	const terminalTypes = new Set(["activity_end", "agent_settled", "session_shutdown", "session_start"]);
	const running = lastActivityStart > lastActivityEnd || Boolean(last?.runId && !terminalTypes.has(last?.type));
	return {
		running,
		lastEvent: typeof last?.type === "string" ? last.type : undefined,
		lastProgressAt: typeof last?.atMs === "number" ? last.atMs : undefined,
		activeTool: [...activeTools.values()].at(-1),
	};
}

function telemetryHeader(path: string) {
	try {
		const line = readFileSync(path, "utf8").split("\n", 1)[0];
		return JSON.parse(line);
	} catch {
		return undefined;
	}
}

type ProcessRow = { pid: number; ppid: number; state: string; command: string };

function parseProcesses(raw: string) {
	const rows: ProcessRow[] = [];
	for (const line of raw.split("\n")) {
		const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
		if (!match) continue;
		rows.push({ pid: Number(match[1]), ppid: Number(match[2]), state: match[3], command: match[4] });
	}
	return rows;
}

function descendants(rootPid: number, rows: ProcessRow[]) {
	const byParent = new Map<number, ProcessRow[]>();
	for (const row of rows) {
		const siblings = byParent.get(row.ppid) ?? [];
		siblings.push(row);
		byParent.set(row.ppid, siblings);
	}
	const output: Array<ProcessRow & { depth: number }> = [];
	const queue = (byParent.get(rootPid) ?? []).map((row) => ({ row, depth: 1 }));
	while (queue.length) {
		const current = queue.shift()!;
		output.push({ ...current.row, depth: current.depth });
		for (const child of byParent.get(current.row.pid) ?? []) queue.push({ row: child, depth: current.depth + 1 });
	}
	return output;
}

function looksLikePi(command: string) {
	const executable = command.trim().split(/\s+/, 1)[0] ?? "";
	return basename(executable) === "pi" || command.includes("pi-coding-agent");
}

function parseLsof(raw: string) {
	const paths = new Map<number, string[]>();
	let pid: number | undefined;
	for (const line of raw.split("\n")) {
		if (line.startsWith("p") && /^p\d+$/.test(line)) {
			pid = Number(line.slice(1));
			continue;
		}
		if (pid && line.startsWith("n")) {
			const list = paths.get(pid) ?? [];
			list.push(line.slice(1));
			paths.set(pid, list);
		}
	}
	return paths;
}

function canonical(path: string) {
	try { return realpathSync.native(path); } catch { return resolve(path); }
}

function isUnder(path: string, root: string) {
	const target = canonical(path);
	const base = canonical(root);
	return target === base || target.startsWith(base.endsWith(sep) ? base : `${base}${sep}`);
}

function sessionFilesById(raw: string, sessionsRoot: string) {
	const files = new Map<string, string>();
	for (const path of raw.split("\n").filter(Boolean)) {
		if (!isUnder(path, sessionsRoot)) continue;
		const match = basename(path).match(/_([0-9a-f-]{36})\.jsonl$/i);
		if (match) files.set(match[1], path);
	}
	return files;
}

export function discoverTmuxAgents(dependencies: SnapshotDependencies = {}): TmuxAgentPane[] {
	const run = dependencies.run ?? defaultRun;
	const agentDir = dependencies.agentDir ?? getAgentDir();
	const paneRows = run("tmux", ["list-panes", "-a", "-F", TMUX_FORMAT])
		.split("\n")
		.filter(Boolean)
		.map((line) => line.split("\t"));
	const processes = parseProcesses(run("ps", ["-axo", "pid=,ppid=,state=,command="]));
	const candidatesByPane = new Map<string, Array<ProcessRow & { depth: number }>>();
	const allCandidatePids = new Set<number>();
	for (const fields of paneRows) {
		const paneId = fields[4];
		const panePid = Number(fields[6]);
		if (!paneId || !Number.isInteger(panePid) || fields[10] === "1") continue;
		const rootProcess = processes.find((row) => row.pid === panePid);
		const candidates = [
			...(rootProcess && looksLikePi(rootProcess.command) ? [{ ...rootProcess, depth: 0 }] : []),
			...descendants(panePid, processes).filter((row) => looksLikePi(row.command)),
		];
		if (!candidates.length) continue;
		candidatesByPane.set(paneId, candidates);
		for (const candidate of candidates) allCandidatePids.add(candidate.pid);
	}
	if (!allCandidatePids.size) return [];
	let lsof = new Map<number, string[]>();
	try { lsof = parseLsof(run("lsof", ["-Fn", "-p", [...allCandidatePids].join(",")])); } catch {}
	const telemetryRoot = join(agentDir, "agent-time-telemetry");
	const configuredSessionsRoot = join(agentDir, "sessions");
	let sessionsRoot = configuredSessionsRoot;
	try { sessionsRoot = realpathSync.native(configuredSessionsRoot); } catch {}
	let sessionFileOutput = "";
	try { sessionFileOutput = run("find", [sessionsRoot, "-type", "f", "-name", "*.jsonl"]); } catch {}
	const sessionFiles = sessionFilesById(sessionFileOutput, sessionsRoot);
	const output: TmuxAgentPane[] = [];

	for (const fields of paneRows) {
		const paneId = fields[4];
		const candidates = paneId ? candidatesByPane.get(paneId) : undefined;
		if (!paneId || !candidates?.length) continue;
		const resolved = candidates
			.map((candidate) => {
				const telemetryFile = (lsof.get(candidate.pid) ?? []).find((path) => isUnder(path, telemetryRoot) && path.endsWith(".jsonl"));
				if (!telemetryFile) return undefined;
				const pathSessionId = telemetryFile.match(/agent-time-telemetry\/([^/]+)\//)?.[1];
				const header = telemetryHeader(telemetryFile);
				if (header?.processKind && header.processKind !== "topLevel") return undefined;
				if (!pathSessionId || (header?.sessionId && header.sessionId !== pathSessionId)) return undefined;
				return { candidate, telemetryFile, sessionId: pathSessionId };
			})
			.filter(Boolean)
			.sort((a, b) => a!.candidate.depth - b!.candidate.depth)[0];
		const fallback = [...candidates].sort((a, b) => a.depth - b.depth)[0];
		const process = resolved?.candidate ?? fallback;
		if (!process) continue;
		output.push({
			tmuxSessionId: fields[0],
			tmuxSessionName: fields[1],
			windowId: fields[2],
			windowIndex: Number(fields[3]),
			paneId,
			paneIndex: Number(fields[5]),
			panePid: Number(fields[6]),
			piPid: process.pid,
			processState: process.state,
			cwd: fields[8],
			title: cleanTitle(fields[9]) || basename(fields[8]) || "pi",
			sessionId: resolved?.sessionId,
			sessionFile: resolved?.sessionId ? sessionFiles.get(resolved.sessionId) : undefined,
			telemetryFile: resolved?.telemetryFile,
			runtime: resolved?.telemetryFile
				? telemetryState(resolved.telemetryFile)
				: { running: false, lastEvent: "telemetry unavailable" },
		});
	}
	return output.sort((a, b) => a.tmuxSessionName.localeCompare(b.tmuxSessionName) || a.windowIndex - b.windowIndex || a.paneIndex - b.paneIndex);
}

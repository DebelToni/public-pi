import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { textOfMessage } from "../modes/shared.js";

const DEFAULT_MODEL_ID = "gpt-5.4-mini";
const CODEX_ACCOUNTS_EXTENSION = join(getAgentDir(), "extensions", "codex-accounts", "index.ts");
const MAX_SCAN_SESSIONS = 400;
const MAX_PROMPT_QUERY_CHARS = 4000;

type SessionCandidate = {
	file: string;
	id: string;
	cwd: string;
	timestamp: string;
	modifiedMs: number;
	score: number;
	matches: string[];
	leafId?: string;
};

type JsonEvent = {
	type?: string;
	message?: Message;
};

function expandPath(input: string) {
	if (input === "~") return homedir();
	if (input.startsWith("~/")) return join(homedir(), input.slice(2));
	return input;
}

function normalizePath(input: string) {
	return resolve(expandPath(input));
}

function sessionDirForCwd(cwd: string) {
	const resolvedCwd = normalizePath(cwd);
	const safePath = `--${resolvedCwd.replace(/^[\/\\]/, "").replace(/[\/\\:]/g, "-")}--`;
	return join(getAgentDir(), "sessions", safePath);
}

function listJsonlFiles(dir: string) {
	try {
		if (!existsSync(dir)) return [];
		return readdirSync(dir, { withFileTypes: true })
			.filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
			.map((entry) => join(dir, entry.name));
	} catch {
		return [];
	}
}

function listAllSessionFiles() {
	const root = join(getAgentDir(), "sessions");
	try {
		if (!existsSync(root)) return [];
		return readdirSync(root, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.flatMap((entry) => listJsonlFiles(join(root, entry.name)));
	} catch {
		return [];
	}
}

function readJsonLines(file: string, maxLines = 5000) {
	try {
		const lines = readFileSync(file, "utf8").split("\n").filter(Boolean).slice(0, maxLines);
		const parsed: any[] = [];
		for (const line of lines) {
			try {
				parsed.push(JSON.parse(line));
			} catch {}
		}
		return parsed;
	} catch {
		return [];
	}
}

function fileHeader(file: string) {
	const [header] = readJsonLines(file, 1);
	if (header?.type !== "session" || typeof header.cwd !== "string") return undefined;
	return header as { id?: string; cwd: string; timestamp?: string; parentSession?: string };
}

function escapeRegExp(input: string) {
	return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function queryTerms(query: string) {
	return query.toLowerCase().split(/[^a-z0-9._-]+/i).filter((term) => term.length >= 3).slice(0, 12);
}

function messagePreview(message: Message) {
	return truncateToWidth(textOfMessage(message).replace(/\s+/g, " ").trim(), 500);
}

function buildCandidate(file: string, query: string, sinceMs: number | undefined, cwdFilter?: string, sessionHint?: string): SessionCandidate | undefined {
	let stat;
	try {
		stat = statSync(file);
	} catch {
		return undefined;
	}
	if (sinceMs && stat.mtimeMs < sinceMs) return undefined;
	const entries = readJsonLines(file);
	const header = entries.find((entry) => entry?.type === "session");
	if (!header?.cwd) return undefined;
	const cwd = String(header.cwd);
	if (cwdFilter) {
		const normalizedCwd = normalizePath(cwdFilter);
		if (normalizePath(cwd) !== normalizedCwd && !normalizePath(cwd).startsWith(`${normalizedCwd}/`)) return undefined;
	}

	const q = query.trim();
	const hint = sessionHint?.trim();
	const terms = queryTerms(`${q} ${hint ?? ""}`);
	const regex = q ? new RegExp(escapeRegExp(q), "i") : undefined;
	let score = 0;
	let bestLocalScore = 0;
	let leafId: string | undefined;
	const matches: string[] = [];

	if (hint && `${file}\n${cwd}`.toLowerCase().includes(hint.toLowerCase())) score += 5;
	for (const entry of entries) {
		if (entry?.type !== "message") continue;
		const message = entry.message as Message | undefined;
		if (!message) continue;
		const text = textOfMessage(message).replace(/\s+/g, " ");
		const lower = text.toLowerCase();
		let local = 0;
		if (regex?.test(text)) local += 20;
		for (const term of terms) if (lower.includes(term)) local += 2;
		if (local > 0) {
			score += local;
			if (local >= bestLocalScore && typeof entry.id === "string") {
				bestLocalScore = local;
				leafId = entry.id;
			}
			if (matches.length < 4) matches.push(`${message.role}: ${messagePreview(message)}`);
		}
	}
	if (score <= 0 && (q || hint)) return undefined;
	return {
		file,
		id: String(header.id ?? ""),
		cwd,
		timestamp: String(header.timestamp ?? new Date(stat.birthtimeMs).toISOString()),
		modifiedMs: stat.mtimeMs,
		score: score + Math.max(0, 5 - matches.length),
		matches,
		leafId,
	};
}

function findCandidates(params: { query: string; cwd?: string; sinceHours?: number; sessionHint?: string; limit?: number }) {
	const sinceMs = params.sinceHours && params.sinceHours > 0 ? Date.now() - params.sinceHours * 60 * 60 * 1000 : undefined;
	const files = (params.cwd ? listJsonlFiles(sessionDirForCwd(params.cwd)) : listAllSessionFiles())
		.map((file) => ({ file, mtime: statSync(file).mtimeMs }))
		.sort((a, b) => b.mtime - a.mtime)
		.slice(0, MAX_SCAN_SESSIONS)
		.map(({ file }) => file);
	return files
		.map((file) => buildCandidate(file, params.query, sinceMs, params.cwd, params.sessionHint))
		.filter(Boolean)
		.sort((a, b) => b!.score - a!.score || b!.modifiedMs - a!.modifiedMs)
		.slice(0, Math.max(1, Math.min(20, params.limit ?? 5))) as SessionCandidate[];
}

function assistantText(message: AssistantMessage) {
	return message.content.filter((part: any) => part?.type === "text").map((part: any) => part.text).join("\n").trim();
}

function codexModel(currentProvider: string | undefined, requested: string | undefined) {
	if (requested?.trim()) return requested.trim();
	const provider = currentProvider === "openai-codex" || currentProvider?.startsWith("codex-") ? currentProvider : "openai-codex";
	return `${provider}/${DEFAULT_MODEL_ID}`;
}

function createDisposableBranch(candidate: SessionCandidate) {
	const entries = readJsonLines(candidate.file);
	const sourceHeader = entries.find((entry) => entry?.type === "session");
	if (!sourceHeader?.cwd) throw new Error(`Invalid source session: ${candidate.file}`);
	const nonHeader = entries.filter((entry) => entry?.type !== "session" && typeof entry?.id === "string");
	const byId = new Map(nonHeader.map((entry) => [entry.id, entry]));
	let leaf = candidate.leafId ? byId.get(candidate.leafId) : nonHeader[nonHeader.length - 1];
	if (!leaf) throw new Error(`No entries in source session: ${candidate.file}`);
	const path: any[] = [];
	while (leaf) {
		path.unshift(leaf);
		leaf = leaf.parentId ? byId.get(leaf.parentId) : undefined;
	}
	if (path.length === 0) throw new Error(`Could not build branch path for: ${candidate.file}`);
	const sessionDir = sessionDirForCwd(candidate.cwd);
	mkdirSync(sessionDir, { recursive: true });
	const timestamp = new Date().toISOString();
	const id = randomUUID();
	const branchFile = join(sessionDir, `${timestamp.replace(/[:.]/g, "-")}_${id}.jsonl`);
	const header = {
		type: "session",
		version: 3,
		id,
		timestamp,
		cwd: candidate.cwd,
		parentSession: candidate.file,
	};
	const content = [header, ...path].map((entry) => JSON.stringify(entry)).join("\n") + "\n";
	writeFileSync(branchFile, content, "utf8");
	return branchFile;
}

function oraclePrompt(query: string) {
	return [
		"You are a read-only archivist for this old Pi session.",
		"Answer only the user's question from the session context.",
		"Do not continue the old task. Do not modify files. Do not run broad commands unless absolutely necessary.",
		"Prefer concise answers with concrete decisions, commands, file paths, and uncertainty.",
		"If the session does not contain enough information, say that clearly.",
		"",
		`Question:\n${query.slice(0, MAX_PROMPT_QUERY_CHARS)}`,
	].join("\n");
}

async function runForkedOracle(candidate: SessionCandidate, query: string, model: string, thinking: string, signal?: AbortSignal) {
	const branchFile = createDisposableBranch(candidate);
	const args = ["--no-extensions"];
	if (existsSync(CODEX_ACCOUNTS_EXTENSION)) args.push("-e", CODEX_ACCOUNTS_EXTENSION);
	args.push("--mode", "json", "--session", branchFile, "--model", model, "--thinking", thinking, "--tools", "read,grep,find,ls", "-p", oraclePrompt(query));
	let stderr = "";
	let rawStdout = "";
	let final = "";
	let usedModel = model;
	let usage: any = undefined;

	const exitCode = await new Promise<number>((resolve) => {
		const proc = spawn("pi", args, { cwd: candidate.cwd, stdio: ["ignore", "pipe", "pipe"] });
		let buffer = "";
		const processLine = (line: string) => {
			if (!line.trim()) return;
			rawStdout += `${line}\n`;
			let event: JsonEvent;
			try {
				event = JSON.parse(line);
			} catch {
				return;
			}
			if (event.type === "message_end" && event.message?.role === "assistant") {
				const message = event.message as AssistantMessage;
				const text = assistantText(message);
				if (text) final = text;
				usedModel = message.provider && message.model ? `${message.provider}/${message.model}` : usedModel;
				usage = message.usage;
			}
		};
		proc.stdout.on("data", (data) => {
			buffer += data.toString();
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) processLine(line);
		});
		proc.stderr.on("data", (data) => {
			stderr += data.toString();
		});
		proc.on("close", (code) => {
			if (buffer.trim()) processLine(buffer);
			resolve(code ?? 0);
		});
		proc.on("error", () => resolve(1));
		const kill = () => {
			proc.kill("SIGTERM");
			setTimeout(() => {
				if (!proc.killed) proc.kill("SIGKILL");
			}, 5000).unref?.();
		};
		if (signal?.aborted) kill();
		else signal?.addEventListener("abort", kill, { once: true });
	});

	const deletedForks: string[] = [];
	try {
		rmSync(branchFile, { force: true });
		deletedForks.push(branchFile);
	} catch {}

	return { exitCode, final, stderr, rawStdout, deletedForks, usedModel, usage, branchFile };
}

const Params = Type.Object({
	query: Type.String({ description: "Question to answer from a past Pi session." }),
	cwd: Type.Optional(Type.String({ description: "Restrict search to sessions from this cwd/project folder." })),
	sinceHours: Type.Optional(Type.Number({ description: "Only consider sessions modified within the last N hours." })),
	sessionHint: Type.Optional(Type.String({ description: "Optional extra text to help find the right session." })),
	session: Type.Optional(Type.String({ description: "Exact session file path to ask. Skips search." })),
	model: Type.Optional(Type.String({ description: "Model for the disposable fork. Defaults to current-codex-provider/gpt-5.4-mini." })),
	thinking: Type.Optional(Type.String({ description: "Thinking level for the disposable fork. Default: low." })),
	limit: Type.Optional(Type.Number({ description: "Number of candidate sessions to inspect during search. Default: 5." })),
	dryRun: Type.Optional(Type.Boolean({ description: "Only show candidate sessions; do not fork or ask." })),
});

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "ask_past_session",
		label: "Ask Past Session",
		description: "Ask a disposable fork of a past Pi session a focused question, then delete the fork so current context stays small.",
		parameters: Params,
		async execute(_id, params, signal, onUpdate, ctx) {
			const model = codexModel(ctx.model?.provider, params.model);
			const thinking = params.thinking?.trim() || "low";
			let candidates: SessionCandidate[];
			if (params.session?.trim()) {
				const file = normalizePath(params.session);
				const candidate = buildCandidate(file, params.query, undefined, undefined, params.sessionHint);
				const header = fileHeader(file);
				if (!header) throw new Error(`Invalid session file: ${file}`);
				candidates = [candidate ?? { file, id: String(header.id ?? ""), cwd: header.cwd, timestamp: String(header.timestamp ?? ""), modifiedMs: statSync(file).mtimeMs, score: 0, matches: [] }];
			} else {
				candidates = findCandidates(params);
			}
			if (candidates.length === 0) return { content: [{ type: "text", text: "No matching past sessions found." }], details: { candidates: [] } };
			const candidate = candidates[0];
			const candidateText = candidates.map((c, i) => `${i + 1}. ${c.id || c.file}\n   cwd: ${c.cwd}\n   file: ${c.file}\n   score: ${c.score}\n   matches: ${c.matches.join(" | ") || "(none)"}`).join("\n\n");
			if (params.dryRun) {
				return { content: [{ type: "text", text: `Candidate sessions:\n\n${candidateText}` }], details: { candidates } };
			}
			onUpdate?.({ content: [{ type: "text", text: `Asking disposable fork of ${candidate.id || candidate.file} with ${model}...` }], details: { candidate, model, thinking } });
			const result = await runForkedOracle(candidate, params.query, model, thinking, signal);
			if (result.exitCode !== 0 && !result.final) {
				throw new Error(`Past-session oracle failed with exit ${result.exitCode}: ${result.stderr.trim() || "no stderr"}`);
			}
			const text = [
				result.final || "No answer was produced.",
				"",
				`Source: ${candidate.file}`,
				`Model: ${result.usedModel}`,
				`Fork cleanup: deleted ${result.deletedForks.length} file${result.deletedForks.length === 1 ? "" : "s"}`,
			].join("\n");
			return {
				content: [{ type: "text", text }],
				details: {
					candidate,
					candidates,
					model: result.usedModel,
					usage: result.usage,
					exitCode: result.exitCode,
					deletedForks: result.deletedForks,
					stderr: result.stderr,
				},
			};
		},
	});
}

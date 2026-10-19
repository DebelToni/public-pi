import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { resolveSessionReference, UPSTREAM_SESSION_REFS_ENV } from "../lib/upstream-session-refs.js";
import { getPiInvocation, isForcedPiSession, piChildEnvironment, subagentModel } from "../lib/pi-subprocess.js";
import {
	runBoundedProcess,
	SESSION_SOURCE_PATH_ENV,
	SessionStoreClient,
	type CatalogEntry,
	type CatalogSession,
	type EntryRef,
} from "../lib/session-store-client.js";

const DEFAULT_MODEL_ID = "gpt-6-luna";
const CODEX_ACCOUNTS_EXTENSION = join(getAgentDir(), "extensions", "codex-accounts", "index.ts");
const SEARCH_SESSION_EXTENSION = join(getAgentDir(), "extensions", "search-session", "index.ts");
const ASK_SESSION_EXTENSION = join(getAgentDir(), "extensions", "ask-past-session", "index.ts");
const MAX_PROMPT_QUERY_CHARS = 4000;
const ORACLE_TIMEOUT_MS = 2 * 60 * 1000;
const CONTEXT_TIMEOUT_MS = 3 * 60 * 1000;
const PARTIAL_WARNING = "WARNING: Session catalog coverage is partial; failed or stale sources were excluded, so discovery is incomplete.";
const ANSWER_BYTES = 40 * 1024;

function boundedAnswer(answer: string) {
	const bytes = Buffer.from(answer);
	if (bytes.length <= ANSWER_BYTES) return answer;
	let end = ANSWER_BYTES - 90;
	while (end > 0 && (bytes[end] & 0b1100_0000) === 0b1000_0000) end--;
	return `${bytes.subarray(0, end).toString("utf8")}\n\n[Answer truncated at 40 KiB; narrow the question.]`;
}

type SessionCandidate = CatalogSession & { file: string };

type JsonEvent = {
	type?: string;
	message?: Message;
};

function assistantText(message: AssistantMessage) {
	return message.content.filter((part: any) => part?.type === "text").map((part: any) => part.text).join("\n").trim();
}

function codexModel(currentProvider: string | undefined, requested: string | undefined) {
	if (requested?.trim()) return requested.trim();
	const provider = currentProvider === "openai-codex" || currentProvider?.startsWith("codex-") ? currentProvider : "openai-codex";
	return `${provider}/${DEFAULT_MODEL_ID}`;
}

function formatRef(ref: EntryRef | undefined, fallbackId?: string) {
	return JSON.stringify(ref ?? { id: fallbackId ?? null });
}

function candidateEvidence(candidate: SessionCandidate) {
	const matches = candidate.matches?.length ? candidate.matches : [candidate];
	return matches.map((match) => `entryRef=${formatRef(match.matchedEntryRef, match.matchedEntryId)} role=${match.matchedRole ?? "unknown"}\n${match.excerpt ?? ""}`).join("\n");
}

function shortSearchQuery(query: string) {
	const terms = [...query.matchAll(/[\p{L}\p{N}_-]+/gu)].map(([text], index) => ({ text, index }));
	if (terms.length < 3) return undefined;
	const ranked = terms.filter(({ text }) => text.length >= 3).map((term) => ({ ...term,
		score: /[a-z][A-Z]|[A-Z][a-z].*[A-Z]|^[A-Z]{2,}$/u.test(term.text) ? 3 : /^[A-Z]/u.test(term.text) ? 1 : 0,
	})).sort((a, b) => b.score - a.score || b.text.length - a.text.length);
	const selected = ranked.filter((term, index) => ranked.findIndex((value) => value.text.toLowerCase() === term.text.toLowerCase()) === index).slice(0, 2);
	return selected.length === 2 ? selected.sort((a, b) => a.index - b.index).map(({ text }) => text).join(" ") : undefined;
}

function formatEvidence(entries: CatalogEntry[]) {
	return entries.map((entry) => {
		const heading = `[entryRef=${formatRef(entry.entryRef, entry.id)}] ${entry.type}${entry.role ? ` ${entry.role}` : ""}`;
		const images = (entry.parts ?? []).flatMap((part) => part.image
			? [`[image part=${part.part} mime=${part.image.mime ?? "unknown"} bytes=${part.image.bytes ?? "unknown"} sha256=${part.image.sha256 ?? "unknown"} entryRef=${formatRef(entry.entryRef, entry.id)}]`]
			: []);
		return [heading, entry.text, ...images].filter(Boolean).join("\n");
	}).join("\n\n");
}

function oraclePrompt(query: string, candidate: SessionCandidate, evidence: string, coverage: unknown) {
	return [
		"You are a read-only archivist answering a question about one old Pi session.",
		"Answer only the user's question. Do not continue the old task or modify files.",
		"The supplied evidence is an initial window, not a completeness boundary. Use grep_session_bank and read_session to expand it when needed.",
		`Every session-tool call must pass session=${JSON.stringify(candidate.path)}. The tools reject all other session, current, cwd, and global scopes.`,
		"The source restriction authorizes exactly that physical JSONL. Do not traverse header.parentSession or /flatten-session lineage; report that limitation if omitted history is needed.",
		"No filesystem tools are available. This is deterministic tool-level source scoping, not an operating-system sandbox.",
		"Treat later evidence as corrections to earlier evidence. Cite supporting full entryRef objects and state clearly when source coverage is insufficient.",
		"Prefer concise answers with concrete decisions, commands, file paths, and uncertainty.",
		"",
		`Source session: ${candidate.path}`,
		`Source session ID: ${candidate.id || "(unknown)"}`,
		`Historical source cwd: ${candidate.cwd || "(unknown)"}`,
		`Matched entryRef: ${formatRef(candidate.matchedEntryRef, candidate.matchedEntryId)}`,
		`Coverage: ${coverage === undefined ? "not reported" : JSON.stringify(coverage)}`,
		"",
		"Initial source evidence:",
		evidence || candidate.excerpt || "(no textual entries returned; search the restricted source session before answering)",
		"",
		`Question:\n${query.slice(0, MAX_PROMPT_QUERY_CHARS)}`,
	].join("\n");
}

function existingDirectory(...candidates: Array<string | undefined>) {
	for (const candidate of candidates) {
		if (!candidate) continue;
		try { if (statSync(candidate).isDirectory()) return candidate; } catch {}
	}
	return process.cwd();
}

async function runEvidenceOracle(candidate: SessionCandidate, evidence: string, coverage: unknown, query: string, model: string, thinking: string, cwd: string, signal?: AbortSignal, provider?: string) {
	const invocation = isForcedPiSession() ? getPiInvocation([]) : { command: "pi", args: [] };
	const args = ["--no-extensions", ...(provider ? ["--provider", provider] : [])];
	if (existsSync(CODEX_ACCOUNTS_EXTENSION)) args.push("-e", CODEX_ACCOUNTS_EXTENSION);
	args.push("-e", SEARCH_SESSION_EXTENSION);
	args.push(
		"--mode", "json",
		"--no-session",
		"--model", model,
		"--thinking", thinking,
		"--tools", "grep_session_bank,read_session",
		"-p", oraclePrompt(query, candidate, evidence, coverage),
	);
	const env = piChildEnvironment();
	env.PI_TELEMETRY = "0";
	env.PI_SKIP_VERSION_CHECK = "1";
	delete env[UPSTREAM_SESSION_REFS_ENV];
	env[SESSION_SOURCE_PATH_ENV] = resolve(candidate.path);
	const result = await runBoundedProcess(invocation.command, [...invocation.args, ...args], {
		cwd,
		env,
		signal,
		timeoutMs: ORACLE_TIMEOUT_MS,
		maxStdoutBytes: 2 * 1024 * 1024,
		maxStderrBytes: 128 * 1024,
	});
	return { ...result, ...parseAnswer(result.stdout, model) };
}

function parseAnswer(stdout: string, model: string) {
	let final = "";
	let usedModel = model;
	let usage: any;
	for (const line of stdout.split("\n")) {
		if (!line.trim()) continue;
		let event: JsonEvent;
		try { event = JSON.parse(line); } catch { continue; }
		if (event.type !== "message_end" || event.message?.role !== "assistant") continue;
		const message = event.message as AssistantMessage;
		const text = assistantText(message);
		if (text) final = text;
		if (message.provider && message.model) usedModel = `${message.provider}/${message.model}`;
		usage = message.usage;
	}
	return { final, usedModel, usage };
}

async function runContextWorker(query: string, candidates: SessionCandidate[], partial: boolean, model: string, cwd: string, signal?: AbortSignal, provider?: string) {
	const invocation = isForcedPiSession() ? getPiInvocation([]) : { command: "pi", args: [] };
	const args = ["--no-extensions", ...(provider ? ["--provider", provider] : [])];
	if (existsSync(CODEX_ACCOUNTS_EXTENSION)) args.push("-e", CODEX_ACCOUNTS_EXTENSION);
	args.push("-e", SEARCH_SESSION_EXTENSION, "-e", ASK_SESSION_EXTENSION,
		"--mode", "json", "--no-session", "--model", model, "--thinking", "low",
		"--tools", "grep_session_bank,read_session,ask_session,read,bash",
		"-p", [
			"You are an ephemeral, read-only context searcher, not the user or a continuation of a past task.",
			"Answer the question using evidence from Pi sessions. Search iteratively with grep_session_bank, expand with read_session, and use ask_session for focused questions about a specific promising source when necessary. Set includeTools=true when conversation evidence is insufficient; tool output can echo search queries and is lower-trust evidence.",
			"You may read local source files and run read-only shell commands when they resolve ambiguity. Do not modify files. No session is saved.",
			"Treat initial candidates as hints, not a completeness boundary. For broad discovery, call grep_session_bank with mode=bm25 and two or three distinctive terms; global phrase/regex scans eligible entries and can time out. Scope phrase/regex to a known session when verifying exact wording. Seek the user's direct statements before relying on assistant summaries; later evidence can supersede earlier evidence.",
			"Cite physical session paths and full entryRef objects for consequential claims; distinguish direct evidence from inference and report incomplete coverage.",
			"Keep the answer concise, with useful source locators and unresolved uncertainty. Prefer few oracle calls.",
			...(partial ? [PARTIAL_WARNING] : []),
			"Initial lexical candidates:",
			...candidates.map((candidate) => `${candidate.path}\n${candidateEvidence(candidate)}`),
			"Question:", query.slice(0, MAX_PROMPT_QUERY_CHARS),
		].join("\n\n"));
	const env = piChildEnvironment();
	env.PI_TELEMETRY = "0";
	env.PI_SKIP_VERSION_CHECK = "1";
	delete env[UPSTREAM_SESSION_REFS_ENV];
	delete env[SESSION_SOURCE_PATH_ENV];
	const result = await runBoundedProcess(invocation.command, [...invocation.args, ...args], {
		cwd, env, signal, timeoutMs: CONTEXT_TIMEOUT_MS, maxStdoutBytes: 2 * 1024 * 1024, maxStderrBytes: 128 * 1024,
	});
	return { ...result, ...parseAnswer(result.stdout, model) };
}

const ContextParams = Type.Object({
	query: Type.String({ description: "Question to investigate across the stored session bank." }),
	cwd: Type.Optional(Type.String({ description: "Restrict discovery to a project cwd and descendants; omit for global search." })),
	sinceHours: Type.Optional(Type.Number({ minimum: 0, description: "Restrict initial lexical candidates to recent sessions." })),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, description: "Initial lexical candidate count, default 5." })),
	dryRun: Type.Optional(Type.Boolean({ description: "Show initial lexical candidates only; do not launch a model." })),
});

const Params = Type.Object({
	query: Type.String({ description: "Question to answer from a past Pi session." }),
	session: Type.String({ description: "Required exact session ID (from a fan-in handoff) or physical JSONL path. Never discovers other sessions." }),
	model: Type.Optional(Type.String({ description: "Model for the evidence oracle. Defaults to current-codex-provider/gpt-6-luna." })),
	thinking: Type.Optional(Type.String({ description: "Thinking level for the evidence oracle. Default: low." })),
	dryRun: Type.Optional(Type.Boolean({ description: "Inspect initial matches without launching the evidence oracle." })),
});

export default function (pi: ExtensionAPI) {
	const client = new SessionStoreClient();
	const definition: any = {
		name: "ask_session",
		label: "Ask Session",
		description: "Ask a focused question about one REQUIRED physical session path (or a mapped fan-in session ID). A fresh ephemeral Luna child can grep/read only that source and returns a cited answer; no cross-session discovery. Use search_context when the source is unknown.",
		parameters: Params,
		async execute(_id: string, params: any, signal: AbortSignal | undefined, onUpdate: any, ctx: any) {
			if (!params.query?.trim()) throw new Error("Question cannot be empty.");
			if (!params.session?.trim()) throw new Error("ask_session requires one exact source session.");
			const target = resolveSessionReference(params.session);
			if (process.env[SESSION_SOURCE_PATH_ENV] && resolve(process.env[SESSION_SOURCE_PATH_ENV]) !== resolve(target.filePath)) throw new Error("This evidence child cannot ask about another source session.");
			onUpdate?.({ content: [{ type: "text", text: `Checking source-session catalog freshness for ${target.filePath}...` }], details: {} });
			const freshness = await client.reconcile({ path: target.filePath }, signal);
			const response = await client.search(params.query, {
				path: target.filePath, limit: 1, matches: 1, mode: "bm25", role: "conversation",
			}, signal);
			const discoveryCoverage = response.coverage;
			const match = response.results[0];
			const candidates: SessionCandidate[] = [{
				...(match ?? {}), path: target.filePath, file: target.filePath,
				id: target.sessionId || match?.id || "", cwd: match?.cwd || ctx.cwd || process.cwd(),
			}];
			const candidateText = candidates.map((candidate, index) => [
				`${index + 1}. ${candidate.name || candidate.firstMessage || candidate.id || candidate.path}`,
				`   cwd: ${candidate.cwd || "(unknown)"}`,
				`   file: ${candidate.path}`,
				candidate.matchedEntryId ? `   matchedEntryRef: ${formatRef(candidate.matchedEntryRef, candidate.matchedEntryId)}${candidate.matchedRole ? ` (${candidate.matchedRole})` : ""}` : undefined,
				`   excerpt: ${candidate.excerpt || "(none)"}`,
			].filter(Boolean).join("\n")).join("\n\n");
			if (params.dryRun) {
				const heading = "Initial matches within the exact session:";
				return { content: [{ type: "text", text: `${heading}\n\n${candidateText}` }], details: { candidates, freshness, coverage: discoveryCoverage } };
			}

			const candidate = candidates[0];
			const source = await client.read({
				path: candidate.path,
				entry: candidate.matchedEntryId,
				byteStart: candidate.matchedEntryRef?.byteStart,
				before: candidate.matchedEntryId ? 12 : 48,
				after: candidate.matchedEntryId ? 36 : 0,
				limit: 64,
				maxChars: 40_000,
			}, signal);
			const evidence = formatEvidence(source.entries);
			const sourceCoverage = { coverage: source.coverage, leafRef: source.leafRef, leafSelection: source.leafSelection };
			let model = codexModel(ctx.model?.provider, params.model);
			const thinking = params.thinking?.trim() || "low";
			const selection = subagentModel(model, ctx);
			model = selection.model!;
			const oracleCwd = existingDirectory(candidate.cwd, ctx.cwd, process.cwd());
			onUpdate?.({
				content: [{ type: "text", text: `Asking source-scoped evidence oracle for ${candidate.id || candidate.path} with ${model}...` }],
				details: { candidate, model, thinking, cwd: oracleCwd, entryCount: source.entries.length, coverage: sourceCoverage },
			});
			const result = await runEvidenceOracle(candidate, evidence, sourceCoverage, params.query, model, thinking, oracleCwd, signal, selection.provider);
			if (result.code !== 0) {
				throw new Error(`Past-session evidence oracle failed with exit ${result.code}: ${result.stderr.trim() || "no stderr"}`);
			}
			return {
				usage: result.usage,
				content: [{
					type: "text",
					text: [
						boundedAnswer(result.final || "No answer was produced."),
						"",
						`Source: ${candidate.path}`,
						`Initial evidence entries: ${source.entries.length}`,
						`Model: ${result.usedModel}`,
					].join("\n"),
				}],
				details: {
					candidate,
					candidates,
					model: result.usedModel,
					usage: result.usage,
					exitCode: result.code,
					stderr: result.stderr,
					coverage: source.coverage,
					leafRef: source.leafRef,
					leafSelection: source.leafSelection,
					freshness,
					discoveryCoverage,
					oracleCwd,
					oracleMode: "source-restricted-expandable-evidence",
				},
			};
		},
	};
	pi.registerTool(definition);

	pi.registerTool({
		name: "search_context",
		label: "Search Context",
		description: "Investigate an open-ended question across stored Pi sessions. Launches a fresh ephemeral Luna/low agent for short BM25 discovery queries, scoped evidence reads, and optional exact-session oracles. Slower than direct grep; returns a sourced synthesis. Use grep_current_session for this conversation.",
		parameters: ContextParams,
		async execute(_id, params, signal, onUpdate, ctx) {
			if (!params.query?.trim()) throw new Error("Question cannot be empty.");
			if (process.env[SESSION_SOURCE_PATH_ENV]) throw new Error("A source-restricted child cannot search context across sessions.");
			const cwd = params.cwd ? resolve(params.cwd) : undefined;
			onUpdate?.({ content: [{ type: "text", text: `Checking ${cwd ? "project" : "global"} session catalog freshness...` }], details: {} });
			const freshness = await client.reconcile(cwd ? { cwd, tree: true } : { all: true }, signal, { allowIncomplete: true });
			let partial = freshness?.scopeComplete === false;
			const searchOptions = {
				cwd, tree: Boolean(cwd), limit: Math.max(1, Math.min(20, params.limit ?? 5)),
				matches: 1, mode: "bm25" as const, role: "conversation",
				sinceHours: params.sinceHours, allowPartial: true,
			};
			let response = await client.search(params.query, searchOptions, signal);
			const queriesTried = [params.query];
			const shorter = !response.results.length && shortSearchQuery(params.query);
			if (shorter) {
				queriesTried.push(shorter);
				response = await client.search(shorter, { ...searchOptions, matches: 3 }, signal);
			}
			partial ||= response.coverage?.scopeComplete === false;
			const candidates = response.results.map((row) => ({ ...row, file: row.path }));
			const candidateText = candidates.map((row, index) => [
				`${index + 1}. ${row.name || row.firstMessage || row.id || row.path}`,
				`session: ${row.id || "(unknown)"}`, `path: ${row.path}`,
				candidateEvidence(row),
			].join("\n")).join("\n\n");
			if (params.dryRun) return {
				content: [{ type: "text", text: [partial ? PARTIAL_WARNING : "Initial lexical candidates:", candidateText || "No initial candidates."].join("\n\n") }],
				details: { candidates, queriesTried, partial, freshness, coverage: response.coverage },
			};
			let model = codexModel(ctx.model?.provider, undefined);
			const selection = subagentModel(model, ctx);
			model = selection.model!;
			const workerCwd = existingDirectory(cwd, ctx.cwd, process.cwd());
			onUpdate?.({ content: [{ type: "text", text: `Searching session bank with ephemeral ${model}...` }], details: { candidates: candidates.length, partial } });
			const result = await runContextWorker(params.query, candidates, partial, model, workerCwd, signal, selection.provider);
			if (result.code !== 0) throw new Error(`Context search worker failed with exit ${result.code}: ${result.stderr.trim() || "no stderr"}`);
			return {
				content: [{ type: "text", text: [partial ? PARTIAL_WARNING : "", boundedAnswer(result.final || "No answer was produced.")].filter(Boolean).join("\n\n") }],
				details: { candidates, queriesTried, partial, freshness, coverage: response.coverage, model: result.usedModel, usage: result.usage, exitCode: result.code },
				usage: result.usage,
			};
		},
	});
}

import type { AssistantMessage } from "@earendil-works/pi-ai";
import { complete, type ThinkingLevel } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { recordInternalUsage } from "../lib/internal-usage.js";

const CUSTOM_TYPE = "session-kb";
const TOOL_NAME = "session_kb_recall";
const CONFIG_PATH = join(getAgentDir(), "session-kb.json");
const SCHEMA_VERSION = 1;

type Config = {
	defaultActive?: boolean;
	activateAfterCompactions?: number;
	provider?: string;
	model?: string | { provider?: string; model?: string };
	thinkingLevel?: ThinkingLevel;
	maxDeltaChars?: number;
	maxKbChars?: number;
	maxOutputTokens?: number;
	snapshotEveryPatches?: number;
	maxObservedEvents?: number;
};

type Evidence = { entryId?: string; quote?: string };
type Shelf = { id: string; title: string; summary?: string; tags?: string[] };
type Card = {
	id: string;
	shelf?: string;
	kind: "fact" | "decision" | "constraint" | "procedure" | "issue" | "artifact" | "question";
	title: string;
	body: string;
	status?: "active" | "proposed" | "superseded" | "resolved";
	confidence?: "low" | "medium" | "high";
	evidence?: Evidence[];
	updatedAt?: string;
};
type ChronicleEvent = {
	id: string;
	category: "user" | "agent" | "tool" | "subagent" | "system";
	title: string;
	body: string;
	evidence?: Evidence[];
	related?: string[];
	createdAt?: string;
};
type Artifact = {
	id: string;
	kind: "file" | "command" | "subagent" | "reference";
	path?: string;
	title: string;
	body?: string;
	evidence?: Evidence[];
	cards?: string[];
	updatedAt?: string;
};
type Thread = { from: string; to: string; type: "related" | "updates" | "causes" | "supports"; note?: string };
type KnowledgeBase = { schema: 1; overview: string; shelves: Shelf[]; cards: Card[]; chronicle: ChronicleEvent[]; artifacts: Artifact[]; threads: Thread[] };

type WorkerOp =
	| { op: "set_overview"; overview?: string }
	| ({ op: "upsert_shelf" } & Partial<Shelf>)
	| ({ op: "upsert_card" } & Partial<Card>)
	| ({ op: "append_event" } & Partial<ChronicleEvent>)
	| ({ op: "upsert_artifact" } & Partial<Artifact>)
	| ({ op: "link" } & Partial<Thread>);

type WorkerPatch = { ops?: WorkerOp[] };

type ObservedEvent = { kind: string; timestamp: string; text: string };

type Runtime = {
	active: boolean;
	initialized: boolean;
	seq: number;
	patchesSinceSnapshot: number;
	lastProcessedEntryId?: string;
	startedAt?: string;
	lastRunAt?: string;
	lastError?: string;
	running: boolean;
	pending: number;
	closed: boolean;
	kb: KnowledgeBase;
};

function emptyKb(): KnowledgeBase {
	return { schema: SCHEMA_VERSION, overview: "", shelves: [], cards: [], chronicle: [], artifacts: [], threads: [] };
}

let runtime: Runtime = {
	active: false,
	initialized: false,
	seq: 0,
	patchesSinceSnapshot: 0,
	running: false,
	pending: 0,
	closed: false,
	kb: emptyKb(),
};
let queue: Promise<void> = Promise.resolve();
let abortController: AbortController | undefined;
let observedEvents: ObservedEvent[] = [];

function readJson(path: string): any {
	try {
		if (!existsSync(path)) return undefined;
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return undefined;
	}
}

function config(): Required<Config> {
	const raw = readJson(CONFIG_PATH) ?? {};
	const thinkingLevel = ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(raw.thinkingLevel)
		? raw.thinkingLevel as ThinkingLevel
		: "medium";
	return {
		defaultActive: !!raw.defaultActive,
		activateAfterCompactions: Math.max(1, Number(raw.activateAfterCompactions ?? 1)),
		provider: typeof raw.provider === "string" ? raw.provider : "openai-codex",
		model: raw.model ?? "gpt-5.6-sol",
		thinkingLevel,
		maxDeltaChars: Math.max(12_000, Number(raw.maxDeltaChars ?? 60_000)),
		maxKbChars: Math.max(12_000, Number(raw.maxKbChars ?? 80_000)),
		maxOutputTokens: Math.max(1000, Number(raw.maxOutputTokens ?? 6000)),
		snapshotEveryPatches: Math.max(1, Number(raw.snapshotEveryPatches ?? 10)),
		maxObservedEvents: Math.max(0, Number(raw.maxObservedEvents ?? 80)),
	};
}

function modelConfig(cfg = config()) {
	const raw = cfg.model;
	if (typeof raw === "object" && raw) return { provider: raw.provider ?? cfg.provider, model: raw.model ?? "gpt-5.6-sol" };
	if (typeof raw === "string" && raw.includes("/")) {
		const [provider, ...rest] = raw.split("/");
		return { provider: provider || cfg.provider, model: rest.join("/") || "gpt-5.6-sol" };
	}
	return { provider: cfg.provider, model: typeof raw === "string" ? raw : "gpt-5.6-sol" };
}

function clean(s: unknown, max = 4000) {
	return String(s ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

function textOfContent(content: any): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((part) => {
		if (typeof part === "string") return part;
		if (part?.type === "text") return part.text ?? "";
		if (part?.type === "toolCall") return `[tool:${part.name}] ${JSON.stringify(part.arguments ?? {})}`;
		if (part?.type === "image") return "[image]";
		return "";
	}).filter(Boolean).join("\n");
}

function textOfToolContent(content: any): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((part) => part?.type === "text" ? part.text ?? "" : part?.type === "image" ? "[image]" : "").filter(Boolean).join("\n");
}

function headTail(text: string, maxChars: number) {
	if (text.length <= maxChars) return text;
	const headChars = Math.floor(maxChars * 0.22);
	const tailChars = Math.max(1000, maxChars - headChars - 160);
	return `${text.slice(0, headChars)}\n\n… [middle truncated] …\n\n${text.slice(-tailChars)}`;
}

function slug(value: string, prefix = "id") {
	const s = clean(value, 80).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
	return s || `${prefix}-${Math.random().toString(36).slice(2, 8)}`;
}

function uniqueId<T extends { id: string }>(items: T[], base: string) {
	let id = base;
	let i = 2;
	const ids = new Set(items.map((item) => item.id));
	while (ids.has(id)) id = `${base}-${i++}`;
	return id;
}

function normalizeId(value: unknown, fallbackTitle: unknown, prefix: string, existing: Array<{ id: string }>, allowExisting = true) {
	const raw = clean(value || fallbackTitle, 80).toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^-|-$/g, "");
	const id = raw || slug(String(fallbackTitle || prefix), prefix);
	if (allowExisting || !existing.some((item) => item.id === id)) return id;
	return uniqueId(existing, id);
}

function evidence(value: unknown): Evidence[] {
	if (!Array.isArray(value)) return [];
	return value.slice(0, 8).map((item) => ({ entryId: clean((item as any)?.entryId, 80) || undefined, quote: clean((item as any)?.quote, 500) || undefined })).filter((item) => item.entryId || item.quote);
}

function stringList(value: unknown, max = 12) {
	return Array.isArray(value) ? value.map((v) => clean(v, 100)).filter(Boolean).slice(0, max) : [];
}

function applyOps(kb: KnowledgeBase, ops: WorkerOp[]) {
	const now = new Date().toISOString();
	for (const op of ops) {
		if (!op || typeof op !== "object") continue;
		if (op.op === "set_overview") {
			if (clean(op.overview, 4000)) kb.overview = clean(op.overview, 4000);
			continue;
		}
		if (op.op === "upsert_shelf") {
			const title = clean(op.title, 160);
			if (!title) continue;
			const id = normalizeId(op.id, title, "shelf", kb.shelves);
			const next: Shelf = { id, title, summary: clean(op.summary, 800) || undefined, tags: stringList(op.tags, 10) };
			const idx = kb.shelves.findIndex((x) => x.id === id);
			if (idx >= 0) kb.shelves[idx] = { ...kb.shelves[idx], ...next };
			else kb.shelves.push(next);
			continue;
		}
		if (op.op === "upsert_card") {
			const title = clean(op.title, 180);
			const body = clean(op.body, 2500);
			if (!title || !body) continue;
			const id = normalizeId(op.id, title, "card", kb.cards);
			const kind = ["fact", "decision", "constraint", "procedure", "issue", "artifact", "question"].includes(String(op.kind)) ? op.kind as Card["kind"] : "fact";
			const status = ["active", "proposed", "superseded", "resolved"].includes(String(op.status)) ? op.status as Card["status"] : "active";
			const confidence = ["low", "medium", "high"].includes(String(op.confidence)) ? op.confidence as Card["confidence"] : undefined;
			const next: Card = { id, shelf: clean(op.shelf, 100) || undefined, kind, title, body, status, confidence, evidence: evidence(op.evidence), updatedAt: now };
			const idx = kb.cards.findIndex((x) => x.id === id);
			if (idx >= 0) kb.cards[idx] = { ...kb.cards[idx], ...next };
			else kb.cards.push(next);
			continue;
		}
		if (op.op === "append_event") {
			const title = clean(op.title, 180);
			const body = clean(op.body, 2200);
			if (!title || !body) continue;
			const category = ["user", "agent", "tool", "subagent", "system"].includes(String(op.category)) ? op.category as ChronicleEvent["category"] : "system";
			const id = normalizeId(op.id, title, "event", kb.chronicle, false);
			const next: ChronicleEvent = { id, category, title, body, evidence: evidence(op.evidence), related: stringList(op.related, 12), createdAt: clean(op.createdAt, 40) || now };
			const idx = kb.chronicle.findIndex((x) => x.id === id);
			if (idx >= 0) kb.chronicle[idx] = { ...kb.chronicle[idx], ...next };
			else kb.chronicle.push(next);
			continue;
		}
		if (op.op === "upsert_artifact") {
			const title = clean(op.title || op.path, 180);
			if (!title) continue;
			const id = normalizeId(op.id, title, "artifact", kb.artifacts);
			const kind = ["file", "command", "subagent", "reference"].includes(String(op.kind)) ? op.kind as Artifact["kind"] : "reference";
			const next: Artifact = { id, kind, path: clean(op.path, 500) || undefined, title, body: clean(op.body, 1800) || undefined, evidence: evidence(op.evidence), cards: stringList(op.cards, 16), updatedAt: now };
			const idx = kb.artifacts.findIndex((x) => x.id === id);
			if (idx >= 0) kb.artifacts[idx] = { ...kb.artifacts[idx], ...next };
			else kb.artifacts.push(next);
			continue;
		}
		if (op.op === "link") {
			const from = clean(op.from, 100);
			const to = clean(op.to, 100);
			if (!from || !to || from === to) continue;
			const type = ["related", "updates", "causes", "supports"].includes(String(op.type)) ? op.type as Thread["type"] : "related";
			const next: Thread = { from, to, type, note: clean(op.note, 400) || undefined };
			if (!kb.threads.some((x) => x.from === next.from && x.to === next.to && x.type === next.type)) kb.threads.push(next);
		}
	}
}

function compactKb(kb: KnowledgeBase, maxChars: number) {
	const clone: KnowledgeBase = JSON.parse(JSON.stringify(kb));
	let text = JSON.stringify(clone);
	while (text.length > maxChars && clone.chronicle.length > 40) {
		clone.chronicle.splice(0, Math.ceil(clone.chronicle.length * 0.15));
		text = JSON.stringify(clone);
	}
	while (text.length > maxChars && clone.artifacts.length > 40) {
		clone.artifacts.splice(0, Math.ceil(clone.artifacts.length * 0.15));
		text = JSON.stringify(clone);
	}
	return headTail(JSON.stringify(clone, null, 2), maxChars);
}

function entryText(entry: any) {
	if (!entry || entry.customType === CUSTOM_TYPE) return "";
	if (entry.type === "message") {
		const msg = entry.message ?? {};
		const role = msg.role ?? "unknown";
		const tool = msg.toolName ? ` tool=${msg.toolName}` : "";
		const text = role === "toolResult" ? textOfToolContent(msg.content) : textOfContent(msg.content);
		return `ENTRY ${entry.id} ${entry.timestamp} message role=${role}${tool}\n${headTail(String(text ?? "").replace(/\s+/g, " ").trim(), 12_000)}`;
	}
	if (entry.type === "compaction") return `ENTRY ${entry.id} ${entry.timestamp} compaction tokensBefore=${entry.tokensBefore}\n${headTail(String(entry.summary ?? "").replace(/\s+/g, " ").trim(), 12_000)}`;
	if (entry.type === "branch_summary") return `ENTRY ${entry.id} ${entry.timestamp} branch_summary from=${entry.fromId}\n${headTail(String(entry.summary ?? "").replace(/\s+/g, " ").trim(), 8000)}`;
	if (entry.type === "model_change") return `ENTRY ${entry.id} ${entry.timestamp} model_change ${entry.provider}/${entry.modelId}`;
	if (entry.type === "thinking_level_change") return `ENTRY ${entry.id} ${entry.timestamp} thinking_level_change ${entry.thinkingLevel}`;
	if (entry.type === "session_info") return `ENTRY ${entry.id} ${entry.timestamp} session_info name=${entry.name ?? ""}`;
	if (entry.type === "label") return `ENTRY ${entry.id} ${entry.timestamp} label target=${entry.targetId} label=${entry.label ?? ""}`;
	return "";
}

function branchEntries(ctx: ExtensionContext) {
	return ctx.sessionManager.getBranch().filter((entry: any) => !(entry.type === "custom" && entry.customType === CUSTOM_TYPE));
}

function entriesSince(ctx: ExtensionContext, id?: string) {
	const entries = branchEntries(ctx);
	if (!id) return entries;
	const idx = entries.findIndex((entry: any) => entry.id === id);
	return idx === -1 ? entries : entries.slice(idx + 1);
}

function latestEntryId(ctx: ExtensionContext) {
	const entries = branchEntries(ctx);
	return entries[entries.length - 1]?.id;
}

function countCompactions(ctx: ExtensionContext) {
	return branchEntries(ctx).filter((entry: any) => entry.type === "compaction").length;
}

function serializeEntries(entries: any[], maxChars: number) {
	const text = entries.map(entryText).filter(Boolean).join("\n\n---\n\n");
	return headTail(text, maxChars);
}

function responseText(response: AssistantMessage) {
	return response.content.filter((c: any) => c?.type === "text").map((c: any) => c.text).join("\n").trim();
}

function parseJson(text: string): WorkerPatch {
	const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim();
	try { return JSON.parse(cleaned); } catch {}
	const start = cleaned.indexOf("{");
	const end = cleaned.lastIndexOf("}");
	if (start !== -1 && end > start) return JSON.parse(cleaned.slice(start, end + 1));
	throw new Error("worker returned non-JSON output");
}

const WORKER_PROMPT = `You are Session Codex, a background knowledge curator for one Pi coding-agent session.

You are NOT the coding agent. Do not answer the user. Do not give advice. Maintain a structured knowledge base from grounded session evidence.

Your output must be only JSON: {"ops": [...]}.

Use these operation shapes only:
- {"op":"set_overview","overview":"..."}
- {"op":"upsert_shelf","id":"topic-id","title":"...","summary":"...","tags":["..."]}
- {"op":"upsert_card","id":"stable-id","shelf":"topic-id","kind":"fact|decision|constraint|procedure|issue|artifact|question","title":"...","body":"...","status":"active|proposed|superseded|resolved","confidence":"low|medium|high","evidence":[{"entryId":"...","quote":"..."}]}
- {"op":"append_event","category":"user|agent|tool|subagent|system","title":"...","body":"...","evidence":[{"entryId":"...","quote":"..."}],"related":["card-id"]}
- {"op":"upsert_artifact","id":"stable-id","kind":"file|command|subagent|reference","path":"...","title":"...","body":"...","evidence":[{"entryId":"...","quote":"..."}],"cards":["card-id"]}
- {"op":"link","from":"id","to":"id","type":"related|updates|causes|supports","note":"..."}

Hierarchy names:
- shelves = broad topics
- cards = durable knowledge
- chronicle = event timeline
- artifacts = files, commands, subagents, references
- threads = relationships

Save durable material:
- user preferences/directives/corrections
- project/session facts and constraints
- decisions, rejected approaches, settled implementation state
- bugs, fixes, commands that mattered, file paths, configs
- subagent outputs as proposed/observed unless confirmed by main-session evidence
- event chronology: user interrupts/corrections, agent starts/finishes tasks, tool failures/aborts, subagent results, compactions

Skip:
- trivial chatter, filler, duplicates, raw giant logs, obvious facts, ungrounded guesses

Rules:
- Every card/event/artifact should include evidence entry ids when possible.
- Prefer updating/superseding existing cards over adding duplicates.
- Use broader categories, not hyper-specific kinds.
- If a fact is uncertain, status=proposed or confidence=low.
- Keep bodies compact and factual.
- Return no markdown and no commentary.`;

async function callWorker(pi: ExtensionAPI, ctx: ExtensionContext, reason: string, deltaEntries: any[], extra = "") {
	const cfg = config();
	const target = modelConfig(cfg);
	const model = ctx.modelRegistry.find(target.provider, target.model);
	if (!model) throw new Error(`Session KB model not found: ${target.provider}/${target.model}`);
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok || !auth.apiKey) throw new Error(`No auth for Session KB model: ${target.provider}/${target.model}`);

	const observations = observedEvents.slice(-cfg.maxObservedEvents).map((event) => `${event.timestamp} ${event.kind}: ${event.text}`).join("\n");
	const prompt = `${WORKER_PROMPT}\n\nReason: ${reason}\nCWD: ${ctx.cwd}\nSession file: ${ctx.sessionManager.getSessionFile() ?? "unknown"}\nLast processed entry: ${runtime.lastProcessedEntryId ?? "none"}\n\nCurrent KB:\n${compactKb(runtime.kb, cfg.maxKbChars)}\n\nObserved live interaction metadata since last successful run:\n${observations || "(none)"}\n\n${extra}\n\nNew session entries:\n${serializeEntries(deltaEntries, cfg.maxDeltaChars) || "(none)"}`;

	abortController = new AbortController();
	const response = await complete(model, { messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }] }, {
		apiKey: auth.apiKey,
		headers: auth.headers,
		env: auth.env,
		maxTokens: cfg.maxOutputTokens,
		reasoning: cfg.thinkingLevel,
		signal: abortController.signal,
	});
	recordInternalUsage(pi, "session-kb", model, response);
	return parseJson(responseText(response));
}

function appendState(pi: ExtensionAPI) {
	pi.appendEntry(CUSTOM_TYPE, { schema: SCHEMA_VERSION, kind: "state", active: runtime.active, startedAt: runtime.startedAt, timestamp: Date.now() });
}

function appendPatch(pi: ExtensionAPI, reason: string, ops: WorkerOp[], toEntryId?: string) {
	const cfg = config();
	runtime.seq++;
	runtime.patchesSinceSnapshot++;
	runtime.lastRunAt = new Date().toISOString();
	if (toEntryId) runtime.lastProcessedEntryId = toEntryId;
	const target = modelConfig(cfg);
	if (!runtime.initialized || runtime.patchesSinceSnapshot >= cfg.snapshotEveryPatches) {
		runtime.initialized = true;
		runtime.patchesSinceSnapshot = 0;
		pi.appendEntry(CUSTOM_TYPE, { schema: SCHEMA_VERSION, kind: "snapshot", seq: runtime.seq, reason, model: `${target.provider}/${target.model}`, lastProcessedEntryId: runtime.lastProcessedEntryId, kb: runtime.kb, timestamp: Date.now() });
		return;
	}
	pi.appendEntry(CUSTOM_TYPE, { schema: SCHEMA_VERSION, kind: "patch", seq: runtime.seq, reason, model: `${target.provider}/${target.model}`, lastProcessedEntryId: runtime.lastProcessedEntryId, ops, timestamp: Date.now() });
}

function enqueue(pi: ExtensionAPI, ctx: ExtensionContext, reason: string, getDelta: () => { entries: any[]; extra?: string }) {
	if (!runtime.active || runtime.closed) return;
	runtime.pending++;
	queue = queue.then(async () => {
		if (!runtime.active || runtime.closed) return;
		runtime.running = true;
		const { entries, extra } = getDelta();
		const toEntryId = entries[entries.length - 1]?.id ?? latestEntryId(ctx);
		if (!entries.length && runtime.initialized) return;
		const patch = await callWorker(pi, ctx, reason, entries, extra);
		const ops = Array.isArray(patch.ops) ? patch.ops.slice(0, 80) : [];
		applyOps(runtime.kb, ops);
		appendPatch(pi, reason, ops, toEntryId);
		observedEvents = [];
		runtime.lastError = undefined;
	}).catch((error) => {
		runtime.lastError = error instanceof Error ? error.message : String(error);
	}).finally(() => {
		runtime.pending = Math.max(0, runtime.pending - 1);
		runtime.running = false;
	});
}

function restore(ctx: ExtensionContext) {
	runtime = { active: false, initialized: false, seq: 0, patchesSinceSnapshot: 0, running: false, pending: 0, closed: false, kb: emptyKb() };
	observedEvents = [];
	for (const entry of ctx.sessionManager.getBranch() as any[]) {
		if (entry.type !== "custom" || entry.customType !== CUSTOM_TYPE) continue;
		const data = entry.data ?? {};
		if (data.schema !== SCHEMA_VERSION) continue;
		if (data.kind === "state") {
			runtime.active = !!data.active;
			runtime.startedAt = typeof data.startedAt === "string" ? data.startedAt : runtime.startedAt;
		} else if (data.kind === "snapshot" && data.kb?.schema === SCHEMA_VERSION) {
			runtime.kb = data.kb as KnowledgeBase;
			runtime.initialized = true;
			runtime.seq = Math.max(runtime.seq, Number(data.seq ?? 0));
			runtime.patchesSinceSnapshot = 0;
			if (typeof data.lastProcessedEntryId === "string") runtime.lastProcessedEntryId = data.lastProcessedEntryId;
		} else if (data.kind === "patch" && Array.isArray(data.ops)) {
			applyOps(runtime.kb, data.ops);
			runtime.initialized = true;
			runtime.seq = Math.max(runtime.seq, Number(data.seq ?? 0));
			runtime.patchesSinceSnapshot++;
			if (typeof data.lastProcessedEntryId === "string") runtime.lastProcessedEntryId = data.lastProcessedEntryId;
		}
	}
	const cfg = config();
	if (!runtime.active && cfg.defaultActive && countCompactions(ctx) >= cfg.activateAfterCompactions) runtime.active = true;
}

function recordObserved(kind: string, text: string) {
	const cfg = config();
	if (!runtime.active || cfg.maxObservedEvents <= 0) return;
	observedEvents.push({ kind, timestamp: new Date().toISOString(), text: clean(text, 1800) });
	if (observedEvents.length > cfg.maxObservedEvents) observedEvents = observedEvents.slice(-cfg.maxObservedEvents);
}

function setRecallToolVisible(pi: ExtensionAPI, visible: boolean) {
	const active = pi.getActiveTools();
	const hasTool = active.includes(TOOL_NAME);
	if (visible && !hasTool) pi.setActiveTools([...active, TOOL_NAME]);
	if (!visible && hasTool) pi.setActiveTools(active.filter((name) => name !== TOOL_NAME));
}

function allRecords(kb = runtime.kb) {
	const out: Array<{ type: string; id: string; text: string; raw: any }> = [];
	for (const item of kb.shelves) out.push({ type: "shelf", id: item.id, text: clean(`${item.title} ${item.summary ?? ""} ${(item.tags ?? []).join(" ")}`, 2000), raw: item });
	for (const item of kb.cards) out.push({ type: "card", id: item.id, text: clean(`${item.title} ${item.kind} ${item.status ?? ""} ${item.body} ${(item.evidence ?? []).map((e) => e.quote ?? "").join(" ")}`, 4000), raw: item });
	for (const item of kb.chronicle) out.push({ type: "event", id: item.id, text: clean(`${item.title} ${item.category} ${item.body} ${(item.evidence ?? []).map((e) => e.quote ?? "").join(" ")}`, 4000), raw: item });
	for (const item of kb.artifacts) out.push({ type: "artifact", id: item.id, text: clean(`${item.title} ${item.kind} ${item.path ?? ""} ${item.body ?? ""} ${(item.evidence ?? []).map((e) => e.quote ?? "").join(" ")}`, 4000), raw: item });
	for (const item of kb.threads) out.push({ type: "thread", id: `${item.from}->${item.to}:${item.type}`, text: clean(`${item.from} ${item.to} ${item.type} ${item.note ?? ""}`, 1000), raw: item });
	return out;
}

function tokens(text: string) {
	return text.toLowerCase().match(/[a-z0-9_][a-z0-9_.-]*/g) ?? [];
}

function regexHints(query: string) {
	const out: RegExp[] = [];
	const patterns = [...query.matchAll(/\/(.+?)\/[a-z]*/g)].map((match) => match[1]);
	for (const match of query.matchAll(/regex(?:es)?\s*[:=]\s*["'`]([^"'`]+)["'`]/gi)) patterns.push(match[1]);
	for (const pattern of patterns.slice(0, 8)) {
		try { out.push(new RegExp(pattern, "i")); } catch {}
	}
	return out;
}

function recallRecords(query: string) {
	const records = allRecords();
	const qTerms = tokens(query);
	const docs = records.map((record) => ({ record, terms: tokens(record.text) }));
	const df = new Map<string, number>();
	for (const term of new Set(qTerms)) df.set(term, docs.filter((d) => d.terms.includes(term)).length);
	const compiled = regexHints(query);
	const avgdl = docs.reduce((sum, d) => sum + d.terms.length, 0) / Math.max(1, docs.length);
	const scored = docs.map((doc) => {
		const tf = new Map<string, number>();
		for (const term of doc.terms) tf.set(term, (tf.get(term) ?? 0) + 1);
		let score = 0;
		for (const term of qTerms) {
			const freq = tf.get(term) ?? 0;
			if (!freq) continue;
			const idf = Math.log(1 + (docs.length - (df.get(term) ?? 0) + 0.5) / ((df.get(term) ?? 0) + 0.5));
			score += idf * (freq * 2.5) / (freq + 1.5 * (1 - 0.75 + 0.75 * doc.terms.length / Math.max(1, avgdl)));
		}
		for (const re of compiled) if (re.test(doc.record.text)) score += 5;
		if (!qTerms.length && !compiled.length) score = 1;
		return { ...doc.record, score };
	}).filter((item) => item.score > 0).sort((a, b) => b.score - a.score).slice(0, 12);
	return scored;
}

function renderRecall(query: string) {
	if (!runtime.active) return "Session KB is stopped. Run /kb start first.";
	if (!runtime.initialized) return runtime.running || runtime.pending ? "Session KB is starting; try again shortly." : "Session KB has no snapshot yet. Run /kb rebuild.";
	const hits = recallRecords(query);
	if (!hits.length) return "No Session KB matches.";
	return `RAW Session KB records; not a synthesized answer.\n\n${hits.map((hit) => `## ${hit.type}:${hit.id} score=${hit.score.toFixed(2)}\n${JSON.stringify(hit.raw, null, 2)}`).join("\n\n")}`;
}

function statusText(ctx: ExtensionContext) {
	const cfg = config();
	const target = modelConfig(cfg);
	return [
		`Session KB: ${runtime.active ? "active" : "stopped"}${runtime.initialized ? " / initialized" : " / empty"}`,
		`Model: ${target.provider}/${target.model} @ ${cfg.thinkingLevel}`,
		`Config: ${CONFIG_PATH}`,
		`Compactions: ${countCompactions(ctx)} (default activation ${cfg.defaultActive ? `on after ${cfg.activateAfterCompactions}` : "off"})`,
		`Seq: ${runtime.seq}; pending: ${runtime.pending}; running: ${runtime.running ? "yes" : "no"}`,
		`Records: shelves=${runtime.kb.shelves.length}, cards=${runtime.kb.cards.length}, events=${runtime.kb.chronicle.length}, artifacts=${runtime.kb.artifacts.length}, threads=${runtime.kb.threads.length}`,
		`Last processed: ${runtime.lastProcessedEntryId ?? "none"}`,
		`Last run: ${runtime.lastRunAt ?? "never"}`,
		runtime.lastError ? `Last error: ${runtime.lastError}` : undefined,
	].filter(Boolean).join("\n");
}

function widget(ctx: ExtensionContext, title: string, body: string) {
	const lines = [`${title}`, "─".repeat(Math.min(80, title.length || 20)), ...body.split("\n").slice(0, 220)];
	ctx.ui.setWidget("session-kb", lines, { placement: "aboveEditor" });
}

function help() {
	return `/kb start        start Session KB and bootstrap in background\n/kb stop         stop background updates for this session\n/kb status       show state and config path\n/kb ls           list shelves/cards/events/artifacts\n/kb grep <query> search raw KB records\n/kb cat <id>     show raw record by id\n/kb rebuild      rebuild from current session branch\n/kb clear        clear the inspection widget`;
}

function listKb() {
	const lines = [runtime.kb.overview ? `overview: ${runtime.kb.overview}` : "overview: (empty)", "", "shelves:", ...runtime.kb.shelves.map((x) => `- ${x.id}: ${x.title}`), "", "cards:", ...runtime.kb.cards.map((x) => `- ${x.id} [${x.kind}/${x.status ?? "active"}] ${x.title}`), "", "chronicle:", ...runtime.kb.chronicle.slice(-80).map((x) => `- ${x.id} [${x.category}] ${x.title}`), "", "artifacts:", ...runtime.kb.artifacts.map((x) => `- ${x.id} [${x.kind}] ${x.path ?? x.title}`)];
	return lines.join("\n");
}

function catRecord(id: string) {
	const found = allRecords().find((record) => record.id === id || `${record.type}:${record.id}` === id);
	return found ? JSON.stringify(found.raw, null, 2) : `No record: ${id}`;
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		restore(ctx);
		setRecallToolVisible(pi, runtime.active);
	});
	pi.on("session_shutdown", async () => {
		runtime.closed = true;
		abortController?.abort();
	});

	pi.on("input", async (event) => {
		recordObserved("input", `${event.source}${event.streamingBehavior ? `/${event.streamingBehavior}` : ""}: ${event.text}`);
	});
	pi.on("tool_execution_start", async (event) => {
		recordObserved("tool_start", `${event.toolName}: ${JSON.stringify(event.args ?? {}).slice(0, 1200)}`);
	});
	pi.on("tool_execution_end", async (event) => {
		const text = textOfToolContent(event.result?.content ?? event.result?.message?.content ?? event.result?.content ?? []);
		recordObserved("tool_end", `${event.toolName}${event.isError ? " error" : ""}: ${headTail(String(text || JSON.stringify(event.result ?? {})).replace(/\s+/g, " ").trim(), 1800)}`);
	});

	pi.on("agent_end", async (_event, ctx) => {
		if (!runtime.active) return;
		enqueue(pi, ctx, "agent_end", () => ({ entries: entriesSince(ctx, runtime.lastProcessedEntryId) }));
	});

	pi.on("session_compact", async (event, ctx) => {
		if (!runtime.active) {
			const cfg = config();
			if (cfg.defaultActive && countCompactions(ctx) >= cfg.activateAfterCompactions) {
				runtime.active = true;
				setRecallToolVisible(pi, true);
				runtime.startedAt = new Date().toISOString();
				appendState(pi);
			} else return;
		}
		enqueue(pi, ctx, "session_compact", () => ({ entries: entriesSince(ctx, runtime.lastProcessedEntryId), extra: `Compaction saved: ${event.compactionEntry.id}\n${clean(event.compactionEntry.summary, 12_000)}` }));
	});

	pi.registerCommand("kb", {
		description: "Session KB controls: /kb start, /kb status, /kb grep <query>, /kb cat <id>",
		handler: async (args, ctx) => {
			const [cmdRaw, ...rest] = args.trim().split(/\s+/).filter(Boolean);
			const cmd = (cmdRaw ?? "status").toLowerCase();
			const tail = rest.join(" ").trim();
			if (cmd === "help") { widget(ctx, "Session KB help", help()); return; }
			if (cmd === "start") {
				runtime.active = true;
				setRecallToolVisible(pi, true);
				runtime.startedAt = runtime.startedAt ?? new Date().toISOString();
				appendState(pi);
				enqueue(pi, ctx, runtime.initialized ? "manual_start_update" : "manual_start_bootstrap", () => ({ entries: runtime.initialized ? entriesSince(ctx, runtime.lastProcessedEntryId) : branchEntries(ctx), extra: "Manual /kb start requested. Bootstrap or update the Session KB now." }));
				ctx.ui.notify("Session KB started; bootstrap/update queued in background.", "info");
				return;
			}
			if (cmd === "stop") {
				runtime.active = false;
				setRecallToolVisible(pi, false);
				appendState(pi);
				ctx.ui.notify("Session KB stopped for this session.", "info");
				return;
			}
			if (cmd === "status") { widget(ctx, "Session KB status", statusText(ctx)); return; }
			if (cmd === "ls") { widget(ctx, "Session KB ls", listKb()); return; }
			if (cmd === "grep" || cmd === "recall") { widget(ctx, "Session KB recall", renderRecall(tail)); return; }
			if (cmd === "cat") { widget(ctx, `Session KB cat ${tail}`, catRecord(tail)); return; }
			if (cmd === "rebuild") {
				runtime.active = true;
				setRecallToolVisible(pi, true);
				runtime.initialized = false;
				runtime.kb = emptyKb();
				runtime.lastProcessedEntryId = undefined;
				appendState(pi);
				enqueue(pi, ctx, "manual_rebuild", () => ({ entries: branchEntries(ctx), extra: "Manual /kb rebuild requested. Rebuild the Session KB from this branch." }));
				ctx.ui.notify("Session KB rebuild queued in background.", "info");
				return;
			}
			if (cmd === "clear") { ctx.ui.setWidget("session-kb", undefined); return; }
			widget(ctx, "Session KB help", help());
		},
	});

	pi.registerTool({
		name: TOOL_NAME,
		label: "Session KB Recall",
		description: "Ask the manually-started per-session knowledge base for raw records relevant to a natural-language recall request. Include exact strings or regex-like hints in the query if useful. Returns stored records/evidence, not a synthesized answer.",
		parameters: Type.Object({
			query: Type.String({ description: "Natural-language recall request. Include exact strings or regex-like hints if useful." }),
		}),
		async execute(_id, params) {
			const text = renderRecall(params.query);
			return { content: [{ type: "text", text }], details: { active: runtime.active, initialized: runtime.initialized } };
		},
	});
}

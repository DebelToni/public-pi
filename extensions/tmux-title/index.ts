import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { codexWireModelId } from "../lib/codex-long-context.js";
import { basename, resolve } from "node:path";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { getAgentDir, readStoredCredential } from "@earendil-works/pi-coding-agent";

const WIKI_CWD = join(homedir(), "wiki");
const STATE_TYPE = "wiki-window-title";
const UNLISTED_TYPE = "pi-unlisted";
const MAP_PATH = join(getAgentDir(), "wiki-session-titles.json");

const STOPWORDS = new Set([
	"a", "an", "and", "are", "as", "at", "be", "but", "by", "can", "do", "for", "from", "get", "give", "have", "how", "i", "if", "in", "into", "is", "it", "make", "me", "my", "of", "on", "or", "please", "so", "that", "the", "this", "to", "use", "want", "what", "when", "where", "with", "you",
]);

type TitleMap = {
	version: 1;
	titles: Record<string, { session: string; cwd: string; updatedAt: number }>;
	sessions: Record<string, { title: string; cwd: string; updatedAt: number }>;
};

type AccountCredential = {
	type?: string;
	accountId?: string;
};

const TITLE_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses";

type TitleState = "none" | "idle" | "running" | "question" | "done" | "excluded";
let unlisted = false;

let wikiTitle: string | undefined;
let finalTurnCompleted = false;
let settledTitleState: TitleState = "idle";
const tmuxHookSessions = new Set<string>();

function safeTitlePart(s: string) {
	return s.replace(/[\x00-\x1f\x7f:]/g, " ").replace(/\s+/g, " ").trim();
}

function canonical(path: string) {
	try { return realpathSync.native(path); } catch { return resolve(path); }
}

function isWikiCwd(ctx: ExtensionContext) {
	return canonical(ctx.cwd) === canonical(WIKI_CWD);
}

function currentSessionFile(ctx: ExtensionContext) {
	return ctx.sessionManager.getSessionFile?.();
}

function loadMap(): TitleMap {
	try {
		const parsed = JSON.parse(readFileSync(MAP_PATH, "utf8"));
		return {
			version: 1,
			titles: parsed?.titles && typeof parsed.titles === "object" ? parsed.titles : {},
			sessions: parsed?.sessions && typeof parsed.sessions === "object" ? parsed.sessions : {},
		};
	} catch {
		return { version: 1, titles: {}, sessions: {} };
	}
}

function saveMap(map: TitleMap) {
	mkdirSync(dirname(MAP_PATH), { recursive: true });
	writeFileSync(MAP_PATH, `${JSON.stringify(map, null, 2)}\n`, "utf8");
}

function sessionName(ctx: ExtensionContext) {
	try { return safeTitlePart(ctx.sessionManager.getSessionName?.() ?? ""); } catch { return ""; }
}

function titleBase(ctx: ExtensionContext) {
	return sessionName(ctx) || safeTitlePart(isWikiCwd(ctx) && wikiTitle ? wikiTitle : basename(ctx.cwd) || "pi");
}

function statePrefix(state: TitleState) {
	if (state === "idle") return "○ ";
	if (state === "running") return "● ";
	if (state === "question") return "? ";
	if (state === "done") return "✓ ";
	return "";
}

function resolvedTitleState(ctx: ExtensionContext, state: TitleState) {
	return unlisted ? "excluded" : currentSessionFile(ctx) ? state : "none";
}

function tmuxTarget() {
	return process.env.TMUX_PANE;
}

function tmuxValue(format: string, target?: string) {
	try {
		return spawnSync("tmux", ["display-message", ...(target ? ["-t", target] : []), "-p", format], { encoding: "utf8", timeout: 2000 }).stdout?.trim() ?? "";
	} catch {
		return "";
	}
}

function installTmuxReadHook(target?: string) {
	if (!process.env.TMUX) return;
	const sessionId = tmuxValue("#{session_id}", target);
	if (!sessionId || tmuxHookSessions.has(sessionId)) return;
	const command = 'if -F "#{==:#{@pi_title_state},done}" "set-window-option -q @pi_title_state idle \\; rename-window \\"○ #{@pi_title_base}\\""';
	try {
		spawnSync("tmux", ["set-hook", "-t", sessionId, "after-select-window[987]", command], { stdio: "ignore", timeout: 2000 });
		tmuxHookSessions.add(sessionId);
	} catch {}
}

function renameTmuxWindow(title: string, base: string, state: TitleState) {
	if (!process.env.TMUX) return;
	const target = tmuxTarget();
	const resolvedState = state;
	try {
		installTmuxReadHook(target);
		if (target) spawnSync("tmux", ["set-option", "-p", "-t", target, "@pi_unlisted", resolvedState === "excluded" ? "1" : "0"], { stdio: "ignore", timeout: 2000 });
		spawnSync("tmux", ["set-window-option", "-q", ...(target ? ["-t", target] : []), "automatic-rename", "off"], { stdio: "ignore", timeout: 2000 });
		spawnSync("tmux", ["set-window-option", "-q", ...(target ? ["-t", target] : []), "@pi_title_base", base], { stdio: "ignore", timeout: 2000 });
		spawnSync("tmux", ["set-window-option", "-q", ...(target ? ["-t", target] : []), "@pi_title_state", resolvedState], { stdio: "ignore", timeout: 2000 });
		spawnSync("tmux", ["rename-window", ...(target ? ["-t", target] : []), title], { stdio: "ignore", timeout: 2000 });
	} catch {}
}

function shouldManageTmuxTitle(ctx: ExtensionContext) {
	return ctx.hasUI && ctx.mode === "tui";
}

function applyTitle(ctx: ExtensionContext, state: TitleState = "idle") {
	if (!shouldManageTmuxTitle(ctx)) return;
	const resolvedState = resolvedTitleState(ctx, state);
	const base = titleBase(ctx);
	const title = `${statePrefix(resolvedState)}${base}`;
	ctx.ui.setTitle(title);
	renameTmuxWindow(title, base, resolvedState);
}

function clearTitleState(ctx: ExtensionContext) {
	if (!shouldManageTmuxTitle(ctx)) return;
	const base = titleBase(ctx);
	ctx.ui.setTitle(base);
	renameTmuxWindow(base, base, unlisted ? "excluded" : "none");
}

function finalAssistantMessage(message: any) {
	return message?.role === "assistant" && message.stopReason === "stop";
}

function messageText(message: any) {
	const content = message?.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((part) => {
		if (typeof part === "string") return part;
		if (part?.type === "text" && typeof part.text === "string") return part.text;
		return "";
	}).join(" ");
}

function openingContext(ctx: ExtensionContext) {
	const parts: string[] = [];
	for (const entry of ctx.sessionManager.getBranch()) {
		const message = (entry as any).message;
		if (message?.role !== "user" && message?.role !== "assistant") continue;
		const text = messageText(message);
		if (!text) continue;
		parts.push(`${message.role}: ${text}`);
		if (parts.length >= 2) break;
	}
	return parts.join("\n\n");
}

function titleCase(word: string) {
	return word ? `${word[0].toUpperCase()}${word.slice(1).toLowerCase()}` : "";
}

function fallbackTitle(prompt: string) {
	const words = [...prompt.toLowerCase().matchAll(/[a-z0-9][a-z0-9-]{2,}/g)]
		.map((m) => m[0])
		.filter((word) => !STOPWORDS.has(word) && !/^https?$/.test(word));
	const picked: string[] = [];
	for (const word of words) {
		if (picked.includes(word)) continue;
		picked.push(word);
		if (picked.length === 2) break;
	}
	return safeTitlePart((picked.length ? picked : ["Wiki"]).map(titleCase).join(" ")).slice(0, 32) || "Wiki";
}

function decodeBase64Url(value: string) {
	const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
	const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
	return Buffer.from(padded, "base64").toString("utf8");
}

function accountIdFromJwt(token: string): string | undefined {
	try {
		const [, payload] = token.split(".");
		if (!payload) return undefined;
		const parsed = JSON.parse(decodeBase64Url(payload));
		const auth = parsed?.["https://api.openai.com/auth"];
		return typeof auth?.chatgpt_account_id === "string" ? auth.chatgpt_account_id : undefined;
	} catch {
		return undefined;
	}
}

function codexLikeProvider(provider?: string) {
	return provider === "openai-codex" || !!provider?.startsWith("codex-");
}

function normalizeModelTitle(raw: string) {
	const words = safeTitlePart(raw)
		.replace(/["'`*_#\[\](){}<>]/g, " ")
		.replace(/[^\p{L}\p{N} -]/gu, " ")
		.split(/\s+/)
		.filter(Boolean)
		.slice(0, 2)
		.map(titleCase);
	return words.join(" ").slice(0, 32);
}

function extractTextFromSse(chunk: unknown) {
	if (!chunk || typeof chunk !== "object") return "";
	const event = chunk as any;
	if (typeof event.delta === "string") return event.delta;
	if (typeof event.text === "string") return event.text;
	if (typeof event.output_text === "string") return event.output_text;
	const item = event.item;
	if (item && typeof item === "object") {
		if (typeof item.text === "string") return item.text;
		if (Array.isArray(item.content)) return item.content.map((part: any) => typeof part?.text === "string" ? part.text : "").join("");
	}
	const response = event.response;
	if (response && Array.isArray(response.output)) {
		return response.output.map((out: any) => Array.isArray(out?.content)
			? out.content.map((part: any) => typeof part?.text === "string" ? part.text : "").join("")
			: "").join("");
	}
	return "";
}

async function parseSseText(response: Response, signal?: AbortSignal) {
	if (!response.body) return "";
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let out = "";
	try {
		while (true) {
			if (signal?.aborted) throw new Error("Title request aborted.");
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			let idx = buffer.indexOf("\n\n");
			while (idx !== -1) {
				const frame = buffer.slice(0, idx);
				buffer = buffer.slice(idx + 2);
				const data = frame.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n").trim();
				if (data && data !== "[DONE]") {
					try { out += extractTextFromSse(JSON.parse(data)); } catch {}
				}
				idx = buffer.indexOf("\n\n");
			}
		}
	} finally {
		reader.releaseLock();
	}
	return out;
}

function extractTextDeep(value: any): string {
	if (!value) return "";
	if (typeof value === "string") return value;
	if (Array.isArray(value)) return value.map(extractTextDeep).join("");
	if (typeof value !== "object") return "";
	if (typeof value.output_text === "string") return value.output_text;
	if (typeof value.text === "string") return value.text;
	if (typeof value.delta === "string") return value.delta;
	if (Array.isArray(value.output)) return value.output.map(extractTextDeep).join("");
	if (Array.isArray(value.content)) return value.content.map(extractTextDeep).join("");
	return "";
}

export async function modelTitle(ctx: ExtensionContext, prompt: string) {
	const provider = codexLikeProvider(ctx.model?.provider) ? ctx.model!.provider : "openai-codex";
	const model = codexLikeProvider(ctx.model?.provider) ? ctx.model!.id : "gpt-6.1-sol";
	const token = await ctx.modelRegistry.getApiKeyForProvider(provider).catch(() => undefined);
	if (!token) throw new Error("missing token");
	const credential = readStoredCredential(provider) as AccountCredential | undefined;
	const accountId = accountIdFromJwt(token) || credential?.accountId;
	if (!accountId) throw new Error("missing account id");
	const signal = AbortSignal.timeout(20_000);
	const body = {
		model: await codexWireModelId(model),
		instructions: "You name wiki note/research/chat sessions. Return only ONE word when possible: preferably the technology, paper name, method, author/project name, or key term. Use maximum TWO words only if one word is unclear. No punctuation, no quotes, no explanation.",
		input: [{ role: "user", content: [{ type: "input_text", text: prompt.slice(0, 6000) }] }],
		max_output_tokens: 16,
		store: false,
		stream: false,
		include: [],
		client_metadata: { "x-codex-installation-id": "pi-wiki-title" },
	};
	const headers = {
		authorization: `Bearer ${token}`,
		"chatgpt-account-id": accountId,
		"OpenAI-Beta": "responses=experimental",
		"content-type": "application/json",
		originator: "codex_cli_rs",
		"User-Agent": "codex_cli_rs/0.0.0 (pi-wiki-title)",
	};
	const response = await fetch(TITLE_ENDPOINT, {
		method: "POST",
		headers: { ...headers, accept: "application/json" },
		body: JSON.stringify(body),
		signal,
	});
	if (!response.ok) throw new Error(`${response.status} ${await response.text().catch(() => response.statusText)}`);
	let raw = "";
	const contentType = response.headers.get("content-type") || "";
	if (contentType.includes("text/event-stream")) raw = await parseSseText(response, signal);
	else raw = extractTextDeep(await response.json());
	const title = normalizeModelTitle(raw);
	if (!title) throw new Error(`empty title from response: ${raw.slice(0, 120)}`);
	return title;
}

function uniqueTitle(base: string, session: string) {
	const map = loadMap();
	if (!map.titles[base] || map.titles[base].session === session) return base;
	const first = base.split(/\s+/)[0] || "Wiki";
	for (let i = 2; i < 100; i++) {
		const candidate = `${first} ${i}`;
		if (!map.titles[candidate] || map.titles[candidate].session === session) return candidate;
	}
	return `${first} ${Date.now() % 100}`;
}

function persistWikiTitle(ctx: ExtensionContext, title: string, appendSessionInfo = true) {
	const session = currentSessionFile(ctx);
	if (!session) return;
	const now = Date.now();
	const map = loadMap();
	const previous = map.sessions[session]?.title;
	if (previous && previous !== title && map.titles[previous]?.session === session) delete map.titles[previous];
	map.sessions[session] = { title, cwd: ctx.cwd, updatedAt: now };
	map.titles[title] = { session, cwd: ctx.cwd, updatedAt: now };
	saveMap(map);
	ctx.sessionManager.appendCustomEntry?.(STATE_TYPE, { title });
	if (appendSessionInfo) ctx.sessionManager.appendSessionInfo?.(title);
}

function restoreWikiTitle(_ctx: ExtensionContext) {
	wikiTitle = undefined;
}

async function maybeCreateWikiTitle(_ctx: ExtensionContext, _force = false) {
	return;
}

function syncManualSessionName(ctx: ExtensionContext) {
	const name = sessionName(ctx);
	if (!name) return;
	if (isWikiCwd(ctx) && name !== wikiTitle) {
		wikiTitle = name;
		persistWikiTitle(ctx, name, false);
	}
}

export default function (pi: ExtensionAPI) {
	let parking = false;
	let questionnaireWaiting = false;
	pi.registerFlag("unlisted", { description: "Exclude this Pi session from tmux status and the phone app", type: "boolean", default: false });
	pi.registerCommand("unlisted", {
		description: "Exclude this session; /unlisted off restores it, /unlisted status checks it",
		handler: async (args, ctx) => {
			const value = args.trim().toLowerCase();
			if (!["", "on", "off", "status"].includes(value)) {
				ctx.ui.notify("Use /unlisted [on|off|status].", "warning"); return;
			}
			if (value !== "status") {
				const enabled = value !== "off";
				// Durable session-wide preference, never model context or a tmux-session option.
				pi.appendEntry(UNLISTED_TYPE, { enabled });
				unlisted = enabled;
				applyTitle(ctx, questionnaireWaiting ? "question" : ctx.isIdle() && !ctx.hasPendingMessages() ? "idle" : "running");
			}
			ctx.ui.notify(unlisted ? "Session unlisted from tmux status and the phone app." : "Session listed again.", "info");
		},
	});
	pi.registerCommand("tick", {
		description: "Restore ✓ on the current tmux window using Pi's native done state",
		handler: async (_args, ctx) => {
			if (!shouldManageTmuxTitle(ctx) || !process.env.TMUX || !process.env.TMUX_PANE) {
				ctx.ui.notify("/tick requires an interactive tmux session.", "warning");
				return;
			}
			if (!ctx.isIdle() || ctx.hasPendingMessages()) {
				ctx.ui.notify("Wait until Pi is idle with no queued messages before ticking.", "warning");
				return;
			}
			settledTitleState = "done";
			applyTitle(ctx, "done");
		},
	});
	pi.registerCommand("park", {
		description: "Exit Pi and leave ○ on the tmux window title",
		handler: async (_args, ctx) => {
			if (!shouldManageTmuxTitle(ctx) || !process.env.TMUX || !process.env.TMUX_PANE) {
				ctx.ui.notify("/park requires an interactive tmux session.", "warning");
				return;
			}
			if (!ctx.isIdle() || ctx.hasPendingMessages()) {
				ctx.ui.notify("Wait until Pi is idle with no queued messages before parking.", "warning");
				return;
			}
			parking = true;
			ctx.shutdown();
		},
	});
	pi.on("session_shutdown", async (event, ctx) => {
		questionnaireWaiting = false;
		if (parking && event.reason === "quit" && !unlisted) {
			const base = titleBase(ctx);
			ctx.ui.setTitle(`○ ${base}`);
			renameTmuxWindow(`○ ${base}`, base, "idle");
		} else clearTitleState(ctx);
	});

	pi.on("session_start", async (event, ctx) => {
		const saved = [...(ctx.sessionManager.getEntries?.() ?? [])].reverse().find((entry: any) => entry.type === "custom" && entry.customType === UNLISTED_TYPE && typeof entry.data?.enabled === "boolean") as any;
		unlisted = saved?.data.enabled ?? false;
		// A fresh explicit flag wins; reload must respect a later /unlisted off.
		if (event.reason === "startup" && pi.getFlag("unlisted") === true) {
			if (!unlisted) pi.appendEntry(UNLISTED_TYPE, { enabled: true });
			unlisted = true;
		}
		if (!shouldManageTmuxTitle(ctx)) return;
		questionnaireWaiting = false;
		settledTitleState = "idle";
		restoreWikiTitle(ctx);
		syncManualSessionName(ctx);
		applyTitle(ctx);
	});
	pi.on("session_info_changed", (_event, ctx) => {
		if (!shouldManageTmuxTitle(ctx)) return;
		const state = tmuxValue("#{@pi_title_state}", tmuxTarget()) as TitleState;
		applyTitle(ctx, ["none", "idle", "running", "question", "done"].includes(state) ? state : "idle");
	});
	pi.on("before_agent_start", async (_event, ctx) => {
		if (!shouldManageTmuxTitle(ctx)) return;
		finalTurnCompleted = false;
		settledTitleState = "idle";
		syncManualSessionName(ctx);
		applyTitle(ctx, "running");
	});
	pi.on("turn_start", async (_event, ctx) => {
		if (!shouldManageTmuxTitle(ctx)) return;
		finalTurnCompleted = false;
		settledTitleState = "idle";
		syncManualSessionName(ctx);
		applyTitle(ctx, "running");
	});
	pi.on("tool_execution_start", (event, ctx) => {
		if (event.toolName !== "ask_user" || !shouldManageTmuxTitle(ctx)) return;
		questionnaireWaiting = true;
		applyTitle(ctx, "question");
	});
	pi.on("tool_execution_end", (event, ctx) => {
		if (event.toolName !== "ask_user" || !shouldManageTmuxTitle(ctx)) return;
		questionnaireWaiting = false;
		applyTitle(ctx, "running");
	});
	pi.on("turn_end", async (event) => {
		finalTurnCompleted = finalAssistantMessage(event.message);
	});
	pi.on("agent_end", async (event, ctx) => {
		if (!shouldManageTmuxTitle(ctx)) return;
		syncManualSessionName(ctx);
		await maybeCreateWikiTitle(ctx);
		const last = [...event.messages].reverse().find((message: any) => message?.role === "assistant");
		settledTitleState = finalTurnCompleted && finalAssistantMessage(last) ? "done" : "idle";
	});
	pi.on("agent_settled", async (_event, ctx) => {
		if (!shouldManageTmuxTitle(ctx)) return;
		applyTitle(ctx, questionnaireWaiting ? "question" : settledTitleState);
	});

	pi.on("input", async (event, ctx) => {
		if (!shouldManageTmuxTitle(ctx)) return { action: "continue" };
		const match = event.text.match(/^\/name\s+(.+)$/s);
		if (!match) return { action: "continue" };
		const name = safeTitlePart(match[1]).slice(0, 64);
		if (!name) return { action: "continue" };
		ctx.sessionManager.appendSessionInfo?.(name);
		if (isWikiCwd(ctx)) {
			wikiTitle = name;
			persistWikiTitle(ctx, name, false);
		}
		applyTitle(ctx);
		ctx.ui.notify(`Session name: ${name}`, "info");
		return { action: "handled" };
	});

	pi.registerCommand("wiki-title", {
		description: "Disabled: use /name <title> to manually set wiki tmux/session title",
		handler: async (_args, ctx) => {
			ctx.ui.notify("Automatic wiki titles are disabled. Use /name <title>.", "info");
		},
	});
}

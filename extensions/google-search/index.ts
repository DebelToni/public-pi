import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateHead,
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { readFileSync, unwatchFile, watchFile, writeFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const TOOL_DESCRIPTION = "Google search for exact facts, current pages, and ordinary lookups. Search once; fetch sparingly.";
export const GOOGLE_PAUSED_ERROR = "Google search is globally paused. For this task, use exa_search minimally (numResults=3, includeText=false). Run /pause-google to resume Google search.";
export const GOOGLE_PAUSE_INDICATOR = "X google";

const CLI_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "../../bin/google-search");
const MODEL_STATUS_PREFIX_CHANNEL = "model-status:prefix";
const PAUSE_STATUS_KEY = "google-search-paused";
const FETCH_TEXT_BUDGET = 38 * 1024;

export type GoogleSearchResult = {
	title: string;
	url: string;
	snippet: string;
	text?: string;
};

type GoogleSearchDetails = {
	count: number;
	fetched: boolean;
	fullOutputPath?: string;
};

const BOT_CHALLENGE_GUIDELINE = "If google_search reports a CAPTCHA or bot challenge, use exa_search (numResults=3, includeText=false) for this call. Do not retry Google or ask the user to solve the challenge.";
const PAUSED_GUIDELINE = "When google_search says Google is globally paused, use exa_search minimally for the current task with numResults=3 and includeText=false; do not retry Google until the user resumes it with /pause-google.";

type GooglePauseState = {
	paused: boolean;
	updatedAt: number;
	updatedBy: number;
	autoResumeAt?: number;
	reason?: string;
};

export function googlePauseStatePath() {
	return join(getAgentDir(), "google-search-runtime", "pause.json");
}

export function googlePause(statePath = googlePauseStatePath()): { paused: boolean; reason?: string; autoResumeAt?: number } {
	try {
		const state = JSON.parse(readFileSync(statePath, "utf8")) as Partial<GooglePauseState>;
		if (state.paused !== true) return { paused: false };
		if (typeof state.autoResumeAt === "number" && Date.now() >= state.autoResumeAt) {
			writeFileSync(statePath, `${JSON.stringify({ paused: false, updatedAt: Date.now(), updatedBy: process.pid })}\n`, { mode: 0o600 });
			return { paused: false };
		}
		return { paused: true, reason: state.reason, autoResumeAt: state.autoResumeAt };
	} catch {
		return { paused: false };
	}
}

export function isGooglePaused(statePath = googlePauseStatePath()) {
	return googlePause(statePath).paused;
}

function parsePauseControl(stdout: string) {
	try {
		const value = JSON.parse(stdout) as { paused?: unknown };
		if (typeof value.paused === "boolean") return value.paused;
	} catch {}
	throw new Error("google-search returned an invalid pause state");
}

function safe(text: string) {
	return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}

function inline(text: string) {
	return safe(text).replace(/\s+/g, " ").trim();
}

export function parseResults(stdout: string): GoogleSearchResult[] {
	let value: unknown;
	try {
		value = JSON.parse(stdout);
	} catch {
		throw new Error("google-search returned invalid JSON");
	}
	if (!Array.isArray(value)) throw new Error("google-search returned an invalid result list");
	for (const result of value) {
		if (!result || typeof result !== "object") throw new Error("google-search returned an invalid result");
		const candidate = result as Partial<GoogleSearchResult>;
		if (typeof candidate.title !== "string" || typeof candidate.url !== "string" || typeof candidate.snippet !== "string") {
			throw new Error("google-search returned an invalid result");
		}
		if (candidate.text !== undefined && typeof candidate.text !== "string") {
			throw new Error("google-search returned invalid page text");
		}
	}
	return value as GoogleSearchResult[];
}

export function formatResults(results: GoogleSearchResult[], fetched: boolean) {
	if (!results.length) return { text: "No results.", trimmed: false };
	const textBytes = Math.max(1000, Math.floor(FETCH_TEXT_BUDGET / results.length));
	const textLines = Math.max(100, Math.floor((DEFAULT_MAX_LINES - 200) / results.length));
	let trimmed = false;
	const blocks = results.map((result, index) => {
		const lines = [
			`## ${index + 1}. ${inline(result.title)}`,
			inline(result.url),
			result.snippet ? `snippet: ${inline(result.snippet)}` : undefined,
		];
		if (fetched && result.text) {
			const page = truncateHead(safe(result.text), { maxBytes: textBytes, maxLines: textLines });
			trimmed ||= page.truncated;
			lines.push(`text:\n${page.content}${page.truncated ? "\n[page text trimmed for tool output]" : ""}`);
		}
		return lines.filter((line): line is string => Boolean(line)).join("\n");
	});
	return { text: blocks.join("\n\n"), trimmed };
}

async function saveFullOutput(stdout: string) {
	const directory = await mkdtemp(join(tmpdir(), "pi-google-search-"));
	const path = join(directory, "results.json");
	await writeFile(path, stdout, "utf8");
	return path;
}

export default function (pi: ExtensionAPI, statePath = googlePauseStatePath()) {
	let paused = isGooglePaused(statePath);
	let activeContext: ExtensionContext | undefined;
	let footerTimer: NodeJS.Timeout | undefined;
	let resumeTimer: NodeJS.Timeout | undefined;

	const renderPauseState = () => {
		if (!activeContext) return;
		const indicator = paused ? activeContext.ui.theme.fg("warning", GOOGLE_PAUSE_INDICATOR) : undefined;
		activeContext.ui.setStatus(PAUSE_STATUS_KEY, indicator);
		pi.events.emit(MODEL_STATUS_PREFIX_CHANNEL, indicator);
	};
	const scheduleRender = (delayMs = 0) => {
		if (footerTimer) clearTimeout(footerTimer);
		footerTimer = setTimeout(() => {
			footerTimer = undefined;
			renderPauseState();
		}, delayMs);
		footerTimer.unref();
	};
	const refreshPauseState = () => {
		const next = isGooglePaused(statePath);
		if (next === paused) return;
		paused = next;
		renderPauseState();
	};
	const stateFileChanged = () => refreshPauseState();

	pi.on("session_start", (_event, ctx) => {
		activeContext = ctx;
		const pause = googlePause(statePath);
		paused = pause.paused;
		unwatchFile(statePath, stateFileChanged);
		watchFile(statePath, { persistent: false, interval: 250 }, stateFileChanged);
		if (resumeTimer) clearTimeout(resumeTimer);
		if (pause.paused && typeof pause.autoResumeAt === "number") {
			resumeTimer = setTimeout(() => refreshPauseState(), Math.max(0, pause.autoResumeAt - Date.now() + 250));
			resumeTimer.unref();
		}
		renderPauseState();
		if (paused) scheduleRender(50);
	});

	pi.on("session_shutdown", () => {
		unwatchFile(statePath, stateFileChanged);
		if (resumeTimer) clearTimeout(resumeTimer);
		resumeTimer = undefined;
		activeContext?.ui.setStatus(PAUSE_STATUS_KEY, undefined);
		pi.events.emit(MODEL_STATUS_PREFIX_CHANNEL, undefined);
		if (footerTimer) clearTimeout(footerTimer);
		footerTimer = undefined;
		activeContext = undefined;
	});

	pi.registerCommand("pause-google", {
		description: "Globally pause or resume Google Search in every Pi instance",
		handler: async (_args, ctx) => {
			const result = await pi.exec(CLI_PATH, ["--pause-toggle"], { timeout: 5_000 });
			if (result.code !== 0) {
				throw new Error(result.stderr.trim() || `google-search exited with status ${result.code}`);
			}
			paused = parsePauseControl(result.stdout);
			renderPauseState();
			ctx.ui.notify(
				paused
					? "Google Search paused globally. Use minimal Exa search until you run /pause-google again."
					: "Google Search resumed globally.",
				paused ? "warning" : "info",
			);
		},
	});

	pi.registerTool({
		name: "google_search",
		label: "Google Search",
		description: TOOL_DESCRIPTION,
		promptGuidelines: [BOT_CHALLENGE_GUIDELINE, PAUSED_GUIDELINE],
		parameters: Type.Object({
			query: Type.String({ description: "Search query", minLength: 1 }),
			count: Type.Optional(Type.Integer({ description: "Results, 3-10 (default 5)", minimum: 3, maximum: 10 })),
			fetch: Type.Optional(Type.Boolean({ description: "Fetch HTML text; PDFs/failures stay URL-only", default: false })),
		}),
		renderCall(args, theme, context) {
			const component = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const query = typeof args.query === "string" ? inline(args.query) : "";
			component.setText(
				theme.fg("toolTitle", theme.bold("google_search:")) +
				(query ? ` ${theme.fg("muted", query)}` : ""),
			);
			return component;
		},
		async execute(_id, params, signal) {
			const pause = googlePause(statePath);
			if (pause.paused && pause.reason !== "bot_challenges") {
				throw new Error(GOOGLE_PAUSED_ERROR);
			}
			const count = Math.max(3, Math.min(10, params.count ?? 5));
			const args = [
				...(params.fetch ? ["--fetch"] : []),
				params.query,
				String(count),
			];
			const process = await pi.exec(CLI_PATH, args, { signal, timeout: 170_000 });
			if (process.code !== 0) {
				const error = safe(process.stderr).trim().slice(0, 2000);
				throw new Error(error || `google-search exited with status ${process.code}`);
			}

			const results = parseResults(process.stdout);
			const formatted = formatResults(results, !!params.fetch);
			let output = formatted.text;

			const truncation = truncateHead(output, {
				maxBytes: DEFAULT_MAX_BYTES,
				maxLines: DEFAULT_MAX_LINES,
			});
			output = truncation.content;

			const details: GoogleSearchDetails = {
				count: results.length,
				fetched: !!params.fetch,
			};
			if (formatted.trimmed || truncation.truncated) {
				details.fullOutputPath = await saveFullOutput(process.stdout);
				output += `\n\n[Page text trimmed to ${formatSize(DEFAULT_MAX_BYTES)} tool output. Full JSON: ${details.fullOutputPath}]`;
			}

			return { content: [{ type: "text", text: output }], details };
		},
	});
}

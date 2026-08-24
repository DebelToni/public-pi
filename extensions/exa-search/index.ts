import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import lockfile from "proper-lockfile";
import { createHash, randomUUID } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const EXA_API_URL = "https://api.exa.ai";
const EXA_ENV_PATH = join(homedir(), ".env-EXA");
const EXA_ACCOUNT_STATE_PATH = join(getAgentDir(), "exa-search-runtime", "account.json");
const EXA_KEY_NAME = /^EXA_API_KEY(?:_(\d+))?$/;
const EXA_USAGE_NOTE = "Usage remaining: unavailable to ordinary Exa API keys. Exa's per-key usage endpoint reports spend, requires separate Team Management service credentials, and does not expose remaining monthly credits.";

type ExaAccount = { id: number; name: string; apiKey: string; fingerprint: string };
type ExaAccountObservation = { status: number; checkedAt: number; fingerprint: string };
type ExaActiveState = { activeAccount: number; fingerprint?: string; generation?: number };

type ExaResult = {
	title?: string;
	url?: string;
	publishedDate?: string;
	author?: string;
	score?: number;
	text?: string;
	highlights?: string[];
	summary?: string;
};

function readEnvFile(envPath: string) {
	try {
		return existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
	} catch {
		return "";
	}
}

function envFileValue(text: string, name: string) {
	const match = text.match(new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=\\s*["']?([^"'\\n]+)["']?`, "m"));
	return match?.[1]?.trim();
}

function accountId(name: string) {
	const match = EXA_KEY_NAME.exec(name);
	if (!match) return undefined;
	if (!match[1]) return 1;
	if (!/^[1-9]\d*$/.test(match[1])) return undefined;
	const id = Number(match[1]);
	return Number.isSafeInteger(id) && id >= 2 ? id : undefined;
}

function accountName(id: number) {
	return id === 1 ? "EXA_API_KEY" : `EXA_API_KEY_${id}`;
}

function accountFingerprint(apiKey: string) {
	return createHash("sha256").update(apiKey).digest("hex").slice(0, 16);
}

function getAccounts(envPath: string) {
	const fileText = readEnvFile(envPath);
	const ids = new Set<number>();
	for (const name of Object.keys(process.env)) {
		const id = accountId(name);
		if (id !== undefined) ids.add(id);
	}
	for (const match of fileText.matchAll(/^\s*(?:export\s+)?(EXA_API_KEY(?:_\d+)?)\s*=/gm)) {
		const id = accountId(match[1]);
		if (id !== undefined) ids.add(id);
	}

	const accounts: ExaAccount[] = [];
	for (const id of [...ids].sort((a, b) => a - b)) {
		const name = accountName(id);
		const apiKey = process.env[name] || envFileValue(fileText, name);
		if (apiKey && !accounts.some((account) => account.apiKey === apiKey)) {
			accounts.push({ id, name, apiKey, fingerprint: accountFingerprint(apiKey) });
		}
	}
	return accounts;
}

function readActiveState(statePath: string): ExaActiveState | undefined {
	try {
		const value = JSON.parse(readFileSync(statePath, "utf8")) as {
			activeAccount?: unknown;
			fingerprint?: unknown;
			generation?: unknown;
		};
		if (typeof value.activeAccount !== "number" || !Number.isSafeInteger(value.activeAccount) || value.activeAccount < 1) {
			return undefined;
		}
		return {
			activeAccount: value.activeAccount,
			...(typeof value.fingerprint === "string" ? { fingerprint: value.fingerprint } : {}),
			...(typeof value.generation === "number" && Number.isSafeInteger(value.generation) && value.generation >= 0
				? { generation: value.generation }
				: {}),
		};
	} catch {
		return undefined;
	}
}

function writePrivateJson(path: string, value: unknown) {
	const directory = dirname(path);
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	chmodSync(directory, 0o700);
	const temporary = join(directory, `.exa-${randomUUID()}.tmp`);
	try {
		writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
			encoding: "utf8",
			flag: "wx",
			mode: 0o600,
		});
		renameSync(temporary, path);
		chmodSync(path, 0o600);
	} finally {
		rmSync(temporary, { force: true });
	}
}

function writeActiveAccount(account: ExaAccount, statePath: string, current: ExaActiveState | undefined) {
	const next: ExaActiveState = {
		activeAccount: account.id,
		fingerprint: account.fingerprint,
		generation: (current?.generation ?? 0) + 1,
	};
	writePrivateJson(statePath, next);
	return next;
}

function activeStatesEqual(left: ExaActiveState | undefined, right: ExaActiveState | undefined) {
	if (!left || !right) return left === right;
	return left.activeAccount === right.activeAccount
		&& left.fingerprint === right.fingerprint
		&& left.generation === right.generation;
}

function stateMatchesAccount(state: ExaActiveState | undefined, account: ExaAccount) {
	return state?.activeAccount === account.id && (!state.fingerprint || state.fingerprint === account.fingerprint);
}

function observationPath(statePath: string, account: ExaAccount) {
	return join(dirname(statePath), `status-${account.id}-${account.fingerprint}.json`);
}

function readAccountObservation(statePath: string, account: ExaAccount): ExaAccountObservation | undefined {
	try {
		const value = JSON.parse(readFileSync(observationPath(statePath, account), "utf8")) as Partial<ExaAccountObservation>;
		if (typeof value.status !== "number" || typeof value.checkedAt !== "number" || value.fingerprint !== account.fingerprint) {
			return undefined;
		}
		return { status: value.status, checkedAt: value.checkedAt, fingerprint: value.fingerprint };
	} catch {
		return undefined;
	}
}

function recordAccountStatus(statePath: string, account: ExaAccount, status: number) {
	try {
		writePrivateJson(observationPath(statePath, account), {
			status,
			checkedAt: Date.now(),
			fingerprint: account.fingerprint,
		});
	} catch {
		// Diagnostics must never break a search.
	}
}

async function acquireRotationLock(statePath: string) {
	const directory = dirname(statePath);
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	chmodSync(directory, 0o700);
	return lockfile.lock(statePath, {
		realpath: false,
		stale: 30_000,
		update: 10_000,
		retries: { retries: 100, minTimeout: 20, maxTimeout: 20, factor: 1 },
	});
}

async function rotateActiveAccount(
	failedAccount: ExaAccount,
	expectedState: ExaActiveState | undefined,
	statePath: string,
	envPath: string,
) {
	const release = await acquireRotationLock(statePath);
	try {
		const current = readActiveState(statePath);
		if (!activeStatesEqual(current, expectedState)) return { state: current, changed: false };
		const latestAccounts = getAccounts(envPath);
		const failedIndex = latestAccounts.findIndex(
			(account) => account.id === failedAccount.id && account.fingerprint === failedAccount.fingerprint,
		);
		if (failedIndex < 0) return { state: current, changed: false };
		const state = writeActiveAccount(latestAccounts[(failedIndex + 1) % latestAccounts.length], statePath, current);
		return { state, changed: true };
	} finally {
		await release();
	}
}

async function markSuccessfulAccount(
	successfulAccount: ExaAccount,
	expectedState: ExaActiveState | undefined,
	allowDifferentAccount: boolean,
	statePath: string,
	envPath: string,
) {
	const release = await acquireRotationLock(statePath);
	try {
		const current = readActiveState(statePath);
		if (!activeStatesEqual(current, expectedState)) return;
		if (!allowDifferentAccount && expectedState && !stateMatchesAccount(expectedState, successfulAccount)) return;
		const currentAccount = getAccounts(envPath).find(
			(account) => account.id === successfulAccount.id && account.fingerprint === successfulAccount.fingerprint,
		);
		if (!currentAccount || (stateMatchesAccount(current, currentAccount) && current?.generation !== undefined)) return;
		writeActiveAccount(currentAccount, statePath, current);
	} finally {
		await release();
	}
}

class ExaHttpError extends Error {
	constructor(readonly status: number, message: string) {
		super(message);
	}
}

function isQuotaError(error: unknown): error is ExaHttpError {
	return error instanceof ExaHttpError && error.status === 402;
}

function cleanText(s: string, max = 4000) {
	return s.replace(/\s+/g, " ").trim().slice(0, max);
}

function formatResults(results: ExaResult[], includeText: boolean) {
	if (!results.length) return "No results.";
	return results.map((r, i) => {
		const parts = [
			`## ${i + 1}. ${r.title || "Untitled"}`,
			r.url ? r.url : undefined,
			r.publishedDate ? `published: ${r.publishedDate}` : undefined,
			r.author ? `author: ${r.author}` : undefined,
			r.summary ? `summary: ${cleanText(r.summary, 1200)}` : undefined,
			r.highlights?.length ? `highlights:\n${r.highlights.map((h) => `- ${cleanText(h, 800)}`).join("\n")}` : undefined,
			includeText && r.text ? `text:\n${cleanText(r.text)}` : undefined,
		];
		return parts.filter(Boolean).join("\n");
	}).join("\n\n");
}

async function exaRequest(
	path: string,
	body: unknown,
	account: ExaAccount,
	statePath: string,
	signal?: AbortSignal,
) {
	const res = await fetch(`${EXA_API_URL}${path}`, {
		method: "POST",
		headers: { "content-type": "application/json", "x-api-key": account.apiKey },
		body: JSON.stringify(body),
		signal,
	});
	recordAccountStatus(statePath, account, res.status);
	const text = await res.text();
	let json: any;
	try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
	if (!res.ok) throw new ExaHttpError(res.status, `Exa ${res.status}: ${json?.error || json?.message || text}`);
	return json;
}

async function exaPost(path: string, body: unknown, statePath: string, envPath: string, signal?: AbortSignal) {
	const accounts = getAccounts(envPath);
	if (!accounts.length) throw new Error("No EXA_API_KEY variables are configured");
	const activeState = readActiveState(statePath);
	const activeIndex = accounts.findIndex((account) => stateMatchesAccount(activeState, account));
	const ordered = activeIndex >= 0
		? [...accounts.slice(activeIndex), ...accounts.slice(0, activeIndex)]
		: accounts;
	let quotaError: ExaHttpError | undefined;
	let expectedState = activeState;
	let allowDifferentAccount = activeIndex < 0;

	for (let index = 0; index < ordered.length; index++) {
		const account = ordered[index];
		try {
			const result = await exaRequest(path, body, account, statePath, signal);
			await markSuccessfulAccount(account, expectedState, allowDifferentAccount, statePath, envPath);
			return result;
		} catch (error) {
			if (!isQuotaError(error)) throw error;
			quotaError = error;
			const rotation = await rotateActiveAccount(account, expectedState, statePath, envPath);
			if (rotation.changed) {
				expectedState = rotation.state;
				allowDifferentAccount = false;
			}
		}
	}

	if (ordered.length > 1) {
		throw new ExaHttpError(402, `Exa 402: all ${ordered.length} configured accounts have exceeded their credits limit`);
	}
	throw quotaError!;
}

function describeStatus(status: number) {
	if (status >= 200 && status < 300) return `HTTP ${status} (ok)`;
	if (status === 402) return "HTTP 402 (quota exhausted)";
	if (status === 429) return "HTTP 429 (rate limited)";
	return `HTTP ${status}`;
}

function exaInfo(statePath: string, envPath: string) {
	const accounts = getAccounts(envPath);
	if (!accounts.length) return "No EXA_API_KEY variables are configured.";
	const activeState = readActiveState(statePath);
	const active = accounts.find((account) => stateMatchesAccount(activeState, account))?.id ?? accounts[0].id;
	const lines = accounts.map((account) => {
		const observation = readAccountObservation(statePath, account);
		const status = observation
			? `${describeStatus(observation.status)} · ${new Date(observation.checkedAt).toISOString()}`
			: "no request observed yet";
		return `${account.id === active ? "*" : " "} ${account.name} — ${status}`;
	});
	const rotation = accounts.map((account) => account.id).join(" → ");
	return [`Exa accounts (${accounts.length}) · last observed HTTP status`, ...lines, `Rotation: ${rotation} → ${accounts[0].id}`, EXA_USAGE_NOTE].join("\n");
}

export default function (
	pi: ExtensionAPI,
	statePath = EXA_ACCOUNT_STATE_PATH,
	envPath = EXA_ENV_PATH,
) {
	pi.registerCommand("exa-info", {
		description: "Show Exa accounts, active rotation, and last observed HTTP statuses",
		handler: async (_args, ctx) => {
			ctx.ui.notify(exaInfo(statePath, envPath), "info");
		},
	});

	pi.registerTool({
		name: "exa_search",
		label: "Exa Search",
		description: "Semantic search for niche or research-oriented discovery.",
		parameters: Type.Object({
			query: Type.String({ description: "Search query" }),
			numResults: Type.Optional(Type.Number({ description: "Number of results, 1-10", default: 5 })),
			includeText: Type.Optional(Type.Boolean({ description: "Fetch page text snippets when supported", default: false })),
		}),
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const query = typeof args.query === "string" ? args.query.replace(/\s+/g, " ").trim() : "";
			text.setText(
				theme.fg("toolTitle", theme.bold("exa_search:")) +
				(query ? ` ${theme.fg("muted", query)}` : ""),
			);
			return text;
		},
		async execute(_id, params, signal) {
			const numResults = Math.max(1, Math.min(10, params.numResults ?? 5));
			const body: any = { query: params.query, type: "auto", numResults };
			if (params.includeText) body.contents = { text: { maxCharacters: 3000 }, highlights: true, summary: true };
			let data: any;
			try {
				data = await exaPost("/search", body, statePath, envPath, signal);
			} catch (err) {
				if (!params.includeText || isQuotaError(err)) throw err;
				data = await exaPost("/search", { query: params.query, type: "auto", numResults }, statePath, envPath, signal);
			}
			const results = (data.results ?? []) as ExaResult[];
			return { content: [{ type: "text", text: formatResults(results, !!params.includeText) }], details: data };
		},
	});

	pi.registerTool({
		name: "exa_answer",
		label: "Exa Answer",
		description: "Ask Exa for a sourced answer. Requires a configured EXA_API_KEY variable.",
		parameters: Type.Object({ query: Type.String({ description: "Question to answer" }) }),
		async execute(_id, params, signal) {
			const data = await exaPost("/answer", { query: params.query, text: true }, statePath, envPath, signal);
			const answer = data.answer || data.text || JSON.stringify(data, null, 2);
			const citations = Array.isArray(data.citations) ? `\n\n## Citations\n${data.citations.map((c: any, i: number) => `${i + 1}. ${c.title || c.url || "source"}${c.url ? ` — ${c.url}` : ""}`).join("\n")}` : "";
			return { content: [{ type: "text", text: `${answer}${citations}` }], details: data };
		},
	});
}

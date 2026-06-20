import { getModels } from "@earendil-works/pi-ai";
import { openaiCodexOAuthProvider } from "@earendil-works/pi-ai/oauth";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai/oauth";
import type { ExtensionAPI, ExtensionCommandContext, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { AuthStorage, getAgentDir } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const STORAGE_PATH = join(getAgentDir(), "codex-accounts.json");
const SYNC_STATE_PATH = join(getAgentDir(), "codex-provider-sync.json");
const PROVIDER_PREFIX = "codex-";
const BASE_PROVIDER = "openai-codex";

const CODEX_MODELS = getModels(BASE_PROVIDER);
const FIRST_CODEX_MODEL = CODEX_MODELS[0];
const CODEX_BASE_URL = FIRST_CODEX_MODEL?.baseUrl ?? "https://chatgpt.com/backend-api";
const CODEX_API = FIRST_CODEX_MODEL?.api ?? "openai-codex-responses";

type StoredAccount = {
	label: string;
	providerId: string;
	createdAt?: string;
};

type StorageShape = {
	version: 1;
	accounts: StoredAccount[];
};

type AccountCredential = OAuthCredentials & {
	accountLabel?: string;
	providerId?: string;
};

function normalizeLabel(label: string) {
	return label.replace(/\s+/g, " ").trim();
}

function slugify(label: string) {
	const slug = normalizeLabel(label)
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 64);
	if (!slug) throw new Error("Account label must contain at least one letter or number.");
	return slug;
}

function providerIdFor(label: string) {
	return `${PROVIDER_PREFIX}${slugify(label)}`;
}

function normalizeAccount(raw: unknown): StoredAccount | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const value = raw as Partial<StoredAccount>;
	if (typeof value.label !== "string") return undefined;
	const label = normalizeLabel(value.label);
	if (!label) return undefined;
	const providerId = typeof value.providerId === "string" && value.providerId.trim()
		? value.providerId.trim()
		: providerIdFor(label);
	return {
		label,
		providerId,
		...(typeof value.createdAt === "string" ? { createdAt: value.createdAt } : {}),
	};
}

function dedupeAccounts(accounts: StoredAccount[]) {
	const seen = new Set<string>();
	const out: StoredAccount[] = [];
	for (const account of accounts) {
		const key = account.providerId.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(account);
	}
	return out;
}

function loadAccounts(): StoredAccount[] {
	try {
		if (!existsSync(STORAGE_PATH)) return [];
		const parsed = JSON.parse(readFileSync(STORAGE_PATH, "utf8"));
		const rawAccounts = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.accounts) ? parsed.accounts : [];
		return dedupeAccounts(rawAccounts.map(normalizeAccount).filter(Boolean) as StoredAccount[]);
	} catch {
		return [];
	}
}

function saveAccounts(accounts: StoredAccount[]) {
	mkdirSync(dirname(STORAGE_PATH), { recursive: true });
	const payload: StorageShape = { version: 1, accounts: dedupeAccounts(accounts) };
	writeFileSync(STORAGE_PATH, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function modelsForAccount(account: StoredAccount): ProviderModelConfig[] {
	return CODEX_MODELS.map((model) => ({
		id: model.id,
		name: `${account.label} · ${model.name || model.id}`,
		api: model.api,
		baseUrl: model.baseUrl,
		reasoning: model.reasoning,
		thinkingLevelMap: model.thinkingLevelMap,
		input: model.input,
		cost: model.cost,
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens,
		compat: model.compat,
		headers: model.headers,
	}));
}

function loginForAccount(account: StoredAccount) {
	return async (callbacks: OAuthLoginCallbacks): Promise<AccountCredential> => {
		const credentials = await openaiCodexOAuthProvider.login(callbacks);
		return {
			...credentials,
			accountLabel: account.label,
			providerId: account.providerId,
		};
	};
}

async function refreshForAccount(account: StoredAccount, credentials: OAuthCredentials): Promise<AccountCredential> {
	const previous = credentials as AccountCredential;
	const refreshed = await openaiCodexOAuthProvider.refreshToken(credentials) as AccountCredential;
	return {
		...refreshed,
		accountId: refreshed.accountId ?? previous.accountId,
		accountLabel: account.label,
		providerId: account.providerId,
	};
}

let registeredProviderIds: string[] = [];

function unregisterAccountProviders(pi: ExtensionAPI) {
	for (const id of registeredProviderIds) {
		try { pi.unregisterProvider(id); } catch {}
	}
	registeredProviderIds = [];
}

function registerAccountProviders(pi: ExtensionAPI) {
	unregisterAccountProviders(pi);
	for (const account of loadAccounts()) {
		pi.registerProvider(account.providerId, {
			name: `Codex: ${account.label}`,
			baseUrl: CODEX_BASE_URL,
			api: CODEX_API,
			models: modelsForAccount(account),
			oauth: {
				name: `Codex: ${account.label}`,
				usesCallbackServer: openaiCodexOAuthProvider.usesCallbackServer,
				login: loginForAccount(account),
				refreshToken: (credentials) => refreshForAccount(account, credentials),
				getApiKey: (credentials) => openaiCodexOAuthProvider.getApiKey(credentials),
			},
		});
		registeredProviderIds.push(account.providerId);
	}
}

function authStorage() {
	return AuthStorage.create();
}

function findAccount(accounts: StoredAccount[], labelOrProvider: string) {
	const normalized = normalizeLabel(labelOrProvider);
	const providerId = normalized.startsWith(PROVIDER_PREFIX) ? normalized : providerIdFor(normalized);
	return accounts.find((a) =>
		a.label.toLowerCase() === normalized.toLowerCase() ||
		a.providerId.toLowerCase() === providerId.toLowerCase()
	);
}

function formatAccounts(accounts: StoredAccount[]) {
	if (!accounts.length) return "No Codex accounts configured.";
	const auth = authStorage();
	return accounts.map((account) => {
		const loggedIn = auth.has(account.providerId) ? "✓" : "○";
		return `${loggedIn} ${account.label} (${account.providerId})`;
	}).join("\n");
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

type UsageStatus = { score: number; label: string };
type AutoSubscriptionOptions = { forceRefresh?: boolean; accountLabel?: string };

function parseUsageStatus(data: any): UsageStatus | undefined {
	const used = data?.rate_limit?.primary_window?.used_percent;
	if (typeof used === "number" && !Number.isNaN(used)) {
		const left = Math.max(0, Math.min(100, Math.round(100 - used)));
		return { score: left, label: `${left}% left` };
	}
	if (data?.rate_limit?.allowed === true) return { score: 100, label: "allowed" };
	if (data?.rate_limit?.limit_reached === true) return { score: 0, label: "rate limit reached" };
	if (data?.spend_control?.reached === false && data?.credits?.overage_limit_reached !== true) {
		return { score: -1, label: "usage-based/skipped" };
	}
	if (data?.spend_control?.reached === true || data?.credits?.overage_limit_reached === true) return { score: 0, label: "spend limit reached" };
	return undefined;
}

async function forceRefreshOAuth(ctx: ExtensionCommandContext, account: StoredAccount) {
	const auth = ctx.modelRegistry.authStorage;
	const credential = auth.get(account.providerId);
	if (credential?.type !== "oauth") return;
	const expiredCredential = { ...credential, expires: 0 };
	auth.set(account.providerId, expiredCredential);
	try {
		const token = await ctx.modelRegistry.getApiKeyForProvider(account.providerId);
		if (!token) {
			auth.set(account.providerId, credential);
			throw new Error("OAuth refresh failed");
		}
	} catch (error) {
		auth.set(account.providerId, credential);
		throw error;
	}
}

async function queryUsage(ctx: ExtensionCommandContext, account: StoredAccount) {
	const token = await ctx.modelRegistry.getApiKeyForProvider(account.providerId);
	const credential = ctx.modelRegistry.authStorage.get(account.providerId) as AccountCredential | undefined;
	const accountId = (token ? accountIdFromJwt(token) : undefined) || credential?.accountId;
	if (!token || !accountId) throw new Error("missing Codex OAuth token/account id");
	const response = await fetch("https://chatgpt.com/backend-api/wham/usage", {
		headers: {
			accept: "*/*",
			authorization: `Bearer ${token}`,
			"chatgpt-account-id": accountId,
		},
		signal: AbortSignal.timeout(10_000),
	});
	if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
	const status = parseUsageStatus(await response.json());
	if (!status) throw new Error("usage response has no recognized quota/spend fields");
	return status;
}

function publishProviderSync(provider: string, modelId: string) {
	mkdirSync(dirname(SYNC_STATE_PATH), { recursive: true });
	writeFileSync(SYNC_STATE_PATH, `${JSON.stringify({ version: 1, provider, modelId, updatedAt: Date.now(), pid: process.pid }, null, 2)}\n`, "utf8");
}

async function autoSubscription(pi: ExtensionAPI, ctx: ExtensionCommandContext, modelId = "gpt-5.5", options: AutoSubscriptionOptions = {}) {
	let accounts = loadAccounts().filter((account) => authStorage().has(account.providerId));
	if (options.accountLabel) {
		const account = findAccount(accounts, options.accountLabel);
		if (!account) {
			const message = `Logged-in Codex account "${options.accountLabel}" not found.`;
			pi.sendMessage({ customType: "codex-autosub", content: message, display: true });
			ctx.ui.notify(message, "warning");
			return;
		}
		accounts = [account];
	}
	if (!accounts.length) {
		pi.sendMessage({ customType: "codex-autosub", content: "No logged-in Codex accounts found.", display: true });
		ctx.ui.notify("No logged-in Codex accounts found.", "warning");
		return;
	}
	const refreshText = options.forceRefresh ? " (refreshing OAuth tokens)" : "";
	const accountText = options.accountLabel ? ` (${accounts[0].label})` : "";
	pi.sendMessage({ customType: "codex-autosub", content: `Checking ${accounts.length} Codex subscriptions${accountText} for ${modelId}${refreshText}...`, display: true });
	ctx.ui.notify(`Checking ${accounts.length} Codex subscriptions${accountText}${refreshText}...`, "info");
	const results = await Promise.all(accounts.map(async (account) => {
		try {
			if (options.forceRefresh) await forceRefreshOAuth(ctx, account);
			const usage = await queryUsage(ctx, account);
			return { account, usage };
		} catch (error) {
			return { account, error: error instanceof Error ? error.message : String(error) };
		}
	}));
	const usable = results.filter((r): r is { account: StoredAccount; usage: UsageStatus } => !!(r as any).usage && (r as any).usage.score > 0);
	if (!usable.length) {
		const report = `No usable subscription found.\n${results.map((r: any) => `${r.account.label}: ${r.usage?.label ?? r.error}`).join("\n")}`;
		pi.sendMessage({ customType: "codex-autosub", content: report, display: true });
		ctx.ui.notify(report, "warning");
		return;
	}
	usable.sort((a, b) => b.usage.score - a.usage.score);
	const picked = usable[0];
	const target = ctx.modelRegistry.find(picked.account.providerId, modelId);
	if (!target) {
		const message = `Model ${picked.account.providerId}/${modelId} not found.`;
		pi.sendMessage({ customType: "codex-autosub", content: message, display: true });
		ctx.ui.notify(message, "error");
		return;
	}
	await pi.setModel(target);
	publishProviderSync(picked.account.providerId, modelId);
	const report = [
		`Auto-selected ${picked.account.label} (${picked.usage.label}) → ${picked.account.providerId}/${modelId}`,
		"",
		"Checked:",
		...results.map((r: any) => `- ${r.account.label}: ${r.usage?.label ?? r.error}`),
	].join("\n");
	pi.sendMessage({ customType: "codex-autosub", content: report, display: true });
	ctx.ui.notify(`Auto-selected ${picked.account.label} (${picked.usage.label})`, "info");
}

function usage() {
	return [
		"Usage:",
		"  /codex-accounts",
		"  /codex-accounts add <label>",
		"  /codex-accounts list",
		"  /codex-accounts remove <label>",
		"  /codex-accounts relogin <label>",
		"",
		"After adding an account, run /login and pick its Codex provider.",
	].join("\n");
}

async function selectAccount(ctx: ExtensionCommandContext, prompt: string, accounts: StoredAccount[]) {
	if (!accounts.length) return undefined;
	const choices = accounts.map((a) => `${a.label} (${a.providerId})`);
	const picked = await ctx.ui.select(prompt, [...choices, "Cancel"]);
	if (!picked || picked === "Cancel") return undefined;
	const index = choices.indexOf(picked);
	return index >= 0 ? accounts[index] : undefined;
}

async function addAccount(pi: ExtensionAPI, ctx: ExtensionCommandContext, rawLabel?: string) {
	const label = normalizeLabel(rawLabel ?? await ctx.ui.input("Codex account label", "" ) ?? "");
	if (!label) {
		ctx.ui.notify("Cancelled.", "warning");
		return;
	}
	let providerId: string;
	try {
		providerId = providerIdFor(label);
	} catch (error) {
		ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
		return;
	}
	const accounts = loadAccounts();
	if (accounts.some((a) => a.label.toLowerCase() === label.toLowerCase() || a.providerId.toLowerCase() === providerId.toLowerCase())) {
		ctx.ui.notify(`Codex account "${label}" already exists.`, "warning");
		return;
	}
	accounts.push({ label, providerId, createdAt: new Date().toISOString() });
	saveAccounts(accounts);
	registerAccountProviders(pi);
	ctx.ui.notify(`Added Codex account "${label}". Run /login and pick "Codex: ${label}".`, "info");
}

async function removeAccount(pi: ExtensionAPI, ctx: ExtensionCommandContext, rawLabel?: string) {
	let accounts = loadAccounts();
	const account = rawLabel ? findAccount(accounts, rawLabel) : await selectAccount(ctx, "Remove Codex account", accounts);
	if (!account) {
		ctx.ui.notify(rawLabel ? `Codex account "${rawLabel}" not found.` : "Cancelled.", rawLabel ? "warning" : "info");
		return;
	}
	accounts = accounts.filter((a) => a.providerId !== account.providerId);
	saveAccounts(accounts);
	authStorage().remove(account.providerId);
	registerAccountProviders(pi);
	ctx.ui.notify(`Removed Codex account "${account.label}".`, "info");
}

async function reloginAccount(ctx: ExtensionCommandContext, rawLabel?: string) {
	const accounts = loadAccounts();
	const account = rawLabel ? findAccount(accounts, rawLabel) : await selectAccount(ctx, "Re-login Codex account", accounts);
	if (!account) {
		ctx.ui.notify(rawLabel ? `Codex account "${rawLabel}" not found.` : "Cancelled.", rawLabel ? "warning" : "info");
		return;
	}
	authStorage().remove(account.providerId);
	ctx.ui.notify(`Cleared credentials for "${account.label}". Run /login and pick "Codex: ${account.label}".`, "info");
}

async function interactiveMenu(pi: ExtensionAPI, ctx: ExtensionCommandContext) {
	const accounts = loadAccounts();
	const choice = await ctx.ui.select("Codex accounts", [
		...(accounts.length ? ["List accounts"] : []),
		"Add account",
		...(accounts.length ? ["Remove account", "Re-login account"] : []),
		"Cancel",
	]);
	if (!choice || choice === "Cancel") return;
	if (choice === "List accounts") {
		ctx.ui.notify(formatAccounts(loadAccounts()), "info");
		return;
	}
	if (choice === "Add account") return addAccount(pi, ctx);
	if (choice === "Remove account") return removeAccount(pi, ctx);
	if (choice === "Re-login account") return reloginAccount(ctx);
}

function parseAutoSubscriptionArgs(args: string) {
	const parts = args.trim().split(/\s+/).filter(Boolean);
	const accounts = loadAccounts();
	let forceRefresh = false;
	let accountLabel: string | undefined;
	const modelParts: string[] = [];
	for (const part of parts) {
		if (part === "--refresh" || part === "-r") {
			forceRefresh = true;
			continue;
		}
		if (forceRefresh && !accountLabel && findAccount(accounts, part)) {
			accountLabel = part;
			continue;
		}
		modelParts.push(part);
	}
	return { modelId: modelParts.join(" ") || "gpt-5.5", options: { forceRefresh, accountLabel } };
}

async function handleCommand(pi: ExtensionAPI, args: string, ctx: ExtensionCommandContext) {
	const parts = args.trim().split(/\s+/).filter(Boolean);
	const sub = parts[0]?.toLowerCase();
	const label = parts.slice(1).join(" ");
	if (!sub) return interactiveMenu(pi, ctx);
	if (sub === "add") return addAccount(pi, ctx, label);
	if (sub === "list" || sub === "ls") {
		ctx.ui.notify(formatAccounts(loadAccounts()), "info");
		return;
	}
	if (sub === "remove" || sub === "rm" || sub === "delete") return removeAccount(pi, ctx, label);
	if (sub === "relogin" || sub === "reset" || sub === "logout") return reloginAccount(ctx, label);
	if (sub === "help") {
		ctx.ui.notify(usage(), "info");
		return;
	}
	ctx.ui.notify(`Unknown command: ${sub}\n\n${usage()}`, "error");
}

export default function codexAccountsExtension(pi: ExtensionAPI) {
	registerAccountProviders(pi);

	pi.registerCommand("codex-accounts", {
		description: "Manage multiple ChatGPT/Codex OAuth accounts",
		handler: async (args, ctx) => handleCommand(pi, args, ctx),
	});

	const autosubCommand = {
		description: "Auto-select a logged-in Codex subscription with usage left and sync it across sessions. Usage: /as [--refresh [account]] [model]",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const parsed = parseAutoSubscriptionArgs(args);
			return autoSubscription(pi, ctx, parsed.modelId, parsed.options);
		},
	};
	pi.registerCommand("as", autosubCommand);
	pi.registerCommand("autosub", autosubCommand);
	pi.registerCommand("auto-sub", autosubCommand);

}

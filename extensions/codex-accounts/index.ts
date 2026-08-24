import type {
	CredentialStore,
	Model,
	OAuthAuth,
	OAuthCredential,
	Provider,
} from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const STORAGE_PATH = join(getAgentDir(), "codex-accounts.json");
const SYNC_STATE_PATH = join(getAgentDir(), "codex-provider-sync.json");
const PROVIDER_PREFIX = "codex-";
const BASE_PROVIDER = "openai-codex";
const GPT_5_6_CODEX_CONTEXT_WINDOW = 372_000;
const POST_SEAT_USAGE_ATTEMPTS = 12;
const POST_SEAT_USAGE_POLL_MS = 5_000;
const CODEX_PROVIDER_SYNC_CONTROL_CHANNEL = "codex-provider-sync:control";

export const CODEX_SEAT_REQUEST_CHANNEL = "codex-accounts:seat-request:v1";
export const CODEX_SELECTION_REQUEST_CHANNEL = "codex-accounts:selection-request:v1";
const CODEX_QUOTA_EVENT_CHANNEL = "codex-quota-log:event:v1";

const DISCOVERED_CODEX_PROVIDER = builtinProviders().find((provider) => provider.id === BASE_PROVIDER);
const DISCOVERED_CODEX_OAUTH = DISCOVERED_CODEX_PROVIDER?.auth.oauth;
if (!DISCOVERED_CODEX_PROVIDER || !DISCOVERED_CODEX_OAUTH) {
	throw new Error("Built-in OpenAI Codex provider is unavailable.");
}
const CODEX_PROVIDER: Provider = DISCOVERED_CODEX_PROVIDER;
const CODEX_OAUTH: OAuthAuth = DISCOVERED_CODEX_OAUTH;
const CODEX_MODELS = [...CODEX_PROVIDER.getModels()];

type StoredAccount = {
	label: string;
	providerId: string;
	createdAt?: string;
};

type StorageShape = {
	version: 1;
	accounts: StoredAccount[];
};

type AccountCredential = OAuthCredential & {
	accountId?: string;
	accountLabel?: string;
	providerId?: string;
};

type RuntimeCredentialAccess = {
	credentials: CredentialStore;
	logout(providerId: string): Promise<void>;
};

export type CodexOperationGuard = () => boolean;

export type CodexSeatRequestResultV1 =
	| { version: 1; status: "succeeded" }
	| { version: 1; status: "unavailable" | "failed"; message: string };

export type CodexSeatRequestV1 = {
	version: 1;
	context: ExtensionContext;
	guard: CodexOperationGuard;
	run?: Promise<CodexSeatRequestResultV1>;
};

export type CodexSelectionFailureCode =
	| "cancelled"
	| "account-not-found"
	| "no-accounts"
	| "no-usable-subscription"
	| "ambiguous-post-switch-state"
	| "model-unavailable"
	| "provider-sync-suppression-unavailable"
	| "model-selection-failed"
	| "post-selection-state-ambiguous"
	| "provider-sync-publish-failed"
	| "seat-request-failed"
	| "selection-handler-unavailable";

export type CodexSelectionResultV1 =
	| { version: 1; status: "selected"; provider: string; modelId: string; syncId: string }
	| { version: 1; status: "failed"; code: CodexSelectionFailureCode; message: string };

export type CodexSelectionRequestV1 = {
	version: 1;
	context: ExtensionContext;
	modelId: string;
	guard: CodexOperationGuard;
	run?: Promise<CodexSelectionResultV1>;
};

export type CodexUsageStatus = { score: number; label: string };
export type CodexAccountUsageEntry = {
	label: string;
	providerId: string;
	usage?: CodexUsageStatus;
	error?: string;
};

type AutoSubscriptionOptions = { forceRefresh?: boolean; accountLabel?: string };
type UsageCheck =
	| { account: StoredAccount; usage: CodexUsageStatus }
	| { account: StoredAccount; error: string };

type SelectionPolicy = {
	postSeat: boolean;
	suppressProviderSync: boolean;
};

function modelRuntime(ctx: ExtensionContext) {
	const runtime = (ctx.modelRegistry as unknown as { runtime?: RuntimeCredentialAccess }).runtime;
	if (!runtime?.credentials || typeof runtime.logout !== "function") {
		throw new Error("Pi model runtime credential access is unavailable.");
	}
	return runtime;
}

async function recordSelectedProvider(pi: ExtensionAPI, provider: string) {
	const request: {
		version: 1;
		kind: "provider-selected";
		provider: string;
		run?: Promise<void>;
	} = { version: 1, kind: "provider-selected", provider };
	pi.events.emit(CODEX_QUOTA_EVENT_CHANNEL, request);
	try {
		await request.run;
	} catch {
		/* Quota history is optional and must never block account selection. */
	}
}

function guardAllows(guard: CodexOperationGuard) {
	try {
		return guard();
	} catch {
		return false;
	}
}

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

function modelsForAccount(account: StoredAccount): Model<any>[] {
	return CODEX_MODELS.map((model) => ({
		...model,
		provider: account.providerId,
		name: `${account.label} · ${model.name || model.id}`,
		contextWindow: model.id.startsWith("gpt-5.6-") ? GPT_5_6_CODEX_CONTEXT_WINDOW : model.contextWindow,
	}));
}

function decorateCredential(account: StoredAccount, credential: OAuthCredential, previous?: AccountCredential): AccountCredential {
	return {
		...credential,
		accountId: (credential as AccountCredential).accountId ?? previous?.accountId,
		accountLabel: account.label,
		providerId: account.providerId,
	};
}

function providerForAccount(account: StoredAccount): Provider {
	const models = modelsForAccount(account);
	const oauth: OAuthAuth = {
		name: `Codex: ${account.label}`,
		loginLabel: CODEX_OAUTH.loginLabel,
		login: async (interaction) => decorateCredential(account, await CODEX_OAUTH.login(interaction)),
		refresh: async (credential, signal) =>
			decorateCredential(account, await CODEX_OAUTH.refresh(credential, signal), credential as AccountCredential),
		toAuth: (credential) => CODEX_OAUTH.toAuth(credential),
	};
	return {
		...CODEX_PROVIDER,
		id: account.providerId,
		name: `Codex: ${account.label}`,
		auth: { ...CODEX_PROVIDER.auth, oauth },
		getModels: () => models,
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
		pi.registerProvider(providerForAccount(account));
		registeredProviderIds.push(account.providerId);
	}
}

function findAccount(accounts: StoredAccount[], labelOrProvider: string) {
	const normalized = normalizeLabel(labelOrProvider);
	const providerId = normalized.startsWith(PROVIDER_PREFIX) ? normalized : providerIdFor(normalized);
	return accounts.find((account) =>
		account.label.toLowerCase() === normalized.toLowerCase() ||
		account.providerId.toLowerCase() === providerId.toLowerCase()
	);
}

async function formatAccounts(ctx: ExtensionCommandContext, accounts: StoredAccount[]) {
	if (!accounts.length) return "No Codex accounts configured.";
	const configured = new Set((await modelRuntime(ctx).credentials.list()).map((item) => item.providerId));
	return accounts.map((account) => {
		const loggedIn = configured.has(account.providerId) ? "✓" : "○";
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

export function parseCodexUsageStatus(data: any): CodexUsageStatus | undefined {
	if (data?.rate_limit?.limit_reached === true) return { score: 0, label: "rate limit reached" };
	if (data?.spend_control?.reached === true || data?.credits?.overage_limit_reached === true) {
		return { score: 0, label: "spend limit reached" };
	}
	const used = data?.rate_limit?.primary_window?.used_percent;
	if (typeof used === "number" && !Number.isNaN(used)) {
		const left = Math.max(0, Math.min(100, Math.round(100 - used)));
		return { score: left, label: `${left}% left` };
	}
	if (data?.rate_limit?.allowed === true) return { score: 100, label: "allowed" };
	if (data?.spend_control?.reached === false && data?.credits?.overage_limit_reached !== true) {
		return { score: -1, label: "usage-based/skipped" };
	}
	return undefined;
}

async function forceRefreshOAuth(ctx: ExtensionContext, account: StoredAccount) {
	const credentials = modelRuntime(ctx).credentials;
	let previousCredential: OAuthCredential | undefined;
	let expiredCredential: OAuthCredential | undefined;
	await credentials.modify(account.providerId, async (current) => {
		if (current?.type !== "oauth") throw new Error("missing Codex OAuth credentials");
		previousCredential = current;
		expiredCredential = { ...current, expires: 0 };
		return expiredCredential;
	});
	try {
		const token = await ctx.modelRegistry.getApiKeyForProvider(account.providerId);
		if (!token) throw new Error("OAuth refresh failed");
	} catch (error) {
		await credentials.modify(account.providerId, async (current) => {
			if (
				current?.type !== "oauth" ||
				!expiredCredential ||
				!previousCredential ||
				current.expires !== 0 ||
				current.access !== expiredCredential.access ||
				current.refresh !== expiredCredential.refresh
			) {
				return current;
			}
			return previousCredential;
		});
		throw error;
	}
}

async function queryUsage(ctx: ExtensionContext, account: StoredAccount) {
	const token = await ctx.modelRegistry.getApiKeyForProvider(account.providerId);
	const credential = await modelRuntime(ctx).credentials.read(account.providerId) as AccountCredential | undefined;
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
	const status = parseCodexUsageStatus(await response.json());
	if (!status) throw new Error("usage response has no recognized quota/spend fields");
	return status;
}

export function queryCodexProviderUsage(ctx: ExtensionContext, providerId: string) {
	return queryUsage(ctx, { label: providerId, providerId });
}

function publishProviderSync(provider: string, modelId: string, guard: CodexOperationGuard) {
	if (!guardAllows(guard)) return undefined;
	mkdirSync(dirname(SYNC_STATE_PATH), { recursive: true });
	const state = { version: 1 as const, provider, modelId, changeId: randomUUID(), updatedAt: Date.now(), pid: process.pid };
	const temporaryPath = `${SYNC_STATE_PATH}.${process.pid}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
		chmodSync(temporaryPath, 0o600);
		if (!guardAllows(guard)) return undefined;
		renameSync(temporaryPath, SYNC_STATE_PATH);
		chmodSync(SYNC_STATE_PATH, 0o600);
	} finally {
		try { unlinkSync(temporaryPath); } catch {}
	}
	return state;
}

function providerSyncMatches(provider: string, modelId: string, syncId: string) {
	try {
		const state = JSON.parse(readFileSync(SYNC_STATE_PATH, "utf8"));
		return state?.version === 1 && state.provider === provider && state.modelId === modelId && state.changeId === syncId;
	} catch {
		return false;
	}
}

type CodexProviderSyncControl = {
	action: "arm" | "cancel";
	token: string;
	provider?: string;
	model?: string;
	accepted?: boolean;
};

function armProviderSyncSuppression(pi: ExtensionAPI, provider: string, model: string) {
	const request: CodexProviderSyncControl = { action: "arm", token: randomUUID(), provider, model };
	pi.events.emit(CODEX_PROVIDER_SYNC_CONTROL_CHANNEL, request);
	return request.accepted ? request.token : undefined;
}

function cancelProviderSyncSuppression(pi: ExtensionAPI, token: string) {
	pi.events.emit(CODEX_PROVIDER_SYNC_CONTROL_CHANNEL, { action: "cancel", token } satisfies CodexProviderSyncControl);
}

function selectionFailure(code: CodexSelectionFailureCode, message: string): CodexSelectionResultV1 {
	return { version: 1, status: "failed", code, message };
}

function hasUsage(result: UsageCheck): result is Extract<UsageCheck, { usage: CodexUsageStatus }> {
	return "usage" in result;
}

export function hasUnambiguousPostSeatUsage(statuses: readonly (CodexUsageStatus | undefined)[]) {
	const observed = statuses.filter((status): status is CodexUsageStatus => status !== undefined);
	return observed.length === statuses.length && observed.filter((status) => status.score > 0).length === 1;
}

function postSeatStatuses(results: UsageCheck[]) {
	return results.map((result) => hasUsage(result) ? result.usage : undefined);
}

function usageReport(results: UsageCheck[]) {
	return results.map((result) => `${result.account.label}: ${hasUsage(result) ? result.usage.label : result.error}`).join("\n");
}

async function checkUsage(ctx: ExtensionContext, accounts: StoredAccount[], forceRefresh: boolean): Promise<UsageCheck[]> {
	return Promise.all(accounts.map(async (account): Promise<UsageCheck> => {
		try {
			if (forceRefresh) await forceRefreshOAuth(ctx, account);
			return { account, usage: await queryUsage(ctx, account) };
		} catch (error) {
			return { account, error: error instanceof Error ? error.message : String(error) };
		}
	}));
}

export async function queryCodexAccountUsage(
	ctx: ExtensionContext,
	forceRefresh = false,
): Promise<CodexAccountUsageEntry[]> {
	const configured = new Set((await modelRuntime(ctx).credentials.list()).map((item) => item.providerId));
	const accounts = loadAccounts().filter((account) => configured.has(account.providerId));
	const results = await checkUsage(ctx, accounts, forceRefresh);
	return results.map((result) => ({
		label: result.account.label,
		providerId: result.account.providerId,
		...(hasUsage(result) ? { usage: result.usage } : { error: result.error }),
	}));
}

export function formatCodexAccountUsage(entries: readonly CodexAccountUsageEntry[]) {
	if (!entries.length) return "No logged-in Codex accounts found.";
	return entries.map((entry) =>
		`${entry.label}: ${entry.usage?.label ?? entry.error ?? "unknown"}`
	).join("\n");
}

async function wait(milliseconds: number) {
	await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

async function autoSubscription(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	modelId = "gpt-5.6-sol",
	options: AutoSubscriptionOptions = {},
	guard: CodexOperationGuard = () => true,
	policy: SelectionPolicy = { postSeat: false, suppressProviderSync: false },
): Promise<CodexSelectionResultV1> {
	if (!guardAllows(guard)) return selectionFailure("cancelled", "Codex account selection was cancelled.");
	const configured = new Set((await modelRuntime(ctx).credentials.list()).map((item) => item.providerId));
	let accounts = loadAccounts().filter((account) => configured.has(account.providerId));
	if (!policy.postSeat && options.accountLabel) {
		const account = findAccount(accounts, options.accountLabel);
		if (!account) {
			const message = `Logged-in Codex account "${options.accountLabel}" not found.`;
			ctx.ui.notify(message, "warning");
			return selectionFailure("account-not-found", message);
		}
		accounts = [account];
	}
	if (!accounts.length) {
		const message = "No logged-in Codex accounts found.";
		ctx.ui.notify(message, "warning");
		return selectionFailure("no-accounts", message);
	}

	const forceRefresh = policy.postSeat || options.forceRefresh === true;
	const accountText = !policy.postSeat && options.accountLabel ? ` (${accounts[0].label})` : "";
	const refreshText = forceRefresh ? " (refreshing OAuth tokens)" : "";
	ctx.ui.notify(`Checking ${accounts.length} Codex subscriptions${accountText} for ${modelId}${refreshText}...`, "info");

	const attempts = policy.postSeat ? POST_SEAT_USAGE_ATTEMPTS : 1;
	let results: UsageCheck[] = [];
	let usable: Extract<UsageCheck, { usage: CodexUsageStatus }>[] = [];
	for (let attempt = 0; attempt < attempts; attempt++) {
		if (!guardAllows(guard)) return selectionFailure("cancelled", "Codex account selection was cancelled.");
		results = await checkUsage(ctx, accounts, forceRefresh);
		if (!guardAllows(guard)) return selectionFailure("cancelled", "Codex account selection was cancelled.");
		usable = results.filter((result): result is Extract<UsageCheck, { usage: CodexUsageStatus }> =>
			hasUsage(result) && result.usage.score > 0
		);
		if (!policy.postSeat || hasUnambiguousPostSeatUsage(postSeatStatuses(results))) break;
		if (attempt + 1 < attempts) await wait(POST_SEAT_USAGE_POLL_MS);
	}

	if (policy.postSeat && !hasUnambiguousPostSeatUsage(postSeatStatuses(results))) {
		const message = [
			`Post-switch Codex state is ambiguous after ${attempts} checks; expected exactly one usable subscription.`,
			usageReport(results),
		].join("\n");
		ctx.ui.notify(message, "error");
		return selectionFailure("ambiguous-post-switch-state", message);
	}
	if (!usable.length) {
		const message = `No usable subscription found.\n${usageReport(results)}`;
		ctx.ui.notify(message, "warning");
		return selectionFailure("no-usable-subscription", message);
	}
	if (!policy.postSeat) usable.sort((left, right) => right.usage.score - left.usage.score);
	const picked = usable[0];
	const target = ctx.modelRegistry.find(picked.account.providerId, modelId);
	if (!target) {
		const message = `Model ${picked.account.providerId}/${modelId} not found.`;
		ctx.ui.notify(message, "error");
		return selectionFailure("model-unavailable", message);
	}
	if (!guardAllows(guard)) return selectionFailure("cancelled", "Codex account selection was cancelled.");

	const suppressionToken = policy.suppressProviderSync
		? armProviderSyncSuppression(pi, picked.account.providerId, modelId)
		: undefined;
	if (policy.suppressProviderSync && !suppressionToken) {
		const message = "Codex provider sync suppression is unavailable; account selection stopped.";
		ctx.ui.notify(message, "error");
		return selectionFailure("provider-sync-suppression-unavailable", message);
	}
	try {
		if (!(await pi.setModel(target))) {
			const message = `Could not select ${picked.account.providerId}/${modelId}.`;
			ctx.ui.notify(message, "error");
			return selectionFailure("model-selection-failed", message);
		}
	} finally {
		if (suppressionToken) cancelProviderSyncSuppression(pi, suppressionToken);
	}
	if (!guardAllows(guard)) return selectionFailure("cancelled", "Codex account selection was cancelled.");
	if (ctx.model?.provider !== picked.account.providerId || ctx.model?.id !== modelId) {
		const message = "Codex model selection completed without a single observable active provider/model state.";
		ctx.ui.notify(message, "error");
		return selectionFailure("post-selection-state-ambiguous", message);
	}

	const syncState = publishProviderSync(picked.account.providerId, modelId, guard);
	if (!syncState) return selectionFailure("provider-sync-publish-failed", "Codex provider sync publication was cancelled.");
	if (!providerSyncMatches(picked.account.providerId, modelId, syncState.changeId)) {
		const message = "Codex provider sync state changed before the selection could be confirmed.";
		ctx.ui.notify(message, "error");
		return selectionFailure("post-selection-state-ambiguous", message);
	}
	const report = [
		`Auto-selected ${picked.account.label} (${picked.usage.label}) → ${picked.account.providerId}/${modelId}`,
		"",
		"Checked:",
		...results.map((result) => `- ${result.account.label}: ${hasUsage(result) ? result.usage.label : result.error}`),
	].join("\n");
	ctx.ui.notify(report, "info");
	return { version: 1, status: "selected", provider: picked.account.providerId, modelId, syncId: syncState.changeId };
}

export async function requestCodexSeatChange(
	pi: Pick<ExtensionAPI, "events">,
	context: ExtensionContext,
	guard: CodexOperationGuard,
): Promise<CodexSeatRequestResultV1> {
	if (!guardAllows(guard)) return { version: 1, status: "failed", message: "Codex seat request was cancelled." };
	const request: CodexSeatRequestV1 = { version: 1, context, guard };
	pi.events.emit(CODEX_SEAT_REQUEST_CHANNEL, request);
	if (!request.run) {
		return { version: 1, status: "unavailable", message: "The Codex seat automation companion is unavailable." };
	}
	try {
		return await request.run;
	} catch (error) {
		return {
			version: 1,
			status: "failed",
			message: error instanceof Error ? error.message : String(error),
		};
	}
}

export async function requestCodexAccountSelection(
	pi: Pick<ExtensionAPI, "events">,
	context: ExtensionContext,
	modelId: string,
	guard: CodexOperationGuard,
): Promise<CodexSelectionResultV1> {
	const request: CodexSelectionRequestV1 = { version: 1, context, modelId, guard };
	pi.events.emit(CODEX_SELECTION_REQUEST_CHANNEL, request);
	if (!request.run) {
		return selectionFailure("selection-handler-unavailable", "The Codex account selection handler is unavailable.");
	}
	try {
		return await request.run;
	} catch (error) {
		return selectionFailure(
			"selection-handler-unavailable",
			error instanceof Error ? error.message : String(error),
		);
	}
}

async function runAutoSubscription(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	modelId: string,
	options: AutoSubscriptionOptions,
	cycleSeat: boolean,
	guard: CodexOperationGuard,
) {
	if (!cycleSeat) return autoSubscription(pi, ctx, modelId, options, guard);
	ctx.ui.notify("Requesting a ChatGPT seat change from the private companion...", "info");
	const seat = await requestCodexSeatChange(pi, ctx, guard);
	if (seat.status !== "succeeded") {
		ctx.ui.notify(`ChatGPT seat change ${seat.status}: ${seat.message}`, seat.status === "failed" ? "error" : "warning");
		return selectionFailure("seat-request-failed", seat.message);
	}
	if (!guardAllows(guard)) return selectionFailure("cancelled", "Codex account selection was cancelled.");
	const selection = await autoSubscription(
		pi,
		ctx,
		modelId,
		{ forceRefresh: true },
		guard,
		{ postSeat: true, suppressProviderSync: false },
	);
	if (selection.status === "selected") await recordSelectedProvider(pi, selection.provider);
	return selection;
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
	const choices = accounts.map((account) => `${account.label} (${account.providerId})`);
	const picked = await ctx.ui.select(prompt, [...choices, "Cancel"]);
	if (!picked || picked === "Cancel") return undefined;
	const index = choices.indexOf(picked);
	return index >= 0 ? accounts[index] : undefined;
}

async function addAccount(pi: ExtensionAPI, ctx: ExtensionCommandContext, rawLabel?: string) {
	const label = normalizeLabel(rawLabel ?? await ctx.ui.input("Codex account label", "") ?? "");
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
	if (accounts.some((account) =>
		account.label.toLowerCase() === label.toLowerCase() || account.providerId.toLowerCase() === providerId.toLowerCase()
	)) {
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
	accounts = accounts.filter((candidate) => candidate.providerId !== account.providerId);
	saveAccounts(accounts);
	await modelRuntime(ctx).logout(account.providerId);
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
	await modelRuntime(ctx).logout(account.providerId);
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
		ctx.ui.notify(await formatAccounts(ctx, loadAccounts()), "info");
		return;
	}
	if (choice === "Add account") return addAccount(pi, ctx);
	if (choice === "Remove account") return removeAccount(pi, ctx);
	if (choice === "Re-login account") return reloginAccount(ctx);
}

function parseAutoSubscriptionArgs(args: string) {
	const parts = args.trim().split(/\s+/).filter(Boolean);
	const accounts = loadAccounts();
	let cycleSeat = false;
	let forceRefresh = false;
	let accountLabel: string | undefined;
	const modelParts: string[] = [];
	for (const part of parts) {
		if (part === "--auto") {
			cycleSeat = true;
			continue;
		}
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
	return { cycleSeat, modelId: modelParts.join(" ") || "gpt-5.6-sol", options: { forceRefresh, accountLabel } };
}

async function handleCommand(pi: ExtensionAPI, args: string, ctx: ExtensionCommandContext) {
	const parts = args.trim().split(/\s+/).filter(Boolean);
	const sub = parts[0]?.toLowerCase();
	const label = parts.slice(1).join(" ");
	if (!sub) return interactiveMenu(pi, ctx);
	if (sub === "add") return addAccount(pi, ctx, label);
	if (sub === "list" || sub === "ls") {
		ctx.ui.notify(await formatAccounts(ctx, loadAccounts()), "info");
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

function isSelectionRequest(value: unknown): value is CodexSelectionRequestV1 {
	if (!value || typeof value !== "object") return false;
	const request = value as Partial<CodexSelectionRequestV1>;
	return request.version === 1 &&
		typeof request.modelId === "string" && !!request.modelId.trim() &&
		!!request.context && typeof request.context === "object" &&
		typeof request.guard === "function";
}

export default function codexAccountsExtension(pi: ExtensionAPI) {
	registerAccountProviders(pi);
	let sessionGeneration = 0;
	let sessionActive = false;

	const unsubscribeSelectionRequests = pi.events.on(CODEX_SELECTION_REQUEST_CHANNEL, (value) => {
		if (!isSelectionRequest(value) || value.run) return;
		value.run = autoSubscription(
			pi,
			value.context,
			value.modelId.trim(),
			{ forceRefresh: true },
			value.guard,
			{ postSeat: true, suppressProviderSync: true },
		);
	});

	pi.on("session_start", () => {
		sessionGeneration++;
		sessionActive = true;
	});

	pi.on("session_shutdown", () => {
		sessionGeneration++;
		sessionActive = false;
		unsubscribeSelectionRequests();
	});

	pi.registerCommand("codex-accounts", {
		description: "Manage multiple ChatGPT/Codex OAuth accounts",
		handler: async (args, ctx) => handleCommand(pi, args, ctx),
	});
	pi.registerCommand("codex-usage", {
		description: "Print live usage for every logged-in Codex account without selecting one",
		handler: async (args, ctx) => {
			const normalized = args.trim();
			if (normalized && normalized !== "--refresh") {
				ctx.ui.notify("Usage: /codex-usage [--refresh]", "warning");
				return;
			}
			ctx.ui.notify(
				formatCodexAccountUsage(
					await queryCodexAccountUsage(ctx, normalized === "--refresh"),
				),
				"info",
			);
		},
	});

	const autosubCommand = {
		description: "Auto-select a logged-in Codex subscription with usage left and sync it across sessions. Usage: /as [--auto] [--refresh [account]] [model]",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const parsed = parseAutoSubscriptionArgs(args);
			const generation = sessionGeneration;
			const guard = () => sessionActive && generation === sessionGeneration;
			await runAutoSubscription(pi, ctx, parsed.modelId, parsed.options, parsed.cycleSeat, guard);
		},
	};
	pi.registerCommand("as", autosubCommand);
	pi.registerCommand("autosub", autosubCommand);
	pi.registerCommand("auto-sub", autosubCommand);
}

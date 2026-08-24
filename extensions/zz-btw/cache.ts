export type JsonRecord = Record<string, unknown>;

export type ForkPayloadResult = {
	payload: JsonRecord;
	sharedInputItems: number;
	suffixInputItems: number;
};

export type CacheUsage = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: { total: number };
};

export class CacheSafetyError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CacheSafetyError";
	}
}

export function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function cloneValue<T>(value: T): T {
	return structuredClone(value);
}

function sameSerializedValue(left: unknown, right: unknown) {
	return JSON.stringify(left) === JSON.stringify(right);
}

function isExactSidePromptItem(value: unknown, expected: string) {
	if (!isRecord(value) || value.role !== "user" || !Array.isArray(value.content) || value.content.length !== 1) return false;
	const content = value.content[0];
	return isRecord(content) && content.type === "input_text" && content.text === expected;
}

export function promptCacheKey(payload: unknown): string | undefined {
	if (!isRecord(payload)) return undefined;
	return typeof payload.prompt_cache_key === "string" && payload.prompt_cache_key.length > 0
		? payload.prompt_cache_key
		: undefined;
}

export function buildCacheForkPayload(parentPayload: unknown, candidatePayload: unknown, sidePrompt: string): ForkPayloadResult {
	if (!isRecord(parentPayload) || !isRecord(candidatePayload)) {
		throw new CacheSafetyError("Provider payload is not an object.");
	}
	if (!Array.isArray(parentPayload.input) || !Array.isArray(candidatePayload.input)) {
		throw new CacheSafetyError("Provider payload has no Responses input array.");
	}
	const cacheKey = promptCacheKey(parentPayload);
	if (!cacheKey) throw new CacheSafetyError("Parent request has no prompt_cache_key.");
	if (candidatePayload.input.length <= parentPayload.input.length) {
		throw new CacheSafetyError("Side request did not append any input after the parent prefix.");
	}

	const candidatePrefix = candidatePayload.input.slice(0, parentPayload.input.length);
	if (!sameSerializedValue(candidatePrefix, parentPayload.input)) {
		throw new CacheSafetyError("Generated side request does not preserve the exact parent input prefix.");
	}
	const suffix = candidatePayload.input.slice(parentPayload.input.length);
	if (!isExactSidePromptItem(suffix.at(-1), sidePrompt)) {
		throw new CacheSafetyError("Generated side suffix does not end with the exact side prompt message.");
	}

	const payload = cloneValue(parentPayload);
	payload.input = cloneValue(candidatePayload.input);
	payload.prompt_cache_key = cacheKey;
	payload.store = false;
	payload.stream = true;

	return {
		payload,
		sharedInputItems: parentPayload.input.length,
		suffixInputItems: suffix.length,
	};
}

export function roughSharedTokenEstimate(payload: unknown): number {
	if (!isRecord(payload)) return 0;
	const cacheable = {
		instructions: payload.instructions,
		tools: payload.tools,
		input: payload.input,
	};
	return Math.floor(JSON.stringify(cacheable).length / 4);
}

export function cacheHitRatio(usage: Pick<CacheUsage, "input" | "cacheRead" | "cacheWrite">): number {
	const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
	return promptTokens > 0 ? usage.cacheRead / promptTokens : 0;
}

export function formatTokens(value: number): string {
	if (value < 1_000) return String(value);
	if (value < 10_000) return `${(value / 1_000).toFixed(1)}k`;
	if (value < 1_000_000) return `${Math.round(value / 1_000)}k`;
	return `${(value / 1_000_000).toFixed(1)}M`;
}

export function formatUsage(usage: CacheUsage): string {
	const ratio = cacheHitRatio(usage);
	const cache = usage.cacheRead > 0
		? `cache ${formatTokens(usage.cacheRead)} (${(ratio * 100).toFixed(0)}%)`
		: "cache MISS";
	const write = usage.cacheWrite > 0 ? ` · write ${formatTokens(usage.cacheWrite)}` : "";
	return `in ${formatTokens(usage.input)} · ${cache}${write} · out ${formatTokens(usage.output)} · $${usage.cost.total.toFixed(4)}`;
}

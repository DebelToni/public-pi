import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type ModelLike = {
	api?: string;
	provider?: string;
	reasoning?: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function supportsCliFast(model: ModelLike | undefined) {
	if (!model?.reasoning) return false;
	const provider = model.provider;
	const providerSupported = provider === "openai"
		|| provider === "openai-responses"
		|| provider === "openai-codex"
		|| !!provider?.startsWith("codex-");
	return providerSupported && (model.api === "openai-responses" || model.api === "openai-codex-responses");
}

export function applyCliFast(payload: unknown, model: ModelLike | undefined, enabled: boolean) {
	if (!enabled || !supportsCliFast(model) || !isRecord(payload)) return undefined;
	const reasoning = isRecord(payload.reasoning) ? payload.reasoning : {};
	return {
		...payload,
		reasoning: { ...reasoning, effort: "medium" },
		service_tier: "priority",
	};
}

export default function cliFast(pi: ExtensionAPI) {
	pi.registerFlag("fast", {
		description: "Use medium reasoning with OpenAI/Codex priority mode for this invocation",
		type: "boolean",
		default: false,
	});

	pi.on("session_start", (_event, ctx) => {
		if (pi.getFlag("fast") === true && !supportsCliFast(ctx.model)) {
			ctx.ui.notify("--fast requires a reasoning-capable OpenAI/Codex Responses model.", "warning");
		}
	});

	pi.on("before_provider_request", (event, ctx) => {
		return applyCliFast(event.payload, ctx.model, pi.getFlag("fast") === true);
	});
}

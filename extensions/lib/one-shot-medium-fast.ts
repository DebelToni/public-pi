export const ONE_SHOT_MEDIUM_FAST_CHANNEL = "openai-plus:one-shot-medium-fast";

export type OneShotMediumFastRequest = {
	action: "arm" | "cancel";
	accepted?: boolean;
};

type ModelLike = {
	api?: string;
	provider?: string;
	reasoning?: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function supportsOneShotMediumFast(model: ModelLike | undefined) {
	if (!model?.reasoning) return false;
	const provider = model.provider;
	const providerSupported = provider === "openai"
		|| provider === "openai-responses"
		|| provider === "openai-codex"
		|| !!provider?.startsWith("codex-");
	return providerSupported && (model.api === "openai-responses" || model.api === "openai-codex-responses");
}

function contentText(content: unknown) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return undefined;
	const texts: string[] = [];
	for (const part of content) {
		if (!isRecord(part)) continue;
		if ((part.type === "input_text" || part.type === "text") && typeof part.text === "string") texts.push(part.text);
	}
	return texts.length > 0 ? texts.join("\n") : undefined;
}

export function latestUserText(payload: unknown) {
	if (!isRecord(payload) || !Array.isArray(payload.input)) return undefined;
	for (let index = payload.input.length - 1; index >= 0; index--) {
		const item = payload.input[index];
		if (!isRecord(item) || item.role !== "user") continue;
		return contentText(item.content);
	}
	return undefined;
}

export function applyMediumFast(payload: unknown) {
	if (!isRecord(payload)) return undefined;
	const reasoning = isRecord(payload.reasoning) ? payload.reasoning : {};
	return {
		...payload,
		reasoning: { ...reasoning, effort: "medium" },
		service_tier: "priority",
	};
}

export class OneShotMediumFastState {
	private armed = false;
	private pending = false;
	private awaitingUser = false;
	private active = false;
	private targetText?: string;

	arm() {
		this.clear();
		this.armed = true;
	}

	cancel() {
		this.clear();
	}

	onInput(source: "interactive" | "rpc" | "extension", streamingBehavior?: "steer" | "followUp") {
		if (source !== "interactive") {
			if (!this.active) this.clear();
			return;
		}
		if (streamingBehavior) return;
		if (this.armed) {
			this.armed = false;
			this.pending = true;
			return;
		}
		if (!this.active) this.clear();
	}

	onBeforeAgentStart(prompt: string) {
		if (!this.pending) return;
		this.pending = false;
		this.awaitingUser = true;
		this.targetText = prompt;
	}

	onUserMessage(text: string) {
		if (this.awaitingUser) {
			this.awaitingUser = false;
			if (text === this.targetText) {
				this.active = true;
				return;
			}
			this.clear();
			return;
		}
		if (this.active) this.clear();
	}

	rewrite(payload: unknown, model: ModelLike | undefined) {
		if (!this.active || !this.targetText || !supportsOneShotMediumFast(model)) return undefined;
		if (latestUserText(payload) !== this.targetText) return undefined;
		return applyMediumFast(payload);
	}

	clear() {
		this.armed = false;
		this.pending = false;
		this.awaitingUser = false;
		this.active = false;
		this.targetText = undefined;
	}
}

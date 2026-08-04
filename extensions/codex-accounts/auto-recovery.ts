import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

// Compatibility signal surface for the existing compaction extension.
// Recovery coordination and installation are owned by codex-seat-automation.
export const CODEX_USAGE_LIMIT_SIGNAL_CHANNEL = "codex-auto-recovery:usage-limit-signal";

export type CodexUsageLimitCandidate = {
	provider: string;
	model: string;
};

export type CodexUsageLimitSignal = CodexUsageLimitCandidate & {
	context: ExtensionContext;
};

export function isCodexProvider(provider?: string) {
	return provider === "openai-codex" || !!provider?.startsWith("codex-");
}

export function isCodexUsageLimitErrorText(value: string) {
	const text = value.trim();
	return /^(?:Codex error:\s*)?You have hit your ChatGPT usage limit \([^()\r\n]+ plan\)\. Try again in ~\d+ min\.$/i.test(text)
		|| /^(?:Codex error:\s*)?The usage limit has been reached\.?$/i.test(text);
}

export function getCodexUsageLimitCandidate(message: AssistantMessage): CodexUsageLimitCandidate | undefined {
	if (
		message.role !== "assistant" ||
		message.api !== "openai-codex-responses" ||
		message.stopReason !== "error" ||
		!isCodexProvider(message.provider) ||
		!message.errorMessage ||
		!isCodexUsageLimitErrorText(message.errorMessage)
	) {
		return undefined;
	}
	return { provider: message.provider, model: message.model };
}

export function isConfirmedCodexUsageLimit(message: AssistantMessage) {
	return getCodexUsageLimitCandidate(message) !== undefined;
}

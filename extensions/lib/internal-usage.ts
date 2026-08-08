import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const INTERNAL_USAGE_TYPE = "pi-internal-llm-usage";

export function recordInternalUsage(pi: ExtensionAPI, source: string, model: Model<any>, response: AssistantMessage) {
	pi.appendEntry(INTERNAL_USAGE_TYPE, {
		source,
		provider: model.provider,
		model: model.id,
		api: model.api,
		usage: response.usage,
		stopReason: response.stopReason,
		responseId: response.responseId,
		timestamp: Date.now(),
	});
}

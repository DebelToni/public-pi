import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export const CONTINUATION_REQUEST_CHANNEL = "subagent:continue-request";

export type ContinuationRequest = {
	context: ExtensionContext;
	target?: "main";
	run?: Promise<void>;
};

export function requestContinuation(
	pi: ExtensionAPI,
	context: ExtensionContext,
	options: Pick<ContinuationRequest, "target"> = {},
) {
	const request: ContinuationRequest = { context, ...options };
	pi.events.emit(CONTINUATION_REQUEST_CHANNEL, request);
	if (!request.run) throw new Error("The /continue mechanism is unavailable.");
	return request.run;
}

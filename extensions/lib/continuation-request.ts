import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export const CONTINUATION_REQUEST_CHANNEL = "pi:continue-request";
export const LEGACY_CONTINUATION_REQUEST_CHANNEL = "subagent:continue-request";

export type ContinuationRequest = {
	context: ExtensionContext;
	target?: "main";
	run?: Promise<void>;
	/** Await once before starting work. Outstanding work may need its own recovery lease. */
	beforeWork?: (kind: "outstanding" | "main") => Promise<void>;
	/** Called immediately after submitting the final parent trigger, not after settlement. */
	onStarted?: () => void;
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

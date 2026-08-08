import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const CONTINUATION_REQUEST_CHANNEL = "subagent:continue-request";
const MAIN_CONTINUATION_MESSAGE_TYPE = "main-continuation";
const MAIN_CONTINUATION_CONTENT = "<system-reminder>\nContinue the interrupted main task from the current conversation and external state. Preserve completed work, verify uncertain side effects, and do not restart the task unnecessarily.\n</system-reminder>";

type ContinuationRequest = {
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
	if (request.run) return request.run;
	if (request.target === "main") {
		return pi.sendMessage(
			{
				customType: MAIN_CONTINUATION_MESSAGE_TYPE,
				content: MAIN_CONTINUATION_CONTENT,
				display: false,
			},
			{ deliverAs: "steer", triggerTurn: true },
		);
	}
	throw new Error("The /continue mechanism is unavailable.");
}

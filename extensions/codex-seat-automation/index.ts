import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	installSeatRequestHook,
	readSeatAutomationConfig,
	seatRequestTransportV1,
} from "./seat-request.js";
import { installSeatCycleCheck } from "./seat-cycle-check.js";

export { installSeatRequestHook, readSeatAutomationConfig, seatRequestTransportV1 } from "./seat-request.js";
export type { CodexSeatRequestTransportV1, SeatAutomationConfigV1 } from "./seat-request.js";

export default async function codexSeatAutomationExtension(pi: ExtensionAPI) {
	installSeatRequestHook(pi);
	installSeatCycleCheck(pi);
	let automaticRecovery = false;
	let configurationError: string | undefined;
	try {
		const config = readSeatAutomationConfig();
		automaticRecovery = config?.automaticRecovery === true;
	} catch (error) {
		configurationError = error instanceof Error ? error.message : String(error);
	}
	if (automaticRecovery) {
		const { installAutoRecovery } = await import("./recovery.js");
		installAutoRecovery(pi);
	}
	if (configurationError) {
		pi.on("session_start", (_event, context) => {
			context.ui.notify(`Codex seat automation is unavailable: ${configurationError}`, "error");
		});
	}
}

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { installSeatRequestHook } from "./seat-request.js";

export { installSeatRequestHook, readSeatAutomationConfig, seatRequestTransportV1 } from "./seat-request.js";
export type { CodexSeatRequestTransportV1, SeatAutomationConfigV1 } from "./seat-request.js";

export default function codexSeatAutomationFriendExtension(pi: ExtensionAPI) {
	installSeatRequestHook(pi);
}

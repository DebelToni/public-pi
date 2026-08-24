import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const STEERING_CONTINUITY_REMINDER = `<system-reminder>
Treat this as additive work or clarification for the active task. Preserve and complete all unfinished, non-conflicting prior work. In the final response, report the results requested by the active task and each additive steering message, in their original order.
</system-reminder>`;

export const STEERING_CONTINUITY_MESSAGE_TYPE = "steering-continuity";

export default function (pi: ExtensionAPI) {
	pi.on("input", (event) => {
		if (event.streamingBehavior !== "steer") return { action: "continue" };
		pi.sendMessage({
			customType: STEERING_CONTINUITY_MESSAGE_TYPE,
			content: STEERING_CONTINUITY_REMINDER,
			display: false,
		}, { deliverAs: "steer" });
		return { action: "continue" };
	});
}

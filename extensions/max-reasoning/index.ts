import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export const TOOL_DESCRIPTION = "Switches your reasoning level to max if the task is demanding, scientific or requires more smartness. It's a one-way switch.";

export function installMaxReasoning(pi: ExtensionAPI) {
	pi.on("session_start", (event) => {
		if (event.reason !== "reload") pi.setThinkingLevel("high");
	});

	pi.registerTool({
		name: "switch_to_max_reasoning",
		label: "Max Reasoning",
		description: TOOL_DESCRIPTION,
		parameters: Type.Object({}),
		async execute() {
			pi.setThinkingLevel("max");
			const level = pi.getThinkingLevel();
			return {
				content: [{
					type: "text" as const,
					text: level === "max"
						? "Reasoning level switched to max."
						: `The active model limited reasoning to ${level}.`,
				}],
				details: { thinkingLevel: level },
			};
		},
	});
}

export default function maxReasoning(pi: ExtensionAPI) {
	if (process.env.PI_SUBAGENT === "1") return;
	installMaxReasoning(pi);
}

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function deepThink(pi: ExtensionAPI): void {
	pi.registerFlag("deep_think", {
		description: "Enable the deep_think reasoning scratchpad tool",
		type: "boolean",
		default: false,
	});

	pi.on("session_start", () => {
		if (pi.getFlag("deep_think") !== true) return;

		pi.registerTool({
			name: "deep_think",
			label: "Deep Think",
			description: "Write your reasoning scratchpad here.",
			parameters: {
				type: "object",
				properties: {
					text: { type: "string", description: "Plaintext reasoning scratchpad." },
				},
				required: ["text"],
				additionalProperties: false,
			} as any,
			async execute() {
				return { content: [] };
			},
		});
	});
}

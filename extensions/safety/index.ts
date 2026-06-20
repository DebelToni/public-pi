import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isBashToolResult, isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { headTail } from "../modes/shared.js";

export default function (pi: ExtensionAPI) {
	pi.on("input", async (event) => {
		// Strip leaked raw modified-key / paste CSI sequences before they reach the model.
		const cleaned = event.text
			.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
			.replace(/\[27;[0-9;]+~/g, "")
			.replace(/\x1b\[[0-9;?]*~/g, "");
		if (cleaned !== event.text) return { action: "transform", text: cleaned, images: event.images };
		return { action: "continue" };
	});

	pi.on("tool_call", async (event) => {
		if (isToolCallEventType("bash", event)) {
			const command = event.input.command ?? "";
			if (/\brm\s+-rf\s+(\*|\/|~|\.\.?\/?\s*$)/.test(command)) {
				return { block: true, reason: "Blocked dangerous rm -rf pattern by safety extension." };
			}
		}
	});

	pi.on("tool_result", async (event) => {
		if (!isBashToolResult(event)) return;
		const content = event.content.map((c: any) => c?.type === "text" ? { ...c, text: headTail(c.text) } : c);
		return { content };
	});
}

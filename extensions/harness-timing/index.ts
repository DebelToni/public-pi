import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const HOUR = 60 * 60 * 1000;
const dateFormat = new Intl.DateTimeFormat("en-US", {
	timeZone: "Europe/Sofia",
	month: "short",
	day: "numeric",
	hour: "2-digit",
	minute: "2-digit",
	hourCycle: "h23",
});

function date(timestamp: number) {
	return dateFormat.format(timestamp).replace(",", "");
}

export default function harnessTiming(pi: ExtensionAPI) {
	// Pi applies this replacement before saving the user message and preparing
	// the model request, so storage, replay and model context share the same tag.
	pi.on("message_end", (event, ctx) => {
		const message = event.message;
		if (message.role !== "user") return;
		const firstText = typeof message.content === "string" ? message.content
			: message.content.find((block) => block.type === "text")?.text;
		if (firstText?.startsWith("<harness_timing>\n")) return;

		let previousUser: number | undefined;
		let finished: number | undefined;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "message") continue;
			const previous = entry.message;
			if (previous.role === "user") {
				previousUser = previous.timestamp;
				finished = undefined;
			} else if (previous.role === "assistant") {
				// The entry timestamp is saved after completion, unlike the
				// assistant message timestamp, which records generation start.
				finished = previous.stopReason === "stop"
					&& previous.content.some((block) => block.type === "text" && block.text.trim())
					&& !previous.content.some((block) => block.type === "toolCall")
					? Date.parse(entry.timestamp)
					: undefined;
			}
		}
		const gap = previousUser !== undefined && message.timestamp - previousUser > 3 * HOUR;
		const longRun = previousUser !== undefined && finished !== undefined
			&& finished <= message.timestamp && finished - previousUser > HOUR;
		const lines: string[] = [];
		if (gap) lines.push(`previous user: ${date(previousUser!)}`);
		if (longRun) {
			if (!gap) lines.push(`agent started: ${date(previousUser!)}`);
			lines.push(`agent finished: ${date(finished!)}`);
		}
		if (gap) lines.push(`current user: ${date(message.timestamp)}`);
		if (!lines.length) return;
		const tag = `<harness_timing>\n${lines.join("\n")}\n</harness_timing>\n\n`;
		return {
			message: {
				...message,
				content: typeof message.content === "string"
					? tag + message.content
					: [{ type: "text", text: tag }, ...message.content],
			},
		};
	});
}

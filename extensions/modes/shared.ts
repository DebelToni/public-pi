import type { Message } from "@earendil-works/pi-ai";

export function stripAnsi(input: string) {
	return input
		.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
		.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "");
}

export function headTail(text: string, maxChars = 48_000) {
	if (text.length <= maxChars) return text;
	const headChars = Math.floor(maxChars * 0.25);
	const tailChars = maxChars - headChars - 200;
	return `${text.slice(0, headChars)}\n\n… [middle truncated; showing head + latest tail] …\n\n${text.slice(-tailChars)}`;
}

export function textOfMessage(message: Message): string {
	return (message.content ?? [])
		.map((part: any) => {
			if (part?.type === "text") return part.text;
			if (part?.type === "toolCall") return `[tool:${part.name}] ${JSON.stringify(part.arguments ?? {})}`;
			if (part?.type === "image") return "[image]";
			return "";
		})
		.filter(Boolean)
		.join("\n");
}

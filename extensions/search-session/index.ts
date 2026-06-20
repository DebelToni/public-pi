import type { Message } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { textOfMessage } from "../modes/shared.js";

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "search_session",
		label: "Search Session",
		description: "Search the current Pi session transcript. Use to recover prior context without rereading the whole session.",
		parameters: Type.Object({ query: Type.String(), regex: Type.Optional(Type.Boolean()), maxMatches: Type.Optional(Type.Number()), role: Type.Optional(Type.String()) }),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const re = new RegExp(params.regex ? params.query : params.query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
			const max = Math.max(1, Math.min(50, params.maxMatches ?? 10));
			const hits: string[] = [];
			let i = 0;
			for (const e of ctx.sessionManager.getBranch()) {
				if (e.type !== "message") continue;
				i++;
				if (params.role && e.message.role !== params.role) continue;
				const text = textOfMessage(e.message as Message);
				if (re.test(text)) hits.push(`## #${i} ${e.message.role}\n\n${truncateToWidth(text.replace(/\s+/g, " "), 2000)}`);
				if (hits.length >= max) break;
			}
			return { content: [{ type: "text", text: hits.length ? hits.join("\n\n") : "No matches." }], details: { count: hits.length } };
		},
	});
}

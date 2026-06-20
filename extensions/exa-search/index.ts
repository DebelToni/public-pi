import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const EXA_API_URL = "https://api.exa.ai";

type ExaResult = {
	title?: string;
	url?: string;
	publishedDate?: string;
	author?: string;
	score?: number;
	text?: string;
	highlights?: string[];
	summary?: string;
};

function getApiKey() {
	if (process.env.EXA_API_KEY) return process.env.EXA_API_KEY;
	try {
		const envPath = join(homedir(), ".env-EXA");
		if (!existsSync(envPath)) return undefined;
		const text = readFileSync(envPath, "utf8");
		const match = text.match(/^\s*(?:export\s+)?EXA_API_KEY\s*=\s*["']?([^"'\n]+)["']?/m);
		return match?.[1]?.trim();
	} catch {
		return undefined;
	}
}

function cleanText(s: string, max = 4000) {
	return s.replace(/\s+/g, " ").trim().slice(0, max);
}

function formatResults(results: ExaResult[], includeText: boolean) {
	if (!results.length) return "No results.";
	return results.map((r, i) => {
		const parts = [
			`## ${i + 1}. ${r.title || "Untitled"}`,
			r.url ? r.url : undefined,
			r.publishedDate ? `published: ${r.publishedDate}` : undefined,
			r.author ? `author: ${r.author}` : undefined,
			r.summary ? `summary: ${cleanText(r.summary, 1200)}` : undefined,
			r.highlights?.length ? `highlights:\n${r.highlights.map((h) => `- ${cleanText(h, 800)}`).join("\n")}` : undefined,
			includeText && r.text ? `text:\n${cleanText(r.text)}` : undefined,
		];
		return parts.filter(Boolean).join("\n");
	}).join("\n\n");
}

async function exaPost(path: string, body: unknown, signal?: AbortSignal) {
	const apiKey = getApiKey();
	if (!apiKey) throw new Error("EXA_API_KEY is not set");
	const res = await fetch(`${EXA_API_URL}${path}`, {
		method: "POST",
		headers: { "content-type": "application/json", "x-api-key": apiKey },
		body: JSON.stringify(body),
		signal,
	});
	const text = await res.text();
	let json: any;
	try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
	if (!res.ok) throw new Error(`Exa ${res.status}: ${json?.error || json?.message || text}`);
	return json;
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "exa_search",
		label: "Exa Search",
		description: "Search the web with Exa. Requires EXA_API_KEY in the environment.",
		parameters: Type.Object({
			query: Type.String({ description: "Search query" }),
			numResults: Type.Optional(Type.Number({ description: "Number of results, 1-10", default: 5 })),
			includeText: Type.Optional(Type.Boolean({ description: "Fetch page text snippets when supported", default: false })),
		}),
		async execute(_id, params, signal) {
			const numResults = Math.max(1, Math.min(10, params.numResults ?? 5));
			const body: any = { query: params.query, type: "auto", numResults };
			if (params.includeText) body.contents = { text: { maxCharacters: 3000 }, highlights: true, summary: true };
			let data: any;
			try {
				data = await exaPost("/search", body, signal);
			} catch (err) {
				if (!params.includeText) throw err;
				data = await exaPost("/search", { query: params.query, type: "auto", numResults }, signal);
			}
			const results = (data.results ?? []) as ExaResult[];
			return { content: [{ type: "text", text: formatResults(results, !!params.includeText) }], details: data };
		},
	});

	pi.registerTool({
		name: "exa_answer",
		label: "Exa Answer",
		description: "Ask Exa for a sourced answer. Requires EXA_API_KEY in the environment.",
		parameters: Type.Object({ query: Type.String({ description: "Question to answer" }) }),
		async execute(_id, params, signal) {
			const data = await exaPost("/answer", { query: params.query, text: true }, signal);
			const answer = data.answer || data.text || JSON.stringify(data, null, 2);
			const citations = Array.isArray(data.citations) ? `\n\n## Citations\n${data.citations.map((c: any, i: number) => `${i + 1}. ${c.title || c.url || "source"}${c.url ? ` — ${c.url}` : ""}`).join("\n")}` : "";
			return { content: [{ type: "text", text: `${answer}${citations}` }], details: data };
		},
	});
}

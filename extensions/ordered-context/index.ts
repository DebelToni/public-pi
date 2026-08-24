import { existsSync, readdirSync, readFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const CONTEXT_DIR = join(getAgentDir(), "CONTEXT");
const MEMORY_NAME = /^\d+-MEMORY\.md$/i;
const MEMORY_LIMIT_BYTES = 8 * 1024;
const MEMORY_TRIM_WARNING_BYTES = MEMORY_LIMIT_BYTES * 1.1;
const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

function resolveToolPath(path: string, cwd: string) {
	const withoutAt = path.startsWith("@") ? path.slice(1) : path;
	const expanded = withoutAt === "~" || withoutAt.startsWith("~/")
		? join(homedir(), withoutAt.slice(2))
		: withoutAt;
	return resolve(cwd, expanded);
}

function isMemoryPath(path: string, cwd: string) {
	const absolutePath = resolveToolPath(path, cwd);
	return dirname(absolutePath) === CONTEXT_DIR && MEMORY_NAME.test(basename(absolutePath));
}

function formatKiB(bytes: number) {
	return `${(bytes / 1024).toFixed(1)} KiB`;
}

async function memorySizeStatus(path: string) {
	const { size } = await stat(path);
	let status = `MEMORY.md: ${formatKiB(size)} / 8 KiB.`;
	if (size <= MEMORY_TRIM_WARNING_BYTES) return status;

	const text = await readFile(path, "utf8");
	const wordCount = text.match(/\S+/gu)?.length ?? 0;
	const averageBytesPerWord = wordCount > 0 ? size / wordCount : 6;
	const wordsToTrim = Math.max(1, Math.ceil((size - MEMORY_LIMIT_BYTES) / averageBytesPerWord));
	return `${status} Trim ~${wordsToTrim} words.`;
}

function stripHtmlComments(markdown: string) {
	let visible = "";
	let cursor = 0;

	while (cursor < markdown.length) {
		const start = markdown.indexOf("<!--", cursor);
		if (start < 0) {
			visible += markdown.slice(cursor);
			break;
		}

		visible += markdown.slice(cursor, start);
		const end = markdown.indexOf("-->", start + 4);
		if (end < 0) break;
		cursor = end + 3;
	}

	return visible;
}

function loadContextFiles() {
	if (!existsSync(CONTEXT_DIR)) return [];
	return readdirSync(CONTEXT_DIR, { withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md"))
		.sort((a, b) => collator.compare(a.name, b.name))
		.map((entry) => {
			const path = join(CONTEXT_DIR, entry.name);
			const content = stripHtmlComments(readFileSync(path, "utf8")).trim();
			return { name: entry.name, path, content };
		});
}

function escapeAttribute(value: string) {
	return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
}

function renderContextBlock() {
	const files = loadContextFiles();
	if (files.length === 0) return "";

	const rendered = files
		.map(
			(file) =>
				`<global_context_file name="${escapeAttribute(file.name)}" path="${escapeAttribute(file.path)}">\n${file.content}\n</global_context_file>`,
		)
		.join("\n\n");

	return `<global_context>\nUser-maintained global context files, presented in numeric filename order. Filename order controls presentation, not authority: MEMORY is derived and yields to USER and instruction files; project AGENTS governs project-specific work. Text explicitly marked as a human drafting note is reference material, not an active instruction.\n\n${rendered}\n</global_context>`;
}

function insertBeforeProjectContext(systemPrompt: string, block: string) {
	const projectMarker = "\n\n<project_context>";
	const projectIndex = systemPrompt.indexOf(projectMarker);
	if (projectIndex >= 0) {
		return `${systemPrompt.slice(0, projectIndex)}\n\n${block}${systemPrompt.slice(projectIndex)}`;
	}

	const cwdMarker = "\nCurrent working directory:";
	const cwdIndex = systemPrompt.lastIndexOf(cwdMarker);
	if (cwdIndex >= 0) {
		return `${systemPrompt.slice(0, cwdIndex)}\n\n${block}${systemPrompt.slice(cwdIndex)}`;
	}

	return `${systemPrompt}\n\n${block}`;
}

export default function orderedContext(pi: ExtensionAPI) {
	pi.on("before_agent_start", async (event) => {
		const block = renderContextBlock();
		if (!block) return;
		return { systemPrompt: insertBeforeProjectContext(event.systemPrompt, block) };
	});

	pi.on("tool_result", (event, ctx) => {
		if (event.toolName !== "edit" || event.isError) return;
		const path = typeof event.input.path === "string" ? event.input.path : undefined;
		if (!path || !isMemoryPath(path, ctx.cwd)) return;

		return memorySizeStatus(resolveToolPath(path, ctx.cwd)).then((status) => ({
			content: [...event.content, { type: "text" as const, text: status }],
		}));
	});

	pi.registerCommand("context-files", {
		description: "Show global CONTEXT Markdown files in injection order",
		handler: async (_args, ctx) => {
			const names = loadContextFiles().map((file) => file.name);
			ctx.ui.notify(names.length > 0 ? names.join(" → ") : `No Markdown files in ${CONTEXT_DIR}`, names.length > 0 ? "info" : "warning");
		},
	});
}

import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, readFile, rename, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

const DEFAULT_ROOT = join(homedir(), "tmp", "pi-context-inspect");
const PREVIEW_STRING_CHARS = 20_000;
const PREVIEW_ARRAY_ITEMS = 80;
const PREVIEW_OBJECT_KEYS = 120;

type CaptureEnvelope = {
	version: 1;
	capturedAt: string;
	sessionId: string;
	sessionFile?: string;
	cwd: string;
	model?: { provider?: string; id?: string; api?: string };
	thinkingLevel?: string;
	systemPrompt?: string;
	contextMessages?: unknown[];
	providerPayload: unknown;
};

type InspectorOptions = {
	root?: string;
};

type MarkdownWriter = {
	write(text: string): Promise<void>;
	close(): Promise<void>;
};

function safeName(value: string) {
	return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "session";
}

function capturePath(root: string, sessionId: string) {
	return join(root, "captures", `${safeName(sessionId)}.json`);
}

async function atomicWrite(path: string, content: string) {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
	await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
	await rename(temporary, path);
}

function createMarkdownWriter(path: string): MarkdownWriter {
	const stream = createWriteStream(path, { encoding: "utf8", mode: 0o600 });
	return {
		async write(text) {
			if (!stream.write(text)) await once(stream, "drain");
		},
		async close() {
			stream.end();
			await once(stream, "finish");
		},
	};
}

function codeFence(text: string, language = "text") {
	const longest = Math.max(0, ...Array.from(text.matchAll(/`+/g), (match) => match[0].length));
	const fence = "`".repeat(Math.max(3, longest + 1));
	return `${fence}${language}\n${text}\n${fence}`;
}

function previewValue(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
	if (typeof value === "string") {
		if (value.length <= PREVIEW_STRING_CHARS) return value;
		return `${value.slice(0, PREVIEW_STRING_CHARS)}\n… [${value.length - PREVIEW_STRING_CHARS} characters omitted from readable preview; exact value remains in the linked JSON/JSONL]`;
	}
	if (value === null || typeof value !== "object") return value;
	if (seen.has(value)) return "[circular reference]";
	if (depth >= 7) return `[${Array.isArray(value) ? "array" : "object"} omitted below depth 7]`;
	seen.add(value);
	if (Array.isArray(value)) {
		const items = value.slice(0, PREVIEW_ARRAY_ITEMS).map((item) => previewValue(item, depth + 1, seen));
		if (value.length > PREVIEW_ARRAY_ITEMS) items.push(`… [${value.length - PREVIEW_ARRAY_ITEMS} items omitted from readable preview]`);
		return items;
	}
	const record = value as Record<string, unknown>;
	const mime = typeof record.mimeType === "string" ? record.mimeType : typeof record.mediaType === "string" ? record.mediaType : undefined;
	const out: Record<string, unknown> = {};
	for (const key of Object.keys(record).slice(0, PREVIEW_OBJECT_KEYS)) {
		const child = record[key];
		if (key === "data" && mime?.startsWith("image/") && typeof child === "string") {
			out[key] = `[base64 image data: ${child.length} characters; exact value remains in linked source]`;
		} else {
			out[key] = previewValue(child, depth + 1, seen);
		}
	}
	const omitted = Object.keys(record).length - PREVIEW_OBJECT_KEYS;
	if (omitted > 0) out["…"] = `[${omitted} keys omitted from readable preview]`;
	return out;
}

function jsonPreview(value: unknown) {
	return codeFence(JSON.stringify(previewValue(value), null, 2), "json");
}

function imageData(content: any): { data: string; mimeType: string } | undefined {
	if (!content || content.type !== "image") return undefined;
	if (typeof content.data === "string" && typeof content.mimeType === "string") {
		return { data: content.data, mimeType: content.mimeType };
	}
	if (content.source?.type === "base64" && typeof content.source.data === "string" && typeof content.source.mediaType === "string") {
		return { data: content.source.data, mimeType: content.source.mediaType };
	}
	return undefined;
}

function extensionForMime(mimeType: string) {
	if (mimeType === "image/jpeg") return "jpg";
	if (mimeType === "image/png") return "png";
	if (mimeType === "image/gif") return "gif";
	if (mimeType === "image/webp") return "webp";
	if (mimeType === "image/bmp") return "bmp";
	return "bin";
}

async function renderContent(
	writer: MarkdownWriter,
	content: unknown,
	assetsDir: string,
	assetPrefix: string,
) {
	if (typeof content === "string") {
		await writer.write(`${codeFence(content)}\n\n`);
		return;
	}
	if (!Array.isArray(content)) {
		await writer.write(`${jsonPreview(content)}\n\n`);
		return;
	}
	for (let index = 0; index < content.length; index++) {
		const part: any = content[index];
		if (part?.type === "text" && typeof part.text === "string") {
			await writer.write(`#### Text\n\n${codeFence(part.text)}\n\n`);
			continue;
		}
		if (part?.type === "thinking" && typeof part.thinking === "string") {
			await writer.write(`#### Thinking trace\n\n${codeFence(part.thinking)}\n\n`);
			continue;
		}
		if (part?.type === "toolCall") {
			await writer.write(`#### Tool call: ${String(part.name ?? "unknown")}\n\n`);
			await writer.write(`${codeFence(JSON.stringify(part.arguments ?? {}, null, 2), "json")}\n\n`);
			continue;
		}
		const image = imageData(part);
		if (image) {
			let decoded: Buffer;
			try {
				decoded = Buffer.from(image.data, "base64");
			} catch {
				await writer.write(`#### Image\n\nInvalid base64 image payload (${image.mimeType}).\n\n`);
				continue;
			}
			const digest = createHash("sha256").update(decoded).digest("hex");
			const fileName = `${safeName(assetPrefix)}-${index}-${digest.slice(0, 12)}.${extensionForMime(image.mimeType)}`;
			const imagePath = join(assetsDir, fileName);
			if (!existsSync(imagePath)) await writeFile(imagePath, decoded, { mode: 0o600 });
			await writer.write(`#### Image\n\n![${fileName}](assets/${fileName})\n\n- MIME: \`${image.mimeType}\`\n- Bytes: ${decoded.length}\n- SHA-256: \`${digest}\`\n\n`);
			continue;
		}
		await writer.write(`#### Content part: ${String(part?.type ?? "unknown")}\n\n${jsonPreview(part)}\n\n`);
	}
}

function messageMetadata(message: any) {
	const keys = [
		"role", "timestamp", "provider", "model", "api", "stopReason", "errorMessage",
		"toolCallId", "toolName", "isError", "usage", "exitCode", "cancelled", "truncated",
		"fullOutputPath", "excludeFromContext", "customType", "display", "tokensBefore", "fromId",
	];
	return Object.fromEntries(keys.filter((key) => message?.[key] !== undefined).map((key) => [key, message[key]]));
}

async function renderMessage(writer: MarkdownWriter, message: any, assetsDir: string, assetPrefix: string) {
	await writer.write(`${jsonPreview(messageMetadata(message))}\n\n`);
	if (message?.role === "bashExecution") {
		await writer.write(`#### Command\n\n${codeFence(String(message.command ?? ""), "bash")}\n\n#### Output\n\n${codeFence(String(message.output ?? ""))}\n\n`);
	} else if (message?.role === "branchSummary" || message?.role === "compactionSummary") {
		await writer.write(`${codeFence(String(message.summary ?? ""))}\n\n`);
	} else {
		await renderContent(writer, message?.content, assetsDir, assetPrefix);
	}
	if (message?.details !== undefined) {
		await writer.write(`#### Non-model tool/message details preview\n\n${jsonPreview(message.details)}\n\n`);
	}
}

function entryTitle(entry: any) {
	if (entry.type === "message") return `${entry.type}/${entry.message?.role ?? "unknown"}`;
	if (entry.type === "custom") return `${entry.type}/${entry.customType ?? "unknown"}`;
	if (entry.type === "custom_message") return `${entry.type}/${entry.customType ?? "unknown"}`;
	return entry.type;
}

function promptAssemblyManifest(ctx: ExtensionCommandContext) {
	const options = ctx.getSystemPromptOptions();
	return {
		cwd: options.cwd,
		customPrompt: options.customPrompt ? "present (content is rendered in Effective system prompt)" : "absent",
		appendSystemPrompt: options.appendSystemPrompt ? "present (content is rendered in Effective system prompt)" : "absent",
		selectedTools: options.selectedTools,
		contextFiles: options.contextFiles?.map((file: any) => ({ path: file.path, scope: file.scope, source: file.source })),
		skills: options.skills?.map((skill: any) => ({ name: skill.name, filePath: skill.filePath, description: skill.description })),
		toolSnippets: Object.keys(options.toolSnippets ?? {}),
		promptGuidelineCount: options.promptGuidelines?.length ?? 0,
	};
}

async function readCapture(root: string, sessionId: string): Promise<CaptureEnvelope | undefined> {
	try {
		const parsed = JSON.parse(await readFile(capturePath(root, sessionId), "utf8")) as CaptureEnvelope;
		if (parsed.version !== 1 || parsed.sessionId !== sessionId) return undefined;
		return parsed;
	} catch {
		return undefined;
	}
}

export async function writeInspection(ctx: ExtensionCommandContext, options: InspectorOptions = {}) {
	const root = options.root ?? DEFAULT_ROOT;
	const sessionId = ctx.sessionManager.getSessionId();
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const outputDir = join(root, `${stamp}-${safeName(sessionId)}`);
	const assetsDir = join(outputDir, "assets");
	const markdownPath = join(outputDir, "context.md");
	await mkdir(assetsDir, { recursive: true, mode: 0o700 });

	const sessionFile = ctx.sessionManager.getSessionFile();
	if (sessionFile) {
		try {
			await symlink(sessionFile, join(outputDir, "session.jsonl"));
		} catch {}
	}

	const capture = await readCapture(root, sessionId);
	if (capture) {
		await writeFile(join(outputDir, "provider-request.json"), JSON.stringify(capture.providerPayload, null, 2), { encoding: "utf8", mode: 0o600 });
	}

	const entries = ctx.sessionManager.getEntries() as any[];
	const activeBranchIds = new Set((ctx.sessionManager.getBranch() as any[]).map((entry) => entry.id));
	const contextEntries = ctx.sessionManager.buildContextEntries() as any[];
	const modelContextIds = new Set(contextEntries.map((entry) => entry.id));
	const effectivePrompt = capture?.systemPrompt ?? ctx.getSystemPrompt();
	const writer = createMarkdownWriter(markdownPath);

	try {
		await writer.write(`# Pi context inspection\n\n`);
		await writer.write(`- Generated: \`${new Date().toISOString()}\`\n- Session: \`${sessionId}\`\n- Session file: \`${sessionFile ?? "ephemeral"}\`\n- Leaf: \`${ctx.sessionManager.getLeafId() ?? "none"}\`\n- Model: \`${ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "none"}\`\n- Thinking level: \`${ctx.thinkingLevel}\`\n\n`);
		await writer.write(`The effective request and readable archive are inspection artifacts. The authoritative session remains Pi JSONL. Image base64 is extracted into \`assets/\`; large non-model extension details are previewed because some entries are tens of megabytes, with exact values retained in \`session.jsonl\`.\n\n`);

		await writer.write(`## Latest model-facing request\n\n`);
		if (capture) {
			await writer.write(`Captured immediately before the provider call at \`${capture.capturedAt}\`. The provider-specific request is preserved exactly in [provider-request.json](./provider-request.json); it includes tool schemas, provider serialization, and every field actually sent except HTTP headers. The response generated from that request is necessarily absent from its own input.\n\n`);
			await writer.write(`- Captured model: \`${capture.model?.provider ?? "unknown"}/${capture.model?.id ?? "unknown"}\`\n- API: \`${capture.model?.api ?? "unknown"}\`\n- Logical context messages: ${capture.contextMessages?.length ?? 0}\n- Provider payload top-level keys: ${capture.providerPayload && typeof capture.providerPayload === "object" && !Array.isArray(capture.providerPayload) ? Object.keys(capture.providerPayload as object).map((key) => `\`${key}\``).join(", ") : "non-object payload"}\n\n`);
		} else {
			await writer.write(`No provider request has been captured since this extension was loaded. The prompt below is Pi's current base prompt and the entries tagged \`model-context\` are Pi's current compaction-aware context. Send one normal prompt to create an exact provider snapshot.\n\n`);
		}

		await writer.write(`### Prompt assembly manifest\n\n${jsonPreview(promptAssemblyManifest(ctx))}\n\n`);
		await writer.write(`### Effective system prompt\n\n${codeFence(effectivePrompt)}\n\n`);
		if (capture) {
			const providerOptions = capture.providerPayload && typeof capture.providerPayload === "object" && !Array.isArray(capture.providerPayload)
				? Object.fromEntries(Object.entries(capture.providerPayload as Record<string, unknown>).filter(([key]) => !["instructions", "system", "systemInstruction", "input", "messages", "contents"].includes(key)))
				: capture.providerPayload;
			await writer.write(`### Provider request options and tool definitions preview\n\n${jsonPreview(providerOptions)}\n\n`);
		}

		await writer.write(`## Complete stored session archive\n\n`);
		await writer.write(`Every persisted entry is listed once in append order. \`active-branch\` means it is on the selected tree path; \`model-context\` means Pi's compaction-aware context builder selected it before final context/provider transformations. Exact provider truth is [provider-request.json](./provider-request.json) when present.\n\n`);
		await writer.write(`### Session header\n\n${jsonPreview(ctx.sessionManager.getHeader())}\n\n`);

		for (let index = 0; index < entries.length; index++) {
			const entry = entries[index];
			const tags = [activeBranchIds.has(entry.id) ? "active-branch" : undefined, modelContextIds.has(entry.id) ? "model-context" : undefined].filter(Boolean);
			await writer.write(`## Entry ${String(index + 1).padStart(4, "0")} · ${entryTitle(entry)} · \`${entry.id}\`${tags.length ? ` · ${tags.map((tag) => `\`${tag}\``).join(" ")}` : ""}\n\n`);
			await writer.write(`- Parent: \`${entry.parentId ?? "root"}\`\n- Timestamp: \`${entry.timestamp}\`\n- JSONL line: ${index + 2}\n\n`);

			if (entry.type === "message") {
				await renderMessage(writer, entry.message, assetsDir, entry.id);
			} else if (entry.type === "custom_message") {
				await writer.write(`- Custom type: \`${entry.customType}\`\n- Display: \`${entry.display}\`\n\n`);
				await renderContent(writer, entry.content, assetsDir, entry.id);
				if (entry.details !== undefined) await writer.write(`#### Non-model details preview\n\n${jsonPreview(entry.details)}\n\n`);
			} else if (entry.type === "compaction" || entry.type === "branch_summary") {
				const metadata = { ...entry };
				delete metadata.summary;
				delete metadata.details;
				await writer.write(`${jsonPreview(metadata)}\n\n#### Summary\n\n${codeFence(entry.summary)}\n\n`);
				if (entry.details !== undefined) await writer.write(`#### Non-model details preview\n\n${jsonPreview(entry.details)}\n\n`);
			} else if (entry.type === "custom") {
				await writer.write(`Custom entries are persisted extension state and are not sent to the model.\n\n- Custom type: \`${entry.customType}\`\n\n${jsonPreview(entry.data)}\n\n`);
			} else {
				const metadata = { ...entry };
				delete metadata.id;
				delete metadata.parentId;
				delete metadata.timestamp;
				await writer.write(`${jsonPreview(metadata)}\n\n`);
			}
		}
	} finally {
		await writer.close();
	}

	return { outputDir, markdownPath, capturePresent: !!capture, entries: entries.length };
}

export function tmuxOpenArgs(markdownPath: string, cwd: string) {
	return ["new-window", "-n", "context-inspect", "-c", cwd, "nvim", "-R", markdownPath];
}

export function createContextInspector(options: InspectorOptions = {}) {
	const root = options.root ?? DEFAULT_ROOT;
	return function contextInspector(pi: ExtensionAPI) {
		let latestSystemPrompt: string | undefined;
		let latestContextMessages: unknown[] | undefined;

		pi.on("before_agent_start", (event) => {
			latestSystemPrompt = event.systemPrompt;
		});
		pi.on("context", (event) => {
			latestContextMessages = event.messages;
		});
		pi.on("before_provider_request", async (event, ctx) => {
			if (ctx.mode !== "tui") return;
			const envelope: CaptureEnvelope = {
				version: 1,
				capturedAt: new Date().toISOString(),
				sessionId: ctx.sessionManager.getSessionId(),
				sessionFile: ctx.sessionManager.getSessionFile(),
				cwd: ctx.cwd,
				model: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id, api: ctx.model.api } : undefined,
				thinkingLevel: ctx.thinkingLevel,
				systemPrompt: latestSystemPrompt ?? ctx.getSystemPrompt(),
				contextMessages: latestContextMessages,
				providerPayload: event.payload,
			};
			await atomicWrite(capturePath(root, envelope.sessionId), JSON.stringify(envelope));
		});

		pi.registerCommand("context-inspect", {
			description: "Open a searchable Markdown inspection of the exact model request and full Pi session",
			handler: async (_args, ctx) => {
				await ctx.waitForIdle();
				const result = await writeInspection(ctx, { root });
				if (ctx.mode === "tui" && process.env.TMUX) {
					const opened = await pi.exec("tmux", tmuxOpenArgs(result.markdownPath, ctx.cwd), { timeout: 5000 });
					if (opened.code === 0) {
						ctx.ui.notify(`Context inspection opened: ${result.markdownPath}`, result.capturePresent ? "info" : "warning");
						return;
					}
					ctx.ui.notify(`Context inspection written but tmux failed: ${opened.stderr || opened.stdout}`, "error");
					return;
				}
				ctx.ui.notify(`Context inspection written: ${result.markdownPath}`, result.capturePresent ? "info" : "warning");
			},
		});
	};
}

export default createContextInspector();

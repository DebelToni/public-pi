import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, extname, isAbsolute, join, resolve, sep } from "node:path";

const CONFIG_PATH = join(getAgentDir(), "openai-plus.json");
const SERVICE_TIER = "priority";
const IMAGE_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses";
const DEFAULT_IMAGE_MODEL = "gpt-5.5";
const DEFAULT_TIMEOUT_MS = 180_000;

type Config = {
	fast?: boolean;
	image?: {
		enabled?: boolean;
		defaultModel?: string;
		defaultSave?: "none" | "project" | "global" | "custom";
		outputFormat?: "png" | "jpeg" | "webp";
		timeoutMs?: number;
	};
};

type ImageParams = {
	prompt: string;
	action?: "auto" | "generate" | "edit";
	images?: string[];
	provider?: string;
	model?: string;
	outputFormat?: "png" | "jpeg" | "webp";
	save?: "none" | "project" | "global" | "custom";
	saveDir?: string;
};

type ImageResult = {
	id: string;
	status: string;
	prompt: string;
	revisedPrompt?: string;
	data: string;
	mimeType: string;
	savedPath?: string;
	provider: string;
	model: string;
	action: string;
	outputFormat: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function defaultConfig(): Required<Config> & { image: Required<NonNullable<Config["image"]>> } {
	return {
		fast: false,
		image: {
			enabled: true,
			defaultModel: DEFAULT_IMAGE_MODEL,
			defaultSave: "project",
			outputFormat: "png",
			timeoutMs: DEFAULT_TIMEOUT_MS,
		},
	};
}

function readConfig(): ReturnType<typeof defaultConfig> {
	const base = defaultConfig();
	try {
		if (!existsSync(CONFIG_PATH)) return base;
		const parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
		if (!isRecord(parsed)) return base;
		if (typeof parsed.fast === "boolean") base.fast = parsed.fast;
		if (isRecord(parsed.image)) {
			if (typeof parsed.image.enabled === "boolean") base.image.enabled = parsed.image.enabled;
			if (typeof parsed.image.defaultModel === "string" && parsed.image.defaultModel.trim()) base.image.defaultModel = parsed.image.defaultModel.trim();
			if (["none", "project", "global", "custom"].includes(String(parsed.image.defaultSave))) base.image.defaultSave = parsed.image.defaultSave as any;
			if (["png", "jpeg", "webp"].includes(String(parsed.image.outputFormat))) base.image.outputFormat = parsed.image.outputFormat as any;
			if (typeof parsed.image.timeoutMs === "number" && parsed.image.timeoutMs > 0) base.image.timeoutMs = parsed.image.timeoutMs;
		}
	} catch {}
	return base;
}

function writeConfig(config: Config) {
	mkdirSync(dirname(CONFIG_PATH), { recursive: true });
	writeFileSync(CONFIG_PATH, `${JSON.stringify({ ...readConfig(), ...config, image: { ...readConfig().image, ...(config.image ?? {}) } }, null, 2)}\n`, "utf8");
}

function codexLikeProvider(provider?: string) {
	return provider === "openai-codex" || !!provider?.startsWith("codex-");
}

function fastEligible(ctx: ExtensionContext) {
	const provider = ctx.model?.provider;
	return provider === "openai" || provider === "openai-responses" || codexLikeProvider(provider);
}

function decodeBase64Url(value: string) {
	const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
	const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
	return Buffer.from(padded, "base64").toString("utf8");
}

function accountIdFromJwt(token: string): string | undefined {
	try {
		const [, payload] = token.split(".");
		if (!payload) return undefined;
		const parsed = JSON.parse(decodeBase64Url(payload));
		const auth = parsed?.["https://api.openai.com/auth"];
		return typeof auth?.chatgpt_account_id === "string" ? auth.chatgpt_account_id : undefined;
	} catch {
		return undefined;
	}
}

async function getCodexCredentials(ctx: ExtensionContext, provider: string) {
	const token = await ctx.modelRegistry.getApiKeyForProvider(provider).catch(() => undefined);
	if (!token) throw new Error(`Missing OAuth token for ${provider}. Run /login and select that Codex account.`);
	const accountId = accountIdFromJwt(token);
	if (!accountId) throw new Error(`Could not read ChatGPT account id from ${provider} token.`);
	return { token, accountId };
}

function parseProviderAndModel(params: Pick<ImageParams, "provider" | "model">, ctx: ExtensionContext, cfg = readConfig()) {
	let provider = params.provider?.trim();
	let model = params.model?.trim();
	if (model?.includes("/")) {
		const [p, ...rest] = model.split("/");
		provider = provider || p;
		model = rest.join("/");
	}
	provider = provider || (codexLikeProvider(ctx.model?.provider) ? ctx.model!.provider : "openai-codex");
	model = model || (codexLikeProvider(ctx.model?.provider) ? ctx.model!.id : cfg.image.defaultModel);
	if (!codexLikeProvider(provider)) throw new Error(`Image generation requires openai-codex or codex-* provider, got ${provider}.`);
	return { provider, model };
}

function mimeTypeForPath(path: string, outputFormat?: string) {
	const ext = extname(path).toLowerCase();
	if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
	if (ext === ".webp") return "image/webp";
	if (ext === ".gif") return "image/gif";
	if (outputFormat === "jpeg") return "image/jpeg";
	if (outputFormat === "webp") return "image/webp";
	return "image/png";
}

async function readImageInputs(paths: string[] | undefined, cwd: string) {
	const out: Array<{ path: string; data: string; mimeType: string }> = [];
	for (const raw of paths ?? []) {
		const trimmed = raw.trim();
		if (!trimmed) continue;
		const path = isAbsolute(trimmed) ? trimmed : resolve(cwd, trimmed);
		out.push({ path, data: (await readFile(path)).toString("base64"), mimeType: mimeTypeForPath(path) });
	}
	return out;
}

function buildImageRequest(params: ImageParams, model: string, outputFormat: "png" | "jpeg" | "webp", images: Array<{ data: string; mimeType: string }>) {
	const content: Array<Record<string, unknown>> = [{ type: "input_text", text: params.prompt }];
	for (const image of images) content.push({ type: "input_image", detail: "auto", image_url: `data:${image.mimeType};base64,${image.data}` });
	const tool: Record<string, unknown> = { type: "image_generation", output_format: outputFormat };
	if (params.action && params.action !== "auto") tool.action = params.action;
	return {
		model,
		instructions: "",
		input: [{ role: "user", content }],
		tools: [tool],
		tool_choice: { type: "image_generation" },
		parallel_tool_calls: false,
		store: false,
		stream: true,
		include: [],
		client_metadata: { "x-codex-installation-id": "pi-openai-plus" },
	};
}

function dataUrlParts(value: string, fallbackMimeType: string) {
	const match = value.match(/^data:([^;,]+);base64,(.*)$/s);
	return match ? { mimeType: match[1] || fallbackMimeType, data: match[2].trim() } : { mimeType: fallbackMimeType, data: value.trim() };
}

function extractImageFromEvent(event: unknown, fallbackMimeType: string): { id: string; status: string; data: string; mimeType: string; revisedPrompt?: string } | undefined {
	if (!isRecord(event)) return undefined;
	const item = isRecord(event.item) ? event.item : event;
	if (item.type === "image_generation_call") {
		const raw = typeof item.result === "string" && item.result.trim() ? item.result : typeof item.b64_json === "string" ? item.b64_json : undefined;
		if (!raw) return undefined;
		const { data, mimeType } = dataUrlParts(raw, fallbackMimeType);
		return {
			id: typeof item.id === "string" ? item.id : `ig_${randomUUID().slice(0, 8)}`,
			status: typeof item.status === "string" ? item.status : "completed",
			data,
			mimeType,
			revisedPrompt: typeof item.revised_prompt === "string" ? item.revised_prompt : undefined,
		};
	}
	const partial = event.partial_image_b64 ?? event.b64_json;
	if (typeof partial === "string" && partial.trim()) {
		const { data, mimeType } = dataUrlParts(partial, fallbackMimeType);
		return { id: `ig_${randomUUID().slice(0, 8)}`, status: "completed", data, mimeType };
	}
	return undefined;
}

async function parseSseForImage(response: Response, fallbackMimeType: string, signal?: AbortSignal) {
	if (!response.body) throw new Error("No response body from image request.");
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let lastImage: ReturnType<typeof extractImageFromEvent>;
	try {
		while (true) {
			if (signal?.aborted) throw new Error("Image request aborted.");
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			let idx = buffer.indexOf("\n\n");
			while (idx !== -1) {
				const chunk = buffer.slice(0, idx);
				buffer = buffer.slice(idx + 2);
				const data = chunk.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n").trim();
				if (data && data !== "[DONE]") {
					let event: unknown;
					try { event = JSON.parse(data); } catch {}
					const image = extractImageFromEvent(event, fallbackMimeType);
					if (image?.data) {
						lastImage = image;
						if (image.status === "completed") {
							await reader.cancel().catch(() => undefined);
							return image;
						}
					}
					if (isRecord(event) && event.type === "response.failed") {
						const error = isRecord(event.response) && isRecord(event.response.error) ? event.response.error : undefined;
						throw new Error(typeof error?.message === "string" ? error.message : "Image request failed.");
					}
					if (isRecord(event) && event.type === "error") throw new Error(typeof event.message === "string" ? event.message : JSON.stringify(event));
				}
				idx = buffer.indexOf("\n\n");
			}
		}
	} finally {
		reader.releaseLock();
	}
	if (lastImage) return lastImage;
	throw new Error("No image_generation result returned.");
}

function extensionForFormat(format: "png" | "jpeg" | "webp") {
	return format === "jpeg" ? "jpg" : format;
}

function resolveSaveDir(save: string, saveDir: string | undefined, cwd: string) {
	if (save === "none") return undefined;
	if (save === "project") return join(cwd, ".pi", "generated-images");
	if (save === "global") return join(getAgentDir(), "generated-images");
	const dir = saveDir?.trim() || process.env.PI_IMAGE_SAVE_DIR?.trim();
	if (!dir) throw new Error("save=custom requires saveDir or PI_IMAGE_SAVE_DIR.");
	return dir;
}

async function saveImage(data: string, format: "png" | "jpeg" | "webp", outputDir: string, id: string) {
	const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
	const safeId = id.replace(/[^a-zA-Z0-9_-]/g, "_") || randomUUID().slice(0, 8);
	const path = join(outputDir, `openai-image-${timestamp}-${safeId}.${extensionForFormat(format)}`);
	await mkdir(outputDir, { recursive: true });
	await writeFile(path, Buffer.from(data, "base64"));
	return path;
}

function displayPath(path: string) {
	const home = homedir();
	if (path === home) return "~";
	const prefix = home.endsWith(sep) ? home : `${home}${sep}`;
	return path.startsWith(prefix) ? `~/${path.slice(prefix.length)}` : path;
}

function resultText(result: ImageResult) {
	const parts = [
		`Generated image via ${result.provider}/${result.model}.`,
		`Action: ${result.action}.`,
		`Prompt: ${result.prompt}`,
	];
	if (result.revisedPrompt) parts.push(`Revised prompt: ${result.revisedPrompt}`);
	if (result.savedPath) parts.push(`Saved: ${displayPath(result.savedPath)}`);
	return parts.join("\n");
}

async function generateImage(params: ImageParams, ctx: ExtensionContext, requestSignal?: AbortSignal): Promise<ImageResult> {
	const cfg = readConfig();
	if (!cfg.image.enabled) throw new Error("OpenAI image generation is disabled in openai-plus config.");
	const { provider, model } = parseProviderAndModel(params, ctx, cfg);
	const { token, accountId } = await getCodexCredentials(ctx, provider);
	const outputFormat = params.outputFormat ?? cfg.image.outputFormat;
	const action = params.action ?? "auto";
	const images = await readImageInputs(params.images, ctx.cwd || process.cwd());
	const body = buildImageRequest(params, model, outputFormat, images);
	const timeoutSignal = AbortSignal.timeout(params.save === undefined ? cfg.image.timeoutMs : cfg.image.timeoutMs);
	const baseSignal = requestSignal ?? ctx.signal;
	const signal = baseSignal ? AbortSignal.any([baseSignal, timeoutSignal]) : timeoutSignal;
	const response = await fetch(IMAGE_ENDPOINT, {
		method: "POST",
		headers: {
			authorization: `Bearer ${token}`,
			"chatgpt-account-id": accountId,
			"OpenAI-Beta": "responses=experimental",
			accept: "text/event-stream",
			"content-type": "application/json",
			originator: "codex_cli_rs",
			"User-Agent": "codex_cli_rs/0.0.0 (pi-openai-plus)",
		},
		body: JSON.stringify(body),
		signal,
	});
	if (!response.ok) {
		const text = await response.text().catch(() => "");
		throw new Error(`Image request failed (${response.status}): ${text || response.statusText}`);
	}
	const parsed = await parseSseForImage(response, mimeTypeForPath(`image.${outputFormat}`, outputFormat), signal);
	const save = params.save ?? cfg.image.defaultSave;
	const saveDir = resolveSaveDir(save, params.saveDir, ctx.cwd || process.cwd());
	const savedPath = saveDir ? await saveImage(parsed.data, outputFormat, saveDir, parsed.id) : undefined;
	return { ...parsed, prompt: params.prompt, savedPath, provider, model, action, outputFormat };
}

export default function openaiPlus(pi: ExtensionAPI) {
	pi.registerCommand("fast", {
		description: "Toggle OpenAI service_tier=priority fast mode",
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();
			const cfg = readConfig();
			let next: boolean;
			if (!arg) next = !cfg.fast;
			else if (["on", "yes", "true", "1"].includes(arg)) next = true;
			else if (["off", "no", "false", "0"].includes(arg)) next = false;
			else if (arg === "status") {
				ctx.ui.notify(`Fast mode: ${cfg.fast ? "on" : "off"}. Current model eligible: ${fastEligible(ctx) ? "yes" : "no"}.`, "info");
				return;
			} else {
				ctx.ui.notify("Usage: /fast [on|off|status]", "error");
				return;
			}
			writeConfig({ fast: next });
			ctx.ui.notify(`Fast mode ${next ? "on" : "off"}${next && !fastEligible(ctx) ? " (will apply when current model is OpenAI/Codex)" : ""}.`, "info");
		},
	});

	pi.registerCommand("openai-image", {
		description: "Generate an image with OpenAI Codex image_generation",
		handler: async (args, ctx) => {
			const prompt = args.trim();
			if (!prompt) {
				ctx.ui.notify("Usage: /openai-image <prompt>", "error");
				return;
			}
			ctx.ui.notify("Requesting OpenAI image...", "info");
			const result = await generateImage({ prompt }, ctx);
			pi.sendMessage({
				customType: "openai-image",
				content: [
					{ type: "text", text: resultText(result) },
					{ type: "image", data: result.data, mimeType: result.mimeType },
				],
				details: result,
				display: true,
			});
		},
	});

	pi.registerTool({
		name: "openai_image",
		label: "OpenAI image",
		description: "Generate or edit images through ChatGPT/Codex subscription auth. Uses the current codex-* account when selected and saves to .pi/generated-images by default.",
		parameters: Type.Object({
			prompt: Type.String({ description: "Image generation/editing prompt. Pass the user's wording verbatim unless asked to refine." }),
			action: Type.Optional(Type.Union([Type.Literal("auto"), Type.Literal("generate"), Type.Literal("edit")], { description: "Generate, edit/reference images, or auto." })),
			images: Type.Optional(Type.Array(Type.String(), { description: "Local image paths for edit/reference." })),
			provider: Type.Optional(Type.String({ description: "Optional provider, e.g. openai-codex or codex-work." })),
			model: Type.Optional(Type.String({ description: "Optional model or provider/model, defaults to current codex model." })),
			outputFormat: Type.Optional(Type.Union([Type.Literal("png"), Type.Literal("jpeg"), Type.Literal("webp")])),
			save: Type.Optional(Type.Union([Type.Literal("none"), Type.Literal("project"), Type.Literal("global"), Type.Literal("custom")])),
			saveDir: Type.Optional(Type.String({ description: "Directory when save=custom." })),
		}),
		async execute(_id, params: ImageParams, signal, onUpdate, ctx) {
			onUpdate?.({ content: [{ type: "text", text: "Requesting OpenAI image..." }], details: undefined });
			const result = await generateImage(params, ctx, signal);
			return {
				content: [
					{ type: "text", text: resultText(result) },
					{ type: "image", data: result.data, mimeType: result.mimeType },
				],
				details: result,
			};
		},
	});

	pi.on("before_provider_request", (event, ctx) => {
		if (!readConfig().fast || !fastEligible(ctx) || !isRecord(event.payload)) return;
		return { ...event.payload, service_tier: SERVICE_TIER };
	});
}

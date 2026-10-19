import { InteractiveMode, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Markdown } from "@earendil-works/pi-tui";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { installUserAttachmentRendering, restoreUserAttachmentRendering } from "./attachments.ts";
import { resolveLocalImagePath, transformImageInput, type ImageSource } from "./input.ts";
import { ImageProvenance, PROVENANCE_TYPE } from "./provenance.ts";
export { resolveLocalImagePath } from "./input.ts";

const PATCH_KEY = "__piImageLabelsV2";
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".heic", ".heif", ".gif", ".webp", ".avif", ".bmp", ".tif", ".tiff", ".svg", ".ico"]);
const VIEWER_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "viewer.py");
const MAX_IMAGES = 36 * 36;

let sessionCwd = process.cwd();

export function imageIdAt(index: number) {
	return Number.isInteger(index) && index >= 0 && index < MAX_IMAGES
		? index.toString(36).padStart(2, "0")
		: undefined;
}

export class ImageRegistry {
	private byPath = new Map<string, string>();
	private byId = new Map<string, string>();
	private descriptions = new Map<string, string>();
	private sessionId?: string;

	static upgrade(old: unknown) {
		if (old instanceof ImageRegistry) return old;
		const previous = old as {
			byPath?: Map<string, string>;
			byId?: Map<string, string>;
			descriptions?: Map<string, string>;
			sessionId?: string;
		};
		const registry = new ImageRegistry();
		registry.byPath = new Map(previous.byPath);
		registry.byId = new Map(previous.byId);
		registry.descriptions = new Map(previous.descriptions ?? []);
		registry.sessionId = previous.sessionId;
		return registry;
	}

	setSession(sessionId: string) {
		if (this.sessionId === sessionId) return;
		this.sessionId = sessionId;
		this.byPath.clear();
		this.byId.clear();
		this.descriptions.clear();
	}

	register(href: string, cwd: string, description = "") {
		const path = resolveLocalImagePath(href, cwd);
		if (!path || !IMAGE_EXTENSIONS.has(extname(path).toLowerCase())) return undefined;
		const existing = this.byPath.get(path);
		if (existing) return existing;
		try {
			if (!statSync(path).isFile()) return undefined;
		} catch {
			return undefined;
		}
		const id = imageIdAt(this.byId.size);
		if (!id) return undefined;
		this.byPath.set(path, id);
		this.byId.set(id, path);
		this.descriptions.set(id, cleanDescription(description, path));
		return id;
	}

	get(id: string) {
		return this.byId.get(id.toLowerCase());
	}

	list() {
		return Array.from(this.byId, ([id, path]) => ({ id, path, description: this.descriptions.get(id) ?? basename(path) }));
	}
}

function cleanDescription(alt: string, path: string) {
	return (alt || basename(path)).replace(/[\x00-\x1f\x7f\[\]]/g, " ").replace(/\s+/g, " ").trim().slice(0, 72);
}

export function formatImageLabel(id: string, alt: string, path: string) {
	return `[IMAGE ${id} - ${cleanDescription(alt, path)}]`;
}

export function findViewingClient(output: string, pane: string) {
	return output.split("\n").map((line) => line.split("\t")).find(([, activePane]) => activePane === pane)?.[0];
}

export function popupArguments(manifest: string, pane: string, client: string) {
	return ["display-popup", "-E", "-B", "-c", client, "-t", pane,
		"-w", "100%", "-h", "100%", "-x", "0", "-y", "0", "--",
		process.env.PI_IMAGE_VIEWER_PYTHON ?? "python3", VIEWER_SCRIPT, manifest];
}

async function openViewer(id: string | undefined, registry: ImageRegistry, pi: ExtensionAPI, ctx: ExtensionContext) {
	if (id && !registry.get(id)) {
		ctx.ui.notify(`Unknown image ID: ${id}`, "warning");
		return;
	}
	const images = registry.list().filter((image) => existsSync(image.path));
	if (images.length === 0) {
		ctx.ui.notify("No local images in this conversation", "info");
		return;
	}
	if (ctx.mode !== "tui" || !process.env.TMUX_PANE) {
		ctx.ui.notify("Image viewer requires Pi inside tmux", "error");
		return;
	}
	const pane = process.env.TMUX_PANE;
	const clients = await pi.exec("tmux", ["list-clients", "-F", "#{client_name}\t#{pane_id}"]);
	const client = clients.code === 0 ? findViewingClient(clients.stdout, pane) : undefined;
	if (!client) {
		ctx.ui.notify(`No tmux client is viewing Pi pane ${pane}; switch to that pane and retry`, "error");
		return;
	}
	const tempRoot = process.platform === "darwin" ? join(homedir(), "tmp") : tmpdir();
	const tempDir = mkdtempSync(join(tempRoot, "pi-image-viewer-"));
	const manifest = join(tempDir, "images.json");
	writeFileSync(manifest, JSON.stringify({ images, selected: id ?? images.at(-1)!.id }), { mode: 0o600 });
	try {
		const result = await pi.exec("tmux", popupArguments(manifest, pane, client));
		if (result.code !== 0) {
			const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`;
			ctx.ui.notify(`Image viewer failed: ${detail}`, "error");
		}
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
}

function installMarkdownPatch() {
	const prototype = Markdown.prototype as any;
	let state = prototype[PATCH_KEY] as { registry: ImageRegistry; label: (token: any) => string | undefined } | undefined;
	if (state) {
		state.registry = ImageRegistry.upgrade(state.registry);
		state.label = (token) => {
			const id = state!.registry.register(token.href, sessionCwd, token.text || "");
			return id ? formatImageLabel(id, token.text || "", resolveLocalImagePath(token.href, sessionCwd)!) : undefined;
		};
		return state.registry;
	}

	const registry = new ImageRegistry();
	state = {
		registry,
		label: (token) => {
			const id = registry.register(token.href, sessionCwd, token.text || "");
			return id ? formatImageLabel(id, token.text || "", resolveLocalImagePath(token.href, sessionCwd)!) : undefined;
		},
	};
	const original = prototype.renderInlineTokens;
	prototype.renderInlineTokens = function (tokens: any[], styleContext?: any) {
		let result = "";
		for (const token of tokens) {
			if (token?.type === "image" && token.href) {
				const label = state!.label(token);
				// Clear href so the previous experimental renderer cannot draw anything.
				result += original.call(this, [{ ...token, href: "", text: label ?? token.text }], styleContext);
			} else {
				result += original.call(this, [token], styleContext);
			}
		}
		return result;
	};
	prototype[PATCH_KEY] = state;
	return registry;
}

export default function (pi: ExtensionAPI) {
	const registry = installMarkdownPatch();
	const provenance = new ImageProvenance();
	const prepared = new WeakMap<object, { text: string; cwd: string; sessionId: string; images: any[]; sources: ImageSource[] }>();
	const unsubscribePrepare = pi.events?.on?.("inline-images:prepare-input", (value) => {
		const request = value as any;
		request.prepare = async () => {
			let sources: ImageSource[] = [];
			const result = await transformImageInput(request.event, request.cwd, found => { sources = found; });
			const images = result.action === "transform" ? result.images ?? [] : request.event.images ?? [];
			if (images.length) prepared.set(images[0], { text: request.event.text, cwd: request.cwd, sessionId: request.sessionId, images, sources });
			return result;
		};
	});
	const attachmentsSupported = installUserAttachmentRendering(InteractiveMode.prototype,
		join(homedir(), ".local/state/pi-inline-images/attachments"), () => sessionCwd, (message, manager) => {
			if (manager) { sessionCwd = manager.getCwd(); registry.setSession(manager.getSessionId()); }
			return provenance.forMessage(message, manager && (() => manager.getBranch()));
		});
	pi.on("input", async (event, ctx) => {
		try {
			let sources: ImageSource[] = [];
			const snapshot = event.images?.[0] && prepared.get(event.images[0]);
			let result;
			if (snapshot && snapshot.text === event.text && snapshot.cwd === ctx.cwd && snapshot.sessionId === ctx.sessionManager.getSessionId()
				&& event.images?.length === snapshot.images.length && snapshot.images.every((image, index) => event.images![index] === image)) {
				prepared.delete(event.images![0]); sources = snapshot.sources;
				result = { action: "transform" as const, text: event.text, images: event.images };
			} else result = await transformImageInput(event, ctx.cwd, found => { sources = found; });
			const images = result.action === "transform" ? result.images ?? [] : event.images ?? [];
			await provenance.prepare(event.text, images, sources, ctx.model);
			return result;
		}
		catch (error) {
			// Input exceptions are fail-open in Pi. Explicitly consume invalid submissions.
			const message = `Image submission rejected: ${(error as Error).message}`;
			ctx.ui.notify(message, "error");
			if (ctx.hasUI === false) console.error(message);
			return { action: "handled" };
		}
	});
	pi.on("session_start", (_event, ctx) => {
		if (!attachmentsSupported && ctx.mode === "tui") ctx.ui.notify("Uploaded-image references are unavailable in this Pi version.", "warning");
		sessionCwd = ctx.cwd;
		registry.setSession(ctx.sessionManager.getSessionId());
		provenance.load(ctx.sessionManager.getBranch?.() ?? []);
	});
	pi.on("session_tree", (_event, ctx) => provenance.load(ctx.sessionManager.getBranch()));
	pi.on("message_start", (event) => {
		const record = provenance.capture(event.message);
		if (record) pi.appendEntry(PROVENANCE_TYPE, record);
	});
	pi.on("session_shutdown", () => { unsubscribePrepare?.(); restoreUserAttachmentRendering(InteractiveMode.prototype); });
	pi.registerShortcut("alt+i", {
		description: "Open fullscreen image viewer (Up older, Down newer, type an ID)",
		handler: async (ctx) => openViewer(undefined, registry, pi, ctx),
	});
	pi.registerCommand("image", {
		description: "Open fullscreen image viewer, optionally at an ID (/image 0a)",
		handler: async (args, ctx) => openViewer(args.trim().toLowerCase() || undefined, registry, pi, ctx),
	});
}

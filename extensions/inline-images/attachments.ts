import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, mkdirSync, openSync, readSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { Markdown, Spacer } from "@earendil-works/pi-tui";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { findImageReferences } from "./image-paths.mjs";
import type { RenderSource } from "./provenance.ts";
import { IMAGE_LIMITS, imageBytes, imageHash, resolveLocalImagePath } from "./input.ts";

const EXTENSIONS: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };
const PATCH_KEY = Symbol.for("pi-inline-images.user-attachments-v1");

function pathHash(path: string) {
	const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
	try {
		const stat = fstatSync(fd);
		if (!stat.isFile() || !stat.size || stat.size > IMAGE_LIMITS.fileBytes) return;
		const bytes = Buffer.alloc(stat.size + 1);
		let length = 0;
		while (length < bytes.length) {
			const read = readSync(fd, bytes, length, bytes.length - length, length);
			if (!read) break;
			length += read;
		}
		return length === stat.size ? imageHash(bytes.subarray(0, length)) : undefined;
	} finally { closeSync(fd); }
}

const plain = (text: string) => text;
const scanTheme = {
	heading: plain, link: plain, linkUrl: plain, code: plain, codeBlock: plain, codeBlockBorder: plain,
	quote: plain, quoteBorder: plain, hr: plain, listBullet: plain, bold: plain, italic: plain, strikethrough: plain, underline: plain,
};

function visibleLegacyPaths(text: string, cwd: string) {
	const visible = new Set<string>();
	if (!text.includes("![")) return visible;
	try {
		// Reuse the existing inline-token seam with Pi's actual Markdown grammar,
		// including container fences and math. This isolated scan emits no image
		// labels, terminal images or LaTeX and never touches the registry.
		const scan: any = new Markdown(text, 0, 0, scanTheme, undefined, { renderLatex: false });
		const original = scan.renderInlineTokens;
		scan.renderInlineTokens = function (tokens: any[], styleContext: any) {
			return tokens.map(token => {
				if (token.type !== "image") return original.call(this, [token], styleContext);
				const path = resolveLocalImagePath(token.href, cwd);
				if (path) visible.add(path);
				return "";
			}).join("");
		};
		scan.render(80);
	} catch { visible.clear(); } // Uncertain visibility retains the separate label.
	return visible;
}

export function attachmentReferences(message: any, directory: string, cwd = process.cwd(), sources: RenderSource[] = []): string {
	if (message.role !== "user") return "";
	const content = Array.isArray(message.content) ? message.content : [{ type: "text", text: message.content }];
	const text = content.filter((part: any) => part.type === "text").map((part: any) => part.text).join("");
	const references: string[] = [], seen = new Set<string>(), derived = new Map<number, string>();
	const visible = visibleLegacyPaths(text, cwd);
	for (const reference of findImageReferences(text)) {
		const path = resolveLocalImagePath(reference.path, cwd)!;
		try {
			const hash = pathHash(path);
			if (!hash || seen.has(hash)) continue;
			seen.add(hash);
			for (const source of sources) if (source.path === path && source.rawHash === hash) derived.set(source.imageIndex, source.imageHash);
			// Legacy Markdown already receives a label in the ordinary user renderer.
			// Plain references get a separate label even inside an unclosed code fence.
			if (!visible.has(path)) references.push(`![${basename(path).replace(/[\[\]\r\n]/g, " ")}](<${path}>)`);
		} catch { /* Missing historical paths must not break resumed rendering. */ }
	}
	content.filter((part: any) => part.type === "image").forEach((image: any, index: number) => {
		const description = `Uploaded image ${index + 1}`;
		try {
			const extension = EXTENSIONS[image.mimeType], bytes = imageBytes(image);
			const identity = imageHash(bytes);
			if (derived.get(index) === identity || seen.has(identity)) return;
			seen.add(identity);
			const hash = createHash("sha256").update(image.mimeType).update("\0").update(bytes).digest("hex");
			const path = join(directory, `${hash}.${extension}`);
			if (!existsSync(path)) {
				mkdirSync(directory, { recursive: true, mode: 0o700 });
				const temporary = `${path}.${randomUUID()}.tmp`;
				try {
					writeFileSync(temporary, bytes, { mode: 0o600, flag: "wx" });
					renameSync(temporary, path);
				} finally {
					try { unlinkSync(temporary); } catch {}
				}
			}
			references.push(`![${description}](<${path}>)`);
		} catch {
			// An unavailable derived cache must not break the conversation renderer.
			references.push(`[${description} unavailable]`);
		}
	});
	return references.join("\n\n");
}

export function installUserAttachmentRendering(prototype: any, directory: string, getCwd = () => process.cwd(), getSources: (message: any, manager?: ExtensionContext["sessionManager"]) => RenderSource[] = () => []) {
	if (["addMessageToChat", "getUserMessageText", "getMarkdownThemeWithSettings"].some(name => typeof prototype[name] !== "function")) return false;
	const references = (message: any, manager?: ExtensionContext["sessionManager"]) => {
		// Hydrate from the actual host before resolving paths or constructing chat.
		const sources = getSources(message, manager);
		return attachmentReferences(message, directory, getCwd(), sources);
	};
	const previous = prototype[PATCH_KEY];
	if (previous) { previous.references = references; return true; }
	const original = prototype.addMessageToChat;
	const state = { references, original, wrapped: undefined as any };
	prototype.addMessageToChat = state.wrapped = function (this: any, message: any, options: any) {
		const references = state.references(message, this.runtimeHost?.session ? this.sessionManager : undefined);
		const result = original.call(this, message, options);
		if (references) {
			if (!this.getUserMessageText(message) && this.chatContainer.children.length) this.chatContainer.addChild(new Spacer(1));
			// Separate display Markdown leaves model content and editor history intact,
			// and cannot be swallowed by an unclosed fence in the user's own text.
			this.chatContainer.addChild(new Markdown(references, this.outputPad, 0, this.getMarkdownThemeWithSettings()));
		}
		return result;
	};
	prototype[PATCH_KEY] = state;
	return true;
}

export function restoreUserAttachmentRendering(prototype: any) {
	const state = prototype[PATCH_KEY];
	if (!state) return;
	state.references = () => "";
	if (prototype.addMessageToChat === state.wrapped) prototype.addMessageToChat = state.original;
	delete prototype[PATCH_KEY];
}

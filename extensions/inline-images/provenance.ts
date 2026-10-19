import { formatDimensionNote, resizeImage, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { imageBytes, imageHash, type ImageSource } from "./input.ts";

export const PROVENANCE_TYPE = "inline-images-source-v1";
export interface RenderSource extends ImageSource { imageHash: string }
const textOf = (message: any) => typeof message.content === "string" ? message.content : (message.content ?? []).filter((part: any) => part.type === "text").map((part: any) => part.text).join("");
const imagesOf = (message: any) => Array.isArray(message.content) ? (message.content ?? []).filter((part: any) => part.type === "image") : [];
const hashesOf = (images: any[]) => images.map(image => `${image.mimeType}:${imageHash(Buffer.from(image.data, "base64"))}`);
export const messageKey = (message: any) => imageHash(Buffer.from(JSON.stringify([message.timestamp, textOf(message), hashesOf(imagesOf(message))])));

// Predict with the public SDK, then prove against the actual message. Never
// replace payloads/hints or infer correspondence from dimensions or positions alone.
export class ImageProvenance {
	private pending: Array<{ text: string; hintedText: string; raw: string[]; resized: string[]; sources: ImageSource[] }> = [];
	private rendered = new Map<string, RenderSource[]>();

	load(branch: readonly any[]) {
		this.pending = []; this.rendered.clear();
		this.hydrate(branch);
	}

	private hydrate(branch: readonly any[]) {
		for (const entry of branch) {
			if (entry.type === "custom" && entry.customType === PROVENANCE_TYPE && typeof entry.data?.key === "string" && Array.isArray(entry.data.sources)) {
				this.rendered.set(entry.data.key, entry.data.sources);
			}
		}
	}

	async prepare(text: string, images: any[], sources: ImageSource[], model: ExtensionContext["model"]) {
		if (!sources.length) return;
		const resized: string[] = [], hints: string[] = [];
		for (const image of images) {
			const result = await resizeImage(imageBytes(image), image.mimeType, model?.inputLimits?.images?.resize);
			if (!result) return; // SDK normalization can fail; do not guess an association.
			resized.push(`${result.mimeType}:${imageHash(Buffer.from(result.data, "base64"))}`);
			const hint = formatDimensionNote(result); if (hint) hints.push(hint);
		}
		this.pending.push({ text, hintedText: hints.length ? `${text}\n\n${hints.join("\n")}` : text, raw: hashesOf(images), resized, sources });
		// Cancelled/consumed inputs may never emit a message. Bound retained metadata.
		if (this.pending.length > 100) this.pending.shift();
	}

	capture(message: any) {
		if (message.role !== "user") return;
		const text = textOf(message), images = imagesOf(message), hashes = hashesOf(images);
		const matches = this.pending.filter(input =>
			(text === input.text && JSON.stringify(hashes) === JSON.stringify(input.raw)) ||
			(text === input.hintedText && JSON.stringify(hashes) === JSON.stringify(input.resized)));
		if (!matches.length || matches.some(input => JSON.stringify(input.sources) !== JSON.stringify(matches[0].sources))) return;
		const input = matches[0]; this.pending.splice(this.pending.indexOf(input), 1);
		const record = { key: messageKey(message), sources: input.sources.map(source => ({ ...source, imageHash: imageHash(Buffer.from(images[source.imageIndex].data, "base64")) })) };
		this.rendered.set(record.key, record.sources);
		return record;
	}

	forMessage(message: any, getBranch?: () => readonly any[]) {
		if (message.role !== "user") return [];
		try {
			const key = messageKey(message);
			// TUI reload rebuilds chat before session_start. Lazy persisted hydration
			// must not discard steering/follow-up provenance awaiting message_start.
			if (!this.rendered.has(key) && getBranch) this.hydrate(getBranch());
			return this.rendered.get(key) ?? [];
		}
		catch { return []; } // Malformed legacy blocks still use the renderer's unavailable marker.
	}
}

import { detectSupportedImageMimeTypeFromFile, resizeImage, type InputEvent, type InputEventResult } from "@earendil-works/pi-coding-agent";
import { getImageDimensions } from "@earendil-works/pi-tui";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { findImageReferences } from "./image-paths.mjs";

export const IMAGE_LIMITS = { count: 20, fileBytes: 20 * 1024 * 1024, totalBytes: 50 * 1024 * 1024, pixels: 64_000_000, dimension: 16_384 };
export const RASTER_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

export function resolveLocalImagePath(href: string, cwd = process.cwd()) {
	const normalized = href.trim().replace(/^<|>$/g, "");
	if (!normalized || /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(normalized)) return undefined;
	const decoded = normalized.replace(/\\([\\ ()\[\]<>"'`])/g, "$1");
	if (decoded.startsWith("~/")) return resolve(homedir(), decoded.slice(2));
	return isAbsolute(decoded) ? resolve(decoded) : resolve(cwd, decoded);
}

export function imageHash(bytes: Uint8Array) {
	return createHash("sha256").update(bytes).digest("hex");
}

export function imageBytes(image: { data: string; mimeType: string }) {
	if (!RASTER_MIME_TYPES.has(image.mimeType)) throw new Error("Only PNG, JPEG, WebP and GIF inline images are supported. Upload camera formats through X first.");
	if (typeof image.data !== "string" || !image.data || image.data.length > Math.ceil(IMAGE_LIMITS.fileBytes / 3) * 4 || (image.data.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(image.data))) throw new Error("Invalid or oversized image base64.");
	const bytes = Buffer.from(image.data, "base64");
	if (!bytes.length || bytes.length > IMAGE_LIMITS.fileBytes || bytes.toString("base64") !== image.data) throw new Error("Invalid or oversized image base64.");
	const magicMatches = image.mimeType === "image/png" ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
		: image.mimeType === "image/jpeg" ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
		: image.mimeType === "image/gif" ? /^(GIF87a|GIF89a)$/.test(bytes.subarray(0, 6).toString("ascii"))
		: bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP";
	if (!magicMatches) throw new Error("Image content does not match its MIME type.");
	const dimensions = getImageDimensions(image.data, image.mimeType);
	if (!dimensions || dimensions.widthPx < 1 || dimensions.heightPx < 1) throw new Error("Invalid image dimensions.");
	if (dimensions.widthPx > IMAGE_LIMITS.dimension || dimensions.heightPx > IMAGE_LIMITS.dimension || dimensions.widthPx * dimensions.heightPx > IMAGE_LIMITS.pixels) throw new Error("Image exceeds decoded pixel limits (64 MP, 16384 per side).");
	return bytes;
}

async function validateImage(image: { data: string; mimeType: string }, bytes: Buffer) {
	// Pi's exported worker decoder validates the pixels. Leave bytes untouched;
	// prompt() still owns model-specific normalization and resize hints.
	const decoded = await resizeImage(bytes, image.mimeType, { maxWidth: IMAGE_LIMITS.dimension, maxHeight: IMAGE_LIMITS.dimension, maxBytes: Math.ceil(IMAGE_LIMITS.fileBytes / 3) * 4 + 1 });
	if (!decoded) throw new Error("Image could not be decoded.");
	return bytes;
}

export async function loadReferencedImage(reference: string, cwd: string) {
	const path = resolveLocalImagePath(reference, cwd)!;
	const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
	try {
		const stat = await handle.stat();
		if (!stat.isFile()) throw new Error("Image reference is not a regular file.");
		if (!stat.size || stat.size > IMAGE_LIMITS.fileBytes) throw new Error("Image file exceeds 20 MiB or is empty.");
		// Sniff the already-opened regular file, not a second potentially raced path.
		const sniffPath = process.platform === "linux" ? `/proc/self/fd/${handle.fd}` : `/dev/fd/${handle.fd}`;
		const mimeType = await detectSupportedImageMimeTypeFromFile(sniffPath);
		if (!mimeType || !RASTER_MIME_TYPES.has(mimeType)) throw new Error("Unsupported image content. Use PNG, JPEG, WebP or GIF; upload camera formats through X first.");
		const bytes = Buffer.alloc(stat.size + 1);
		let length = 0;
		while (length < bytes.length) {
			const result = await handle.read(bytes, length, bytes.length - length, length);
			if (!result.bytesRead) break;
			length += result.bytesRead;
		}
		if (length !== stat.size) throw new Error("Image changed while being read; retry.");
		return { type: "image" as const, data: bytes.subarray(0, length).toString("base64"), mimeType };
	} finally { await handle.close(); }
}

export interface ImageSource { path: string; rawHash: string; imageIndex: number }

export async function transformImageInput(event: InputEvent, cwd: string, onSources?: (sources: ImageSource[]) => void): Promise<InputEventResult> {
	const references = findImageReferences(event.text);
	if (!references.length && !event.images?.length) return { action: "continue" };
	if (references.length > IMAGE_LIMITS.count || (event.images?.length ?? 0) > IMAGE_LIMITS.count) throw new Error("At most 20 image references/attachments per submission.");
	const images: NonNullable<InputEvent["images"]> = [], hashes = new Map<string, number>(), sources: ImageSource[] = [];
	let totalBytes = 0;
	const append = async (image: NonNullable<InputEvent["images"]>[number], label: string) => {
		try {
			const bytes = imageBytes(image), hash = imageHash(bytes);
			if (hashes.has(hash)) return hashes.get(hash)!;
			totalBytes += bytes.length;
			if (images.length >= IMAGE_LIMITS.count || totalBytes > IMAGE_LIMITS.totalBytes) throw new Error("Submission exceeds 20 images or 50 MiB total.");
			await validateImage(image, bytes);
			hashes.set(hash, images.length); images.push(image);
			return images.length - 1;
		} catch (error) { throw new Error(`${label}: ${(error as Error).message}`); }
	};
	for (const [index, image] of (event.images ?? []).entries()) await append(image, `Attached image ${index + 1}`);
	const paths = new Set<string>();
	for (const { path } of references) {
		const resolved = resolveLocalImagePath(path, cwd)!;
		if (paths.has(resolved)) continue;
		paths.add(resolved);
		let image;
		try { image = await loadReferencedImage(path, cwd); }
		catch (error) { throw new Error(`${path}: ${(error as Error).message}`); }
		const imageIndex = await append(image, path);
		sources.push({ path: resolved, rawHash: imageHash(imageBytes(image)), imageIndex });
	}
	onSources?.(sources);
	if (!references.length && images.length === event.images?.length) return { action: "continue" };
	return { action: "transform", text: event.text, images };
}

import { createHash } from "node:crypto";
import { closeSync, fstatSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { EntryRef } from "./session-store-client.js";

export const FLATTEN_LINEAGE_TYPE = "flatten-session-lineage";
export const FLATTEN_LINEAGE_VERSION = 2;
const MAX_PREFIX_LINE_BYTES = 8 * 1024 * 1024;

export type FlattenFileSnapshot = {
	dev: string;
	ino: string;
	size: string;
	mtimeNs: string;
};

export type FlattenTimestampShift = {
	entry: EntryRef;
	field: "message.timestamp" | "entry.timestamp";
	from: number;
	to: number;
};

export type FlattenLineageData = {
	version: typeof FLATTEN_LINEAGE_VERSION;
	destinationSessionId: string;
	source: {
		path: string;
		sessionId: string;
		leaf: EntryRef;
		compaction: EntryRef;
		firstKept: EntryRef | null;
		snapshot: FlattenFileSnapshot;
	};
	copiedSourceEntries: EntryRef[];
	timestampShift: FlattenTimestampShift;
	flattenedAt: string;
};

export type ValidatedFlattenLineage = {
	path: string;
	header: Record<string, unknown> & { type: "session"; id: string; parentSession: string };
	entry: Record<string, unknown> & { type: "custom"; customType: typeof FLATTEN_LINEAGE_TYPE; data: FlattenLineageData };
	data: FlattenLineageData;
	sourcePath: string;
};

function canonical(path: string) {
	return realpathSync.native(resolve(path));
}

function isEntryRef(value: unknown): value is EntryRef {
	if (!value || typeof value !== "object") return false;
	const ref = value as Partial<EntryRef>;
	return (ref.id === null || typeof ref.id === "string")
		&& Number.isSafeInteger(ref.ordinal) && Number(ref.ordinal) >= 0
		&& Number.isSafeInteger(ref.byteStart) && Number(ref.byteStart) >= 0
		&& Number.isSafeInteger(ref.byteEnd) && Number(ref.byteEnd) >= Number(ref.byteStart)
		&& typeof ref.sourceSha256 === "string" && /^[0-9a-f]{64}$/i.test(ref.sourceSha256);
}

export function entryRefKey(ref: EntryRef) {
	return `${ref.ordinal}:${ref.byteStart}:${ref.byteEnd}:${ref.sourceSha256}:${ref.id ?? ""}`;
}

export function entryRefsEqual(left: EntryRef | undefined, right: EntryRef | undefined) {
	return !!left && !!right && entryRefKey(left) === entryRefKey(right);
}

function firstNonemptyLines(path: string, count: number) {
	const fd = openSync(path, "r");
	const output: string[] = [];
	try {
		const size = fstatSync(fd).size;
		const buffer = Buffer.allocUnsafe(64 * 1024);
		const fragments: Buffer[] = [];
		let lineBytes = 0;
		let remaining = size;
		while (remaining > 0 && output.length < count) {
			const read = readSync(fd, buffer, 0, Math.min(buffer.length, remaining), null);
			if (!read) break;
			remaining -= read;
			let start = 0;
			for (let index = 0; index < read; index++) {
				if (buffer[index] !== 0x0a) continue;
				const fragment = Buffer.from(buffer.subarray(start, index));
				fragments.push(fragment);
				lineBytes += fragment.length;
				if (lineBytes > MAX_PREFIX_LINE_BYTES) throw new Error(`Session prefix line exceeds ${MAX_PREFIX_LINE_BYTES} bytes: ${path}`);
				const line = Buffer.concat(fragments, lineBytes).toString("utf8");
				if (line.trim()) output.push(line);
				fragments.length = 0;
				lineBytes = 0;
				start = index + 1;
				if (output.length >= count) break;
			}
			if (output.length < count && start < read) {
				const fragment = Buffer.from(buffer.subarray(start, read));
				fragments.push(fragment);
				lineBytes += fragment.length;
				if (lineBytes > MAX_PREFIX_LINE_BYTES) throw new Error(`Session prefix line exceeds ${MAX_PREFIX_LINE_BYTES} bytes: ${path}`);
			}
		}
		if (output.length < count && lineBytes) {
			const line = Buffer.concat(fragments, lineBytes).toString("utf8");
			if (line.trim()) output.push(line);
		}
		return output;
	} finally {
		closeSync(fd);
	}
}

function parseObject(line: string, label: string, path: string) {
	let value: unknown;
	try { value = JSON.parse(line); } catch { throw new Error(`Invalid ${label} JSON in ${path}.`); }
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid ${label} in ${path}.`);
	return value as Record<string, unknown>;
}

/** Reads only the header and first entry. A valid flattened file always stores lineage there. */
export function readFlattenLineage(path: string): ValidatedFlattenLineage | undefined {
	const selectedPath = canonical(path);
	const stats = statSync(selectedPath);
	if (!stats.isFile()) throw new Error(`Lineage source is not a regular file: ${selectedPath}`);
	const lines = firstNonemptyLines(selectedPath, 2);
	if (!lines.length) throw new Error(`Session has no header: ${selectedPath}`);
	const header = parseObject(lines[0], "session header", selectedPath);
	if (header.type !== "session" || typeof header.id !== "string") throw new Error(`Session has no valid header: ${selectedPath}`);
	if (lines.length < 2) return undefined;
	const entry = parseObject(lines[1], "first session entry", selectedPath);
	if (entry.type !== "custom" || entry.customType !== FLATTEN_LINEAGE_TYPE) return undefined;
	if (entry.parentId !== null) throw new Error(`Flatten lineage is not the root entry: ${selectedPath}`);
	const data = entry.data as Partial<FlattenLineageData> | undefined;
	if (!data || data.version !== FLATTEN_LINEAGE_VERSION || data.destinationSessionId !== header.id
		|| typeof data.flattenedAt !== "string" || !data.source || typeof data.source.path !== "string"
		|| typeof data.source.sessionId !== "string" || !isEntryRef(data.source.leaf)
		|| !isEntryRef(data.source.compaction) || !(data.source.firstKept === null || isEntryRef(data.source.firstKept))
		|| !data.source.snapshot || !Array.isArray(data.copiedSourceEntries)
		|| !data.copiedSourceEntries.every(isEntryRef) || !data.timestampShift
		|| !isEntryRef(data.timestampShift.entry) || !["message.timestamp", "entry.timestamp"].includes(data.timestampShift.field)
		|| typeof data.timestampShift.from !== "number" || !Number.isFinite(data.timestampShift.from)
		|| typeof data.timestampShift.to !== "number" || !Number.isFinite(data.timestampShift.to)
		|| data.timestampShift.to - data.timestampShift.from !== 1000) {
		throw new Error(`Invalid flatten lineage payload: ${selectedPath}`);
	}
	if (![data.source.snapshot.dev, data.source.snapshot.ino, data.source.snapshot.size, data.source.snapshot.mtimeNs]
		.every((value) => typeof value === "string" && /^\d+$/.test(value))) {
		throw new Error(`Flatten lineage has an invalid source snapshot: ${selectedPath}`);
	}
	const copiedKeys = new Set(data.copiedSourceEntries.map(entryRefKey));
	if (copiedKeys.size !== data.copiedSourceEntries.length) {
		throw new Error(`Flatten lineage has duplicate copied locators: ${selectedPath}`);
	}
	if (!copiedKeys.has(entryRefKey(data.source.compaction))
		|| data.source.firstKept && !copiedKeys.has(entryRefKey(data.source.firstKept))
		|| !copiedKeys.has(entryRefKey(data.timestampShift.entry))) {
		throw new Error(`Flatten lineage boundary locators are not represented in the copied source set: ${selectedPath}`);
	}
	const parent = canonical(resolve(dirname(selectedPath), String(header.parentSession ?? "")));
	const sourcePath = canonical(data.source.path);
	if (!header.parentSession || parent !== sourcePath) throw new Error(`Flatten lineage disagrees with header.parentSession: ${selectedPath}`);
	return {
		path: selectedPath,
		header: header as ValidatedFlattenLineage["header"],
		entry: entry as ValidatedFlattenLineage["entry"],
		data: data as FlattenLineageData,
		sourcePath,
	};
}

export function rawEntryRef(rawLine: Buffer, id: string | null, ordinal: number, byteStart: number): EntryRef {
	return {
		id,
		ordinal,
		byteStart,
		byteEnd: byteStart + rawLine.length,
		sourceSha256: createHash("sha256").update(rawLine).digest("hex"),
	};
}

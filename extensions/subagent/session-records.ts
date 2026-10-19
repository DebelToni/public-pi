import { parseSessionEntries } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import { StringDecoder } from "node:string_decoder";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

/** Read-only JSONL scan. Never opens SessionManager (which retains/repairs whole history). */
export function* sessionRecords(filePath: string, tolerateMalformed = false, byteLength?: number): Generator<any> {
	const fd = fs.openSync(filePath, "r");
	try {
		let remaining = Math.min(fs.fstatSync(fd).size, byteLength ?? Infinity);
		const buffer = Buffer.allocUnsafe(64 * 1024);
		const decoder = new StringDecoder("utf8");
		let pending = "";
		while (remaining > 0) {
			const count = fs.readSync(fd, buffer, 0, Math.min(buffer.length, remaining), null);
			if (!count) break;
			remaining -= count;
			pending += decoder.write(buffer.subarray(0, count));
			let start = 0;
			let newline: number;
			while ((newline = pending.indexOf("\n", start)) !== -1) {
				const line = pending.slice(start, newline);
				if (line.trim()) yield* tolerateMalformed ? parseSessionEntries(line) : [JSON.parse(line)];
				start = newline + 1;
			}
			pending = pending.slice(start);
		}
		pending += decoder.end();
		if (pending.trim()) yield* tolerateMalformed ? parseSessionEntries(pending) : [JSON.parse(pending)];
	} finally { fs.closeSync(fd); }
}

/** Project only top-level identity fields while streaming past arbitrarily large payloads.
 * JSONL records need not put id/parentId before message (custom entries do not).
 */
function* metadataRecords(filePath: string, allowIncompleteTail: boolean): Generator<any> {
	const keys = new Set(["type", "id", "parentId", "timestamp", "customType", "version", "cwd", "parentSession"]);
	const fd = fs.openSync(filePath, "r");
	try {
		let remaining = fs.fstatSync(fd).size;
		const buffer = Buffer.allocUnsafe(64 * 1024);
		const decoder = new StringDecoder("utf8");
		let depth = 0, quoted = false, escaped = false, readingKey = true, capture = false;
		let keyText = "", key = "", value = "";
		let record: any = {};
		const finishField = () => {
			if (capture) record[key] = JSON.parse(value);
			keyText = ""; value = ""; capture = false; readingKey = true;
		};
		while (remaining > 0) {
			const count = fs.readSync(fd, buffer, 0, Math.min(buffer.length, remaining), null);
			if (!count) break;
			remaining -= count;
			const chunk = decoder.write(buffer.subarray(0, count));
			for (const char of chunk) {
				if (char === "\n" && depth) throw new Error(`Malformed completed session record: ${filePath}`);
				if (depth === 0) {
					if (/\s/.test(char)) continue;
					if (char !== "{") throw new Error(`Invalid session JSONL: ${filePath}`);
					depth = 1; record = {}; readingKey = true; continue;
				}
				if (!quoted && depth === 1 && char === ":") {
					key = JSON.parse(keyText); readingKey = false; capture = keys.has(key); continue;
				}
				if (!quoted && depth === 1 && (char === "," || char === "}")) {
					finishField();
					if (char === "}") { depth = 0; yield record; }
					continue;
				}
				if (readingKey) keyText += char;
				else if (capture) value += char;
				if (keyText.length > 1024 || value.length > 64 * 1024) throw new Error(`Oversized session metadata: ${filePath}`);
				if (quoted) {
					if (escaped) escaped = false;
					else if (char === "\\") escaped = true;
					else if (char === '"') quoted = false;
				} else if (char === '"') quoted = true;
				else if (char === "{" || char === "[") depth++;
				else if (char === "}" || char === "]") depth--;
			}
		}
		if ((depth || quoted) && !allowIncompleteTail) throw new Error(`Incomplete session JSONL: ${filePath}`);
	} finally { fs.closeSync(fd); }
}

export function sessionMetadata(filePath: string, allowIncompleteTail = false) {
	let header: any;
	const entries: any[] = [];
	const byId = new Map<string, any>();
	for (const entry of metadataRecords(filePath, allowIncompleteTail)) {
		if (entry.type === "session") { header ??= entry; continue; }
		if (byId.has(entry.id)) throw new Error(`Duplicate session entry ID: ${entry.id}`);
		const metadata = { id: entry.id, parentId: entry.parentId, type: entry.type, timestamp: entry.timestamp, customType: entry.customType };
		entries.push(metadata);
		byId.set(entry.id, metadata);
	}
	if (!header) throw new Error(`Invalid saved session: ${filePath}`);
	return { header, entries, byId };
}

export function* branchMessages(filePath: string, boundary?: string): Generator<any> {
	const { entries, byId } = sessionMetadata(filePath);
	const ids = new Set<string>();
	let id = entries.at(-1)?.id;
	while (id && id !== boundary) {
		if (ids.has(id) || !byId.has(id)) throw new Error(`Invalid child session branch: ${filePath}`);
		ids.add(id);
		id = byId.get(id).parentId;
	}
	if (boundary && id !== boundary) throw new Error(`Child session boundary is missing: ${boundary}`);
	for (const entry of sessionRecords(filePath)) if (ids.has(entry.id) && entry.type === "message") yield entry.message;
}

/** Caller owns the child lease and has verified that no process is writing. Append only. */
export function appendSessionRecord(filePath: string, record: object) {
	const { entries } = sessionMetadata(filePath);
	const id = randomUUID();
	const fd = fs.openSync(filePath, "a+");
	try {
		const size = fs.fstatSync(fd).size;
		const last = Buffer.alloc(1);
		if (size && fs.readSync(fd, last, 0, 1, size - 1) && last[0] !== 10) fs.writeFileSync(fd, "\n");
		fs.writeFileSync(fd, `${JSON.stringify({ id, parentId: entries.at(-1)?.id ?? null, timestamp: new Date().toISOString(), ...record })}\n`);
		fs.fsyncSync(fd);
	} finally { fs.closeSync(fd); }
	return id;
}

function validateCompleteRecords(filePath: string, byteLength?: number) {
	let header = false;
	for (const entry of sessionRecords(filePath, false, byteLength)) {
		if (!header) {
			if (entry?.type !== "session" || typeof entry.id !== "string") throw new Error(`Invalid saved session: ${filePath}`);
			header = true;
		} else if (!entry || typeof entry.type !== "string" || typeof entry.id !== "string"
			|| entry.parentId !== null && typeof entry.parentId !== "string"
			|| entry.type === "message" && typeof entry.message?.role !== "string") {
			throw new Error(`Malformed completed session record: ${filePath}`);
		}
	}
	if (!header) throw new Error(`No complete child session header: ${filePath}`);
}

/** A crash may leave only the final, non-newline-terminated append incomplete.
 * Preserve that file byte-for-byte; continue in a synced sibling containing verified complete records.
 * Never skip a malformed newline-terminated record or rewrite original session evidence.
 */
export function recoverSessionTail(filePath: string) {
	try { sessionMetadata(filePath); validateCompleteRecords(filePath); return filePath; }
	catch (error) {
		if (!(error instanceof Error) || !error.message.startsWith("Incomplete session JSONL:")) throw error;
	}
	const source = fs.openSync(filePath, "r");
	let destination: number | undefined;
	let recovered: string | undefined;
	try {
		const size = fs.fstatSync(source).size;
		const buffer = Buffer.allocUnsafe(64 * 1024);
		let completeBytes = 0;
		for (let end = size; end > 0;) {
			const start = Math.max(0, end - buffer.length);
			const count = fs.readSync(source, buffer, 0, end - start, start);
			const newline = buffer.subarray(0, count).lastIndexOf(10);
			if (newline >= 0) { completeBytes = start + newline + 1; break; }
			end = start;
		}
		// Validate payload syntax as well as projected metadata before publishing anything.
		validateCompleteRecords(filePath, completeBytes);
		recovered = `${filePath}.recovered-${randomUUID()}.jsonl`;
		destination = fs.openSync(recovered, "wx", 0o600);
		for (let offset = 0; offset < completeBytes;) {
			const count = fs.readSync(source, buffer, 0, Math.min(buffer.length, completeBytes - offset), offset);
			if (!count) throw new Error(`Child session changed during recovery: ${filePath}`);
			fs.writeFileSync(destination, buffer.subarray(0, count));
			offset += count;
		}
		fs.fsyncSync(destination);
		fs.closeSync(destination); destination = undefined;
		appendSessionRecord(recovered, { type: "custom", customType: "subagent-tail-recovery", data: { sourceFile: filePath, completeBytes, sourceBytes: size } });
		const directory = fs.openSync(path.dirname(recovered), "r");
		try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
		return recovered;
	} catch (error) {
		if (destination !== undefined) { fs.closeSync(destination); destination = undefined; }
		if (recovered) fs.rmSync(recovered, { force: true });
		throw error;
	} finally { fs.closeSync(source); }
}

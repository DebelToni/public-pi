import * as fs from "node:fs";
import * as path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { Message } from "@earendil-works/pi-ai";
import type { SingleResult } from "./index.js";

/** An immutable prefix of a private message directory. Later attempts never overwrite records. */
export type ResultTranscript = { version: 1; directory: string; messageCount: number; lastMessage?: { role: string; timestamp?: number; sha256: string } };

export function resultOutput(result: { finalText?: string; messages?: any[] }): string {
	if (result.finalText !== undefined) return result.finalText;
	for (let i = (result.messages?.length ?? 0) - 1; i >= 0; i--) {
		const message = result.messages![i];
		if (message.role !== "assistant") continue;
		const text = message.content.filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n");
		// JSON parsers can return slices backed by a giant stdout chunk. Detach retained text.
		if (text) return Buffer.from(text, "utf8").toString("utf8");
	}
	return "";
}

export function createResultTranscript(root = path.join(getAgentDir(), "subagent-runs", "results")): ResultTranscript {
	fs.mkdirSync(root, { recursive: true, mode: 0o700 });
	fs.chmodSync(root, 0o700);
	const directory = path.join(root, randomUUID());
	fs.mkdirSync(directory, { mode: 0o700 });
	const fd = fs.openSync(root, "r");
	try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
	return { version: 1, directory: path.resolve(directory), messageCount: 0 };
}

export function appendResultMessage(reference: ResultTranscript, message: Message): ResultTranscript {
	const file = path.join(reference.directory, `${reference.messageCount}.json`);
	const fd = fs.openSync(file, "wx", 0o600);
	const json = JSON.stringify(message);
	const sha256 = createHash("sha256").update(json).digest("hex");
	try {
		fs.writeFileSync(fd, `{"version":1,"sha256":"${sha256}","message":${json}}\n`);
		fs.fsyncSync(fd);
	} finally { fs.closeSync(fd); }
	const dir = fs.openSync(reference.directory, "r");
	try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
	return { ...reference, messageCount: reference.messageCount + 1,
		lastMessage: { role: message.role, ...(message.timestamp === undefined ? {} : { timestamp: message.timestamp }), sha256 } };
}

/** No backing reads for already-normalized results. Does not mutate input or any session JSONL.
 * Legacy messages are saved exactly, one record at a time, before references are returned.
 */
export function normalizeSingleResult(result: SingleResult, root?: string): SingleResult {
	if (result.transcript && (result.transcript.version !== 1 || !path.isAbsolute(result.transcript.directory)
		|| !Number.isSafeInteger(result.transcript.messageCount) || result.transcript.messageCount < 0 || typeof result.finalText !== "string")) {
		throw new Error("Invalid disk-backed result metadata.");
	}
	if (result.transcript && result.messages.length) throw new Error("Result has both inline and disk-backed messages.");
	let transcript = result.transcript;
	if (!transcript && result.messages.length) {
		transcript = createResultTranscript(root);
		for (const message of result.messages) transcript = appendResultMessage(transcript, message);
	}
	return {
		...result, messages: [], finalText: resultOutput(result),
		usage: { ...result.usage },
		...(result.sessionFile ?? result.resume?.filePath ? { sessionFile: result.sessionFile ?? result.resume!.filePath } : {}),
		...(transcript ? { transcript: { ...transcript } } : {}),
		...(result.resume ? { resume: { ...result.resume } } : {}),
	};
}

// Pi's JSON stream includes system and built-in AgentMessage roles, not only chat replies.
function supportedMessage(message: any) {
	if (!message || typeof message !== "object") return false;
	if (["system", "user", "assistant", "toolResult", "custom"].includes(message.role)) {
		return typeof message.content === "string" || Array.isArray(message.content);
	}
	if (message.role === "bashExecution") return typeof message.command === "string" && typeof message.output === "string";
	if (message.role === "branchSummary" || message.role === "compactionSummary") return typeof message.summary === "string";
	return false;
}

function recordDigest(file: string) {
	const hash = createHash("sha256");
	const fd = fs.openSync(file, "r");
	const buffer = Buffer.allocUnsafe(64 * 1024);
	try {
		let count: number;
		while ((count = fs.readSync(fd, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, count));
	} finally { fs.closeSync(fd); }
	return hash.digest("hex");
}

/** Verified ancestry only: compare the normalization representation change without hydrating disk messages.
 * Every enclosing field remains exact. Each inline message must match the complete stored record bytes.
 */
export function sameMigratedResult(left: SingleResult, right: SingleResult) {
	if (isDeepStrictEqual(left, right)) return true;
	const metadata = (result: SingleResult) => {
		const { messages: _messages, transcript: _transcript, ...rest } = result;
		return { ...rest, finalText: resultOutput(result),
			...(result.sessionFile ?? result.resume?.filePath ? { sessionFile: result.sessionFile ?? result.resume!.filePath } : {}) };
	};
	if (!isDeepStrictEqual(metadata(left), metadata(right))) return false;
	if (!left.transcript && !right.transcript) return !left.messages.length && !right.messages.length;
	const a = left.transcript, b = right.transcript;
	for (const result of [left, right]) {
		if (result.transcript && (result.messages.length || result.transcript.version !== 1
			|| !path.isAbsolute(result.transcript.directory) || typeof result.finalText !== "string")) return false;
	}
	const count = a?.messageCount ?? left.messages.length;
	if (count !== (b?.messageCount ?? right.messages.length) || !Number.isSafeInteger(count) || count < 0) return false;
	if (a && b) {
		const { directory: _aDirectory, ...aMetadata } = a;
		const { directory: _bDirectory, ...bMetadata } = b;
		if (!isDeepStrictEqual(aMetadata, bMetadata)) return false;
		for (let i = 0; i < count; i++) {
			if (recordDigest(path.join(a.directory, `${i}.json`)) !== recordDigest(path.join(b.directory, `${i}.json`))) return false;
		}
		return true;
	}
	const reference = (a ?? b)!;
	if (Object.keys(reference).some((key) => !["version", "directory", "messageCount", "lastMessage"].includes(key))) return false;
	const inline = a ? right.messages : left.messages;
	if (count === 0) return reference.lastMessage === undefined;
	for (let i = 0; i < count; i++) {
		const json = JSON.stringify(inline[i]);
		const sha256 = createHash("sha256").update(json).digest("hex");
		const expected = createHash("sha256").update(`{"version":1,"sha256":"${sha256}","message":`).update(json).update("}\n").digest("hex");
		if (recordDigest(path.join(reference.directory, `${i}.json`)) !== expected) return false;
		if (i === count - 1 && !isDeepStrictEqual(reference.lastMessage, { role: inline[i].role, ...(inline[i].timestamp === undefined ? {} : { timestamp: inline[i].timestamp }), sha256 })) return false;
	}
	return true;
}

/** Explicit access only. Bounded by 32 messages AND 4 MiB, including for old inline data.
 * Oversized records are never silently skipped: error includes the exact raw record path.
 */
export function readResultPage(result: Pick<SingleResult, "messages" | "transcript">, start = 0, limit = 16, maxBytes = 1024 * 1024) {
	if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 32
		|| !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 4 * 1024 * 1024) throw new Error("Invalid result page window.");
	const ref = result.transcript;
	if (ref && (ref.version !== 1 || !path.isAbsolute(ref.directory) || !Number.isSafeInteger(ref.messageCount) || ref.messageCount < 0)) {
		throw new Error("Invalid result transcript reference.");
	}
	const total = ref?.messageCount ?? result.messages.length;
	const messages: Message[] = [];
	let bytes = 0;
	for (let index = start; index < Math.min(total, start + limit); index++) {
		const file = ref ? path.join(ref.directory, `${index}.json`) : undefined;
		const size = file ? fs.statSync(file).size : Buffer.byteLength(JSON.stringify(result.messages[index]));
		if (size > maxBytes) throw new Error(`Result record exceeds page byte budget: ${file ?? `inline message ${index}`}`);
		if (bytes + size > maxBytes) break;
		const record = file ? JSON.parse(fs.readFileSync(file, "utf8")) : undefined;
		if (file && (record?.version !== 1 || !record.message
			|| record.sha256 !== createHash("sha256").update(JSON.stringify(record.message)).digest("hex"))) {
			throw new Error(`Invalid result record or checksum: ${file}`);
		}
		const message = file ? record.message : result.messages[index];
		if (!supportedMessage(message)) {
			throw new Error(`Invalid result message: ${file ?? index}`);
		}
		messages.push(message);
		bytes += size;
	}
	return { messages, next: start + messages.length < total ? start + messages.length : undefined, total };
}

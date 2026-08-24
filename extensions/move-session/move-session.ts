import { randomUUID } from "node:crypto";
import {
	accessSync,
	constants,
	closeSync,
	existsSync,
	fsyncSync,
	linkSync,
	openSync,
	readSync,
	realpathSync,
	rmSync,
	rmdirSync,
	statSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { SessionManager, type SessionHeader } from "@earendil-works/pi-coding-agent";

const MAX_HEADER_BYTES = 1024 * 1024;
const COPY_BUFFER_BYTES = 64 * 1024;

export const CWD_CHANGE_MESSAGE_TYPE = "session-cwd-change";

export type FileSnapshot = {
	dev: bigint;
	ino: bigint;
	size: bigint;
	mtimeNs: bigint;
};

export type SessionMoveSource = Pick<
	SessionManager,
	"getCwd" | "getSessionId" | "getSessionFile" | "getLeafId" | "getEntries"
>;

export type PreparedSessionMove = {
	sourcePath: string;
	destinationPath: string;
	sourceCwd: string;
	targetCwd: string;
	sessionId: string;
	noticeEntryId: string;
	sourceSnapshot: FileSnapshot;
	destinationSnapshot: FileSnapshot;
};

export type SessionMoveDestination = Pick<
	SessionManager,
	"getCwd" | "getSessionId" | "getSessionFile" | "getLeafEntry"
>;

function pathArgument(input: string) {
	let value = input.trim();
	if (value.length >= 2) {
		const first = value[0];
		if ((first === '"' || first === "'") && value.at(-1) === first) value = value.slice(1, -1);
	}
	if (!value) throw new Error("Usage: /move-session <existing-directory>");
	if (value === "~") return homedir();
	if (value.startsWith("~/")) return join(homedir(), value.slice(2));
	return value;
}

export function resolveTargetCwd(input: string, currentCwd: string) {
	const value = pathArgument(input);
	const resolved = isAbsolute(value) ? resolve(value) : resolve(currentCwd, value);
	let canonical: string;
	try {
		canonical = realpathSync.native(resolved);
	} catch {
		throw new Error(`Directory does not exist: ${resolved}`);
	}
	let stats;
	try {
		stats = statSync(canonical);
	} catch {
		throw new Error(`Cannot inspect directory: ${canonical}`);
	}
	if (!stats.isDirectory()) throw new Error(`Not a directory: ${canonical}`);
	try {
		accessSync(canonical, constants.R_OK | constants.W_OK | constants.X_OK);
	} catch {
		throw new Error(`Directory is not readable, writable, and searchable: ${canonical}`);
	}
	return canonical;
}

function snapshot(path: string): FileSnapshot {
	const stats = statSync(path, { bigint: true });
	if (!stats.isFile()) throw new Error(`Session path is not a regular file: ${path}`);
	return { dev: stats.dev, ino: stats.ino, size: stats.size, mtimeNs: stats.mtimeNs };
}

export function snapshotsEqual(left: FileSnapshot, right: FileSnapshot) {
	return left.dev === right.dev
		&& left.ino === right.ino
		&& left.size === right.size
		&& left.mtimeNs === right.mtimeNs;
}

function writeAll(fd: number, bytes: Buffer) {
	let offset = 0;
	while (offset < bytes.length) {
		const written = writeSync(fd, bytes, offset, bytes.length - offset);
		if (written === 0) throw new Error("Could not finish writing the prepared session.");
		offset += written;
	}
}

function parseHeader(bytes: Buffer, sourcePath: string): SessionHeader {
	let parsed: unknown;
	try {
		parsed = JSON.parse(bytes.toString("utf8"));
	} catch {
		throw new Error(`Session header is invalid JSON: ${sourcePath}`);
	}
	if (!parsed || typeof parsed !== "object" || (parsed as { type?: unknown }).type !== "session") {
		throw new Error(`Session file has no valid header: ${sourcePath}`);
	}
	const header = parsed as SessionHeader;
	if (typeof header.id !== "string" || typeof header.cwd !== "string") {
		throw new Error(`Session header is missing id or cwd: ${sourcePath}`);
	}
	return header;
}

function copyWithChangedHeader(sourcePath: string, temporaryPath: string, targetCwd: string) {
	const before = snapshot(sourcePath);
	const sourceMode = Number(statSync(sourcePath, { bigint: true }).mode & 0o777n);
	let inputFd: number | undefined;
	let outputFd: number | undefined;
	let header: SessionHeader | undefined;
	try {
		inputFd = openSync(sourcePath, "r");
		outputFd = openSync(temporaryPath, "wx", sourceMode);
		const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
		const headerChunks: Buffer[] = [];
		let headerBytes = 0;
		for (;;) {
			const count = readSync(inputFd, buffer, 0, buffer.length, null);
			if (count === 0) break;
			const chunk = buffer.subarray(0, count);
			if (header) {
				writeAll(outputFd, chunk);
				continue;
			}
			const newline = chunk.indexOf(0x0a);
			if (newline < 0) {
				headerChunks.push(Buffer.from(chunk));
				headerBytes += chunk.length;
				if (headerBytes > MAX_HEADER_BYTES) throw new Error(`Session header exceeds ${MAX_HEADER_BYTES} bytes.`);
				continue;
			}
			headerChunks.push(Buffer.from(chunk.subarray(0, newline)));
			headerBytes += newline;
			if (headerBytes > MAX_HEADER_BYTES) throw new Error(`Session header exceeds ${MAX_HEADER_BYTES} bytes.`);
			header = parseHeader(Buffer.concat(headerChunks, headerBytes), sourcePath);
			writeAll(outputFd, Buffer.from(`${JSON.stringify({ ...header, cwd: targetCwd })}\n`, "utf8"));
			writeAll(outputFd, chunk.subarray(newline + 1));
		}
		if (!header) throw new Error(`Session file has no complete header: ${sourcePath}`);
		fsyncSync(outputFd);
	} finally {
		if (inputFd !== undefined) closeSync(inputFd);
		if (outputFd !== undefined) closeSync(outputFd);
	}
	const after = snapshot(sourcePath);
	if (!snapshotsEqual(before, after)) throw new Error("Session changed while it was being copied; retry after other writers stop.");
	return { header, sourceSnapshot: before };
}

function fsyncDirectory(path: string) {
	let fd: number | undefined;
	try {
		fd = openSync(path, "r");
		fsyncSync(fd);
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

function uniquePathForSameDirectory(targetDirectory: string, sessionId: string) {
	const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
	for (let attempt = 0; attempt < 10; attempt++) {
		const suffix = attempt === 0 ? "" : `-${randomUUID().slice(0, 8)}`;
		const candidate = join(targetDirectory, `${timestamp}${suffix}_${sessionId}.jsonl`);
		if (!existsSync(candidate)) return candidate;
	}
	throw new Error("Could not allocate a destination session filename.");
}

function destinationPath(sourcePath: string, targetDirectory: string, sessionId: string) {
	const candidate = join(targetDirectory, basename(sourcePath));
	if (resolve(candidate) === resolve(sourcePath)) return uniquePathForSameDirectory(targetDirectory, sessionId);
	if (existsSync(candidate)) throw new Error(`Destination session already exists: ${candidate}`);
	return candidate;
}

function hiddenCwdNotice(sourceCwd: string, targetCwd: string) {
	if (sourceCwd === targetCwd) {
		return `Session-storage update: the JSONL was relocated to the session directory for ${JSON.stringify(targetCwd)}. The working directory remains ${JSON.stringify(targetCwd)}.`;
	}
	return `Working-directory update: cwd changed from ${JSON.stringify(sourceCwd)} to ${JSON.stringify(targetCwd)}. Use ${JSON.stringify(targetCwd)} for all subsequent relative paths and tool commands.`;
}

function newEntryId(entries: readonly { id?: string }[]) {
	const ids = new Set(entries.map((entry) => entry.id).filter((id): id is string => typeof id === "string"));
	for (let attempt = 0; attempt < 100; attempt++) {
		const id = randomUUID().replace(/-/g, "").slice(0, 8);
		if (!ids.has(id)) return id;
	}
	throw new Error("Could not allocate a session entry ID.");
}

function appendHiddenNotice(
	temporaryPath: string,
	sessionManager: SessionMoveSource,
	sourceCwd: string,
	targetCwd: string,
) {
	const entries = sessionManager.getEntries();
	const activeLeaf = sessionManager.getLeafId();
	if (activeLeaf && !entries.some((entry) => entry.id === activeLeaf)) {
		throw new Error("The active session leaf is missing from the JSONL entries.");
	}
	const id = newEntryId(entries);
	const entry = {
		type: "custom_message",
		id,
		parentId: activeLeaf,
		timestamp: new Date().toISOString(),
		customType: CWD_CHANGE_MESSAGE_TYPE,
		content: hiddenCwdNotice(sourceCwd, targetCwd),
		display: false,
		details: {
			previousCwd: sourceCwd,
			cwd: targetCwd,
			movedAt: Date.now(),
			...(sourceCwd === targetCwd ? { storageRepair: true } : {}),
		},
	};
	const fd = openSync(temporaryPath, "a");
	try {
		writeAll(fd, Buffer.from(`${JSON.stringify(entry)}\n`, "utf8"));
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	return id;
}

export function prepareSessionMove(sessionManager: SessionMoveSource, targetCwd: string): PreparedSessionMove {
	const sourcePath = sessionManager.getSessionFile();
	if (!sourcePath || !existsSync(sourcePath)) {
		throw new Error("The current session has no saved JSONL file and cannot be moved yet.");
	}
	const sourceCwd = realpathSync.native(sessionManager.getCwd());
	const canonicalTargetCwd = realpathSync.native(targetCwd);
	const targetDirectory = SessionManager.create(canonicalTargetCwd).getSessionDir();
	if (
		sourceCwd === canonicalTargetCwd
		&& realpathSync.native(dirname(sourcePath)) === realpathSync.native(targetDirectory)
	) {
		throw new Error(`Session already uses cwd and storage directory: ${canonicalTargetCwd}`);
	}
	const destination = destinationPath(sourcePath, targetDirectory, sessionManager.getSessionId());
	const temporary = join(targetDirectory, `.move-session-${process.pid}-${randomUUID()}.tmp`);
	let installed = false;
	try {
		const copied = copyWithChangedHeader(sourcePath, temporary, canonicalTargetCwd);
		if (copied.header.id !== sessionManager.getSessionId()) {
			throw new Error("Session ID in memory does not match the session file.");
		}

		const noticeEntryId = appendHiddenNotice(temporary, sessionManager, sourceCwd, canonicalTargetCwd);
		if (!snapshotsEqual(copied.sourceSnapshot, snapshot(sourcePath))) {
			throw new Error("Session changed while the move was prepared; retry after other writers stop.");
		}

		linkSync(temporary, destination);
		installed = true;
		unlinkSync(temporary);
		fsyncDirectory(targetDirectory);
		return {
			sourcePath,
			destinationPath: destination,
			sourceCwd,
			targetCwd: canonicalTargetCwd,
			sessionId: sessionManager.getSessionId(),
			noticeEntryId,
			sourceSnapshot: copied.sourceSnapshot,
			destinationSnapshot: snapshot(destination),
		};
	} catch (error) {
		rmSync(temporary, { force: true });
		if (installed) rmSync(destination, { force: true });
		throw error;
	}
}

export function replacementMatches(move: PreparedSessionMove, sessionManager: SessionMoveDestination) {
	const leaf = sessionManager.getLeafEntry();
	return sessionManager.getSessionId() === move.sessionId
		&& resolve(sessionManager.getSessionFile() ?? "") === resolve(move.destinationPath)
		&& sessionManager.getCwd() === move.targetCwd
		&& leaf?.id === move.noticeEntryId
		&& leaf.type === "custom_message"
		&& leaf.customType === CWD_CHANGE_MESSAGE_TYPE;
}

export function discardPreparedMove(move: PreparedSessionMove) {
	try {
		if (!snapshotsEqual(move.destinationSnapshot, snapshot(move.destinationPath))) return false;
		unlinkSync(move.destinationPath);
		try {
			fsyncDirectory(dirname(move.destinationPath));
		} catch {
			// The prepared copy is already gone; directory sync is best-effort here.
		}
		return true;
	} catch {
		return false;
	}
}

export function removeSourceIfUnchanged(move: PreparedSessionMove) {
	try {
		if (!snapshotsEqual(move.sourceSnapshot, snapshot(move.sourcePath))) return false;
		unlinkSync(move.sourcePath);
		try {
			fsyncDirectory(dirname(move.sourcePath));
		} catch {
			// The destination is verified and the source path is already removed.
		}
		try {
			rmdirSync(dirname(move.sourcePath));
		} catch {
			// Other sessions still use the source directory.
		}
		return true;
	} catch {
		return false;
	}
}

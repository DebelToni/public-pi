import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const CONTINUATION_MANIFEST_VERSION = 1;

export interface ContinuationManifest<TArgs = unknown, TDetails = unknown> {
	version: typeof CONTINUATION_MANIFEST_VERSION;
	id: string;
	parentSessionId: string;
	parentSessionFile?: string;
	parentBranchAnchor: string | null;
	parentToolCallId: string;
	mode: "single" | "parallel" | "fan-in" | "chain";
	args: TArgs;
	details: TDetails;
	status: "pending" | "interrupted" | "ready" | "resolved";
	createdAt: number;
	updatedAt: number;
}

export interface ContinuationLocation {
	dir: string;
	filePath: string;
	childrenRoot: string;
}

export function continuationRoot() {
	return path.join(getAgentDir(), "subagent-runs");
}

function directoryName(id: string, parentSessionId: string) {
	return createHash("sha256").update(parentSessionId).update("\0").update(id).digest("hex");
}

export function getContinuationLocation(
	id: string,
	parentSessionId: string,
	root = continuationRoot(),
): ContinuationLocation {
	const dir = path.join(root, directoryName(id, parentSessionId));
	return {
		dir,
		filePath: path.join(dir, "manifest.json"),
		childrenRoot: path.join(dir, "children"),
	};
}

function ensurePrivateDirectory(dir: string) {
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	fs.chmodSync(dir, 0o700);
}

function fsyncDirectory(dir: string) {
	const fd = fs.openSync(dir, "r");
	try {
		fs.fsyncSync(fd);
	} finally {
		fs.closeSync(fd);
	}
}

export function writeContinuationManifest<TArgs, TDetails>(
	manifest: ContinuationManifest<TArgs, TDetails>,
	root = continuationRoot(),
): ContinuationLocation {
	ensurePrivateDirectory(root);
	const location = getContinuationLocation(manifest.id, manifest.parentSessionId, root);
	ensurePrivateDirectory(location.dir);
	const temporary = path.join(location.dir, `.manifest-${randomUUID()}.tmp`);
	let fd: number | undefined;
	try {
		fd = fs.openSync(temporary, "wx", 0o600);
		// Keep discovery fields before potentially large legacy args/details.
		const { args, details, ...metadata } = manifest;
		fs.writeFileSync(fd, `${JSON.stringify({ ...metadata, args, details })}\n`, "utf8");
		fs.fsyncSync(fd);
		fs.closeSync(fd);
		fd = undefined;
		fs.renameSync(temporary, location.filePath);
		fs.chmodSync(location.filePath, 0o600);
		fsyncDirectory(location.dir);
		fsyncDirectory(root);
		return location;
	} catch (error) {
		if (fd !== undefined) fs.closeSync(fd);
		try {
			fs.rmSync(temporary, { force: true });
		} catch {
			/* ignore cleanup failure */
		}
		throw error;
	}
}

export type ContinuationMetadata = Omit<ContinuationManifest, "args" | "details"> & { filePath: string };
type MetadataFilter = {
	toolCallIds?: ReadonlySet<string>;
	referenceIds?: ReadonlySet<string>;
	id?: string;
	parentSessionId?: string;
	parentSessionFile?: string;
	// File-identity hint only: source discovery must still include other forks.
	candidateParentSessionId?: string;
};

const metadataKeys = new Set(["version", "id", "parentSessionId", "parentSessionFile", "parentBranchAnchor", "parentToolCallId", "mode", "status", "createdAt", "updatedAt"]);

function validMetadataField(key: string, value: unknown) {
	switch (key) {
		case "version": case "createdAt": case "updatedAt": return typeof value === "number";
		case "parentBranchAnchor": return value === null || typeof value === "string";
		case "mode": return ["single", "parallel", "fan-in", "chain"].includes(value as string);
		case "status": return ["pending", "interrupted", "ready", "resolved"].includes(value as string);
		default: return typeof value === "string";
	}
}

function matchesMetadata(metadata: Partial<ContinuationMetadata>, filter: MetadataFilter) {
	return !(filter.id && metadata.id !== undefined && metadata.id !== filter.id
		|| filter.toolCallIds && metadata.parentToolCallId !== undefined && !filter.toolCallIds.has(metadata.parentToolCallId)
		|| filter.referenceIds && metadata.id !== undefined && metadata.parentToolCallId !== undefined
			&& !filter.referenceIds.has(metadata.id) && !filter.referenceIds.has(metadata.parentToolCallId)
		|| filter.parentSessionId && metadata.parentSessionId !== undefined && metadata.parentSessionId !== filter.parentSessionId
		|| filter.parentSessionFile && metadata.parentSessionFile && path.resolve(metadata.parentSessionFile) !== path.resolve(filter.parentSessionFile));
}

function isIdentifiedTarget(metadata: Partial<ContinuationMetadata>, filePath: string, filter: MetadataFilter) {
	if (filter.parentSessionId && typeof metadata.parentSessionId === "string" && metadata.parentSessionId !== filter.parentSessionId) return false;
	if (filter.parentSessionFile && typeof metadata.parentSessionFile === "string"
		&& path.resolve(metadata.parentSessionFile) !== path.resolve(filter.parentSessionFile)) return false;
	if (filter.id && metadata.id === filter.id) return true;
	const ids = filter.toolCallIds ?? filter.referenceIds;
	if (ids && (ids.has(metadata.id!) || ids.has(metadata.parentToolCallId!))) return true;
	const parent = filter.parentSessionId ?? filter.candidateParentSessionId;
	const candidateIds = ids ?? (filter.id ? [filter.id] : []);
	if (parent && [...candidateIds].some((id) => path.basename(path.dirname(filePath)) === directoryName(id, parent))) return true;
	return !filter.id && !ids && !!filter.parentSessionId && metadata.parentSessionId === filter.parentSessionId;
}

/** Bounded, read-only projection for legacy manifests, including metadata after payloads.
 * Reject unrelated owners/calls as soon as their identity is known. Never decode args/details.
 * Unknown corrupt/unreadable historical files are best-effort; identified target errors propagate.
 */
function readManifestMetadata(filePath: string, filter: MetadataFilter): ContinuationMetadata | undefined {
	let fd: number | undefined;
	const metadata: any = {};
	try {
		const source = fs.openSync(filePath, "r");
		fd = source;
		const buffer = Buffer.allocUnsafe(64 * 1024);
		let offset = 0, length = 0;
		const fail = (): never => { throw new Error(`Malformed continuation manifest: ${filePath}`); };
		const peek = () => {
			if (offset === length) { length = fs.readSync(source, buffer, 0, buffer.length, null); offset = 0; }
			return length ? buffer[offset] : -1;
		};
		const take = () => { const byte = peek(); if (byte !== -1) offset++; return byte; };
		const space = () => { while ([9, 10, 13, 32].includes(peek())) take(); };
		const expect = (byte: number) => { if (take() !== byte) fail(); };
		const string = (capture: boolean, limit = 64 * 1024): string => {
			expect(34);
			const bytes: number[] = capture ? [34] : [];
			let escaped = false, unicode = 0;
			for (;;) {
				const byte = take();
				if (byte < 32) fail();
				if (capture) { bytes.push(byte); if (bytes.length > limit) throw new Error(`Oversized continuation metadata: ${filePath}`); }
				if (unicode) {
					if (!(byte >= 48 && byte <= 57 || byte >= 65 && byte <= 70 || byte >= 97 && byte <= 102)) fail();
					unicode--; continue;
				}
				if (escaped) {
					if (byte === 117) unicode = 4;
					else if (![34, 47, 92, 98, 102, 110, 114, 116].includes(byte)) fail();
					escaped = false;
				} else if (byte === 92) escaped = true;
				else if (byte === 34) return capture ? JSON.parse(Buffer.from(bytes).toString("utf8")) : "";
			}
		};
		const digit = () => peek() >= 48 && peek() <= 57;
		const value = (depth = 0): void => {
			if (depth > 256) throw new Error(`Continuation JSON nesting exceeds 256: ${filePath}`);
			space();
			const byte = peek();
			if (byte === 34) { string(false); return; }
			if (byte === 123 || byte === 91) {
				take(); space();
				const close = byte === 123 ? 125 : 93;
				if (peek() === close) { take(); return; }
				for (;;) {
					if (byte === 123) { string(false); space(); expect(58); }
					value(depth + 1); space();
					if (peek() === close) { take(); return; }
					expect(44); space();
				}
			}
			if (byte === 116 || byte === 102 || byte === 110) {
				for (const char of byte === 116 ? "true" : byte === 102 ? "false" : "null") expect(char.charCodeAt(0));
				return;
			}
			if (peek() === 45) take();
			if (peek() === 48) take();
			else { if (!digit()) fail(); while (digit()) take(); }
			if (peek() === 46) { take(); if (!digit()) fail(); while (digit()) take(); }
			if (peek() === 101 || peek() === 69) {
				take(); if (peek() === 43 || peek() === 45) take();
				if (!digit()) fail(); while (digit()) take();
			}
		};
		space(); expect(123); space();
		if (peek() !== 125) for (;;) {
			const key = string(true, 1024); space(); expect(58); space();
			if (metadataKeys.has(key)) {
				if (Object.hasOwn(metadata, key)) fail();
				if (peek() === 34) metadata[key] = string(true);
				else {
					let scalar = "";
					while (peek() !== -1 && ![9, 10, 13, 32, 44, 125].includes(peek())) {
						scalar += String.fromCharCode(take());
						if (scalar.length > 64 * 1024) throw new Error(`Oversized continuation metadata: ${filePath}`);
					}
					metadata[key] = JSON.parse(scalar);
				}
				if (!validMetadataField(key, metadata[key])) fail();
				if (key === "version" && metadata.version !== CONTINUATION_MANIFEST_VERSION) return undefined;
				if (!matchesMetadata(metadata, filter)) return undefined;
			} else value();
			space();
			if (peek() === 125) break;
			expect(44); space();
		}
		expect(125); space(); if (peek() !== -1) fail();
		for (const key of metadataKeys) if (key !== "parentSessionFile" && !Object.hasOwn(metadata, key)) fail();
		return { ...metadata, filePath };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT" && isIdentifiedTarget(metadata, filePath, filter)) throw error;
		return undefined;
	} finally { if (fd !== undefined) fs.closeSync(fd); }
}

export function listContinuationMetadata(root = continuationRoot(), filter: MetadataFilter = {}): ContinuationMetadata[] {
	let entries: fs.Dirent[];
	try { entries = fs.readdirSync(root, { withFileTypes: true }); }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
	const manifests: ContinuationMetadata[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const metadata = readManifestMetadata(path.join(root, entry.name, "manifest.json"), filter);
		if (metadata) manifests.push(metadata);
	}
	return manifests;
}

export function readContinuationPayload<TArgs = unknown, TDetails = unknown>(metadata: Pick<ContinuationMetadata, "filePath" | "id" | "parentSessionId">): ContinuationManifest<TArgs, TDetails> | undefined {
	let parsed: any;
	try { parsed = JSON.parse(fs.readFileSync(metadata.filePath, "utf8")); }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
	if (parsed?.version !== CONTINUATION_MANIFEST_VERSION || parsed?.id !== metadata.id || parsed?.parentSessionId !== metadata.parentSessionId) {
		throw new Error(`Continuation manifest identity changed: ${metadata.filePath}`);
	}
	return parsed;
}

export function readContinuationManifest<TArgs = unknown, TDetails = unknown>(
	id: string,
	root = continuationRoot(),
	parentSessionId?: string,
): ContinuationManifest<TArgs, TDetails> | undefined {
	if (parentSessionId) return readContinuationPayload<TArgs, TDetails>({
		id, parentSessionId, filePath: getContinuationLocation(id, parentSessionId, root).filePath,
	});
	const metadata = listContinuationMetadata(root, { id }).sort((left, right) => right.updatedAt - left.updatedAt)[0];
	return metadata ? readContinuationPayload<TArgs, TDetails>(metadata) : undefined;
}

/** Explicit full listing. Lifecycle/discovery callers must use metadata and lazy payload reads. */
export function listContinuationManifests<TArgs = unknown, TDetails = unknown>(root = continuationRoot()): Array<ContinuationManifest<TArgs, TDetails>> {
	return listContinuationMetadata(root).flatMap((metadata) => {
		const manifest = readContinuationPayload<TArgs, TDetails>(metadata);
		return manifest ? [manifest] : [];
	});
}

function processIsAlive(pid: number) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

export function acquireContinuationLease(
	id: string,
	parentSessionId: string,
	root = continuationRoot(),
) {
	const location = getContinuationLocation(id, parentSessionId, root);
	ensurePrivateDirectory(location.dir);
	const leasePath = path.join(location.dir, "lease.json");
	const token = randomUUID();
	for (let attempt = 0; attempt < 4; attempt++) {
		const temporary = path.join(location.dir, `.lease-${randomUUID()}.tmp`);
		try {
			const fd = fs.openSync(temporary, "wx", 0o600);
			try {
				fs.writeFileSync(fd, `${JSON.stringify({ token, pid: process.pid, createdAt: Date.now() })}\n`, "utf8");
				fs.fsyncSync(fd);
			} finally {
				fs.closeSync(fd);
			}
			try {
				fs.linkSync(temporary, leasePath);
				fsyncDirectory(location.dir);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
				let before: fs.Stats;
				try {
					before = fs.statSync(leasePath);
				} catch (statError) {
					if ((statError as NodeJS.ErrnoException).code === "ENOENT") continue;
					throw statError;
				}
				let lease: { pid?: number } = {};
				try {
					lease = JSON.parse(fs.readFileSync(leasePath, "utf8"));
				} catch {
					/* A malformed lease from a dead process is reclaimed below. */
				}
				if (typeof lease.pid === "number" && processIsAlive(lease.pid)) {
					throw new Error(`Continuation is already running in process ${lease.pid}.`);
				}
				let after: fs.Stats;
				try {
					after = fs.statSync(leasePath);
				} catch (statError) {
					if ((statError as NodeJS.ErrnoException).code === "ENOENT") continue;
					throw statError;
				}
				if (before.dev === after.dev && before.ino === after.ino) fs.rmSync(leasePath, { force: true });
				continue;
			}
			return () => {
				try {
					const lease = JSON.parse(fs.readFileSync(leasePath, "utf8"));
					if (lease.token === token) {
						fs.rmSync(leasePath, { force: true });
						fsyncDirectory(location.dir);
					}
				} catch {
					/* Already released or replaced. */
				}
			};
		} finally {
			fs.rmSync(temporary, { force: true });
		}
	}
	throw new Error("Could not acquire the continuation lease.");
}

export function removeContinuation(id: string, parentSessionId: string, root = continuationRoot()) {
	// Child transcripts remain durable after parent receipt delivery.
	const location = getContinuationLocation(id, parentSessionId, root);
	fs.rmSync(location.filePath, { force: true });
}

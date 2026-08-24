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
	mode: "single" | "parallel" | "chain";
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
		fs.writeFileSync(fd, `${JSON.stringify(manifest)}\n`, "utf8");
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

export function readContinuationManifest<TArgs = unknown, TDetails = unknown>(
	id: string,
	root = continuationRoot(),
	parentSessionId?: string,
): ContinuationManifest<TArgs, TDetails> | undefined {
	if (!parentSessionId) {
		return listContinuationManifests<TArgs, TDetails>(root)
			.filter((manifest) => manifest.id === id)
			.sort((left, right) => right.updatedAt - left.updatedAt)[0];
	}
	const filePath = getContinuationLocation(id, parentSessionId, root).filePath;
	try {
		const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
		if (parsed?.version !== CONTINUATION_MANIFEST_VERSION || parsed?.id !== id || parsed?.parentSessionId !== parentSessionId) return undefined;
		return parsed as ContinuationManifest<TArgs, TDetails>;
	} catch {
		return undefined;
	}
}

export function listContinuationManifests<TArgs = unknown, TDetails = unknown>(
	root = continuationRoot(),
): Array<ContinuationManifest<TArgs, TDetails>> {
	let names: string[];
	try {
		names = fs.readdirSync(root);
	} catch {
		return [];
	}
	const manifests: Array<ContinuationManifest<TArgs, TDetails>> = [];
	for (const name of names) {
		try {
			const parsed = JSON.parse(fs.readFileSync(path.join(root, name, "manifest.json"), "utf8"));
			if (parsed?.version === CONTINUATION_MANIFEST_VERSION && typeof parsed?.id === "string") {
				manifests.push(parsed as ContinuationManifest<TArgs, TDetails>);
			}
		} catch {
			/* Ignore incomplete or unrelated runtime entries. */
		}
	}
	return manifests;
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
	fs.rmSync(getContinuationLocation(id, parentSessionId, root).dir, { recursive: true, force: true });
}

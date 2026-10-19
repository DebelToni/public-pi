import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const UPSTREAM_SESSION_REFS_ENV = "PI_UPSTREAM_SESSION_REFS";

function expandPath(value: string) {
	if (value === "~") return os.homedir();
	if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
	return value;
}

export function sessionFileId(filePath: string) {
	const descriptor = fs.openSync(filePath, "r");
	try {
		const buffer = Buffer.alloc(64 * 1024);
		const bytes = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
		const firstLine = buffer.subarray(0, bytes).toString("utf8").split("\n", 1)[0];
		const header = JSON.parse(firstLine);
		if (header?.type !== "session" || typeof header.id !== "string") {
			throw new Error(`Invalid Pi session file: ${filePath}`);
		}
		return header.id;
	} finally {
		fs.closeSync(descriptor);
	}
}

export function parseUpstreamSessionRefs(value = process.env[UPSTREAM_SESSION_REFS_ENV]) {
	if (!value) return {} as Record<string, string>;
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		throw new Error(`${UPSTREAM_SESSION_REFS_ENV} is not valid JSON.`);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(`${UPSTREAM_SESSION_REFS_ENV} must contain a session ID to file mapping.`);
	}
	const refs = Object.create(null) as Record<string, string>;
	for (const [sessionId, file] of Object.entries(parsed)) {
		if (typeof file !== "string" || !sessionId) throw new Error(`${UPSTREAM_SESSION_REFS_ENV} contains an invalid session reference.`);
		refs[sessionId] = file;
	}
	return refs;
}

export function resolveSessionReference(reference: string, envValue = process.env[UPSTREAM_SESSION_REFS_ENV]) {
	const requested = reference.trim();
	if (!requested) throw new Error("Session reference cannot be empty.");
	const refs = parseUpstreamSessionRefs(envValue);
	const mapped = Object.hasOwn(refs, requested) ? refs[requested] : undefined;
	const filePath = path.resolve(expandPath(mapped ?? requested));
	let stat: fs.Stats;
	try {
		stat = fs.statSync(filePath);
	} catch {
		throw new Error(mapped ? `Upstream session ${requested} is no longer available.` : `Session file not found: ${filePath}`);
	}
	if (!stat.isFile()) throw new Error(`Session reference is not a file: ${filePath}`);
	const actualId = sessionFileId(filePath);
	if (mapped && actualId !== requested) {
		throw new Error(`Upstream session mapping mismatch: expected ${requested}, found ${actualId}.`);
	}
	return { filePath, sessionId: actualId };
}

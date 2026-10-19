import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { DatabaseSync } from "node:sqlite";
import parser from "stream-json/parser.js";

export const CATALOG_SCHEMA_VERSION = 4;
export const CATALOG_PARSER_VERSION = 3;
const READ_BUFFER_BYTES = 256 * 1024;
const SENTINEL_BYTES = 4096;
const SENTINEL_BASE_BYTES = 1024 * 1024;
const DEFAULT_MISSING_GRACE_MS = 30_000;
const DEFAULT_BATCH_ENTRIES = 250;
const DEFAULT_MAX_TEXT_CHARS = 2 * 1024 * 1024;
const DEFAULT_MAX_TOOL_CHARS = 64 * 1024;
const DEFAULT_MAX_TOOL_META_CHARS = 16 * 1024;
const DEFAULT_MAX_PARTS = 256;
const DEFAULT_MAX_FIRST_MESSAGE_CHARS = 512;
const DEFAULT_MAX_NAME_CHARS = 256;
const LOCK_WAIT_MS = 10_000;
const catalogReleases = new WeakMap();

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const nowMs = () => Date.now();
const hash = () => crypto.createHash("sha256");
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

function asNumber(value, fallback = 0) {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "bigint") return Number(value);
	return fallback;
}

function parseTimestamp(value) {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value !== "string") return undefined;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function iso(value) {
	return new Date(asNumber(value)).toISOString();
}

function normalizeWhitespace(value) {
	return String(value ?? "").replace(/\s+/gu, " ").trim();
}

function throwIfAborted(signal) {
	if (signal?.aborted) throw Object.assign(new Error("session store request aborted"), { name: "AbortError" });
}

function statIdentity(stat) {
	return {
		dev: String(stat.dev),
		ino: String(stat.ino),
		size: Number(stat.size),
		mtimeNs: String(stat.mtimeNs),
		ctimeNs: String(stat.ctimeNs),
		mtimeMs: Number(stat.mtimeNs / 1_000_000n),
	};
}

function sameSnapshot(stat, row) {
	return stat.dev === row.dev && stat.ino === row.ino && stat.size === row.size_bytes &&
		stat.mtimeNs === row.mtime_ns && stat.ctimeNs === row.ctime_ns;
}

function readRange(fd, offset, length) {
	const output = Buffer.allocUnsafe(Math.max(0, length));
	let read = 0;
	while (read < output.length) {
		const count = fs.readSync(fd, output, read, output.length - read, offset + read);
		if (!count) break;
		read += count;
	}
	return output.subarray(0, read);
}

function sentinelOffsets(indexedOffset) {
	const offsets = new Set([0]);
	for (let offset = SENTINEL_BASE_BYTES; offset < indexedOffset; offset *= 2) offsets.add(offset);
	if (indexedOffset > SENTINEL_BYTES) offsets.add(indexedOffset - SENTINEL_BYTES);
	return [...offsets].sort((a, b) => a - b);
}

function buildSentinels(fd, indexedOffset) {
	return sentinelOffsets(indexedOffset).map((offset) => {
		const bytes = readRange(fd, offset, Math.min(SENTINEL_BYTES, indexedOffset - offset));
		return { offset, length: bytes.length, hash: sha256(bytes) };
	});
}

function verifySentinels(fd, raw, indexedOffset) {
	let sentinels;
	try { sentinels = JSON.parse(raw || "[]"); } catch { return false; }
	if (!Array.isArray(sentinels) || !sentinels.length) return indexedOffset === 0;
	return sentinels.every((item) => item && Number.isInteger(item.offset) && Number.isInteger(item.length) &&
		item.offset >= 0 && item.length >= 0 && item.offset + item.length <= indexedOffset &&
		sha256(readRange(fd, item.offset, item.length)) === item.hash);
}

function isWithinRoot(candidate, root) {
	const relative = path.relative(root, candidate);
	return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function safeFileContext(filePath, sourceRoot) {
	const logical = path.resolve(filePath);
	const lstat = fs.lstatSync(logical);
	if (!lstat.isFile() || lstat.isSymbolicLink()) throw new Error(`unsafe session file path: ${logical}`);
	const canonicalPath = fs.realpathSync.native(logical);
	if (!isWithinRoot(canonicalPath, sourceRoot)) throw new Error(`session file escaped source root: ${logical}`);
	return { filePath: logical, canonicalPath };
}

function isSafeRegularFile(filePath, sourceRoot) {
	try { safeFileContext(filePath, sourceRoot); return true; } catch { return false; }
}

export function encodeSessionBucket(cwd) {
	const resolved = path.resolve(cwd);
	return `--${resolved.replace(/^[/\\]/u, "").replace(/[/\\:]/gu, "-")}--`;
}

export function defaultAgentDir() {
	return process.env.PI_AGENT_DIR ? path.resolve(process.env.PI_AGENT_DIR) : path.join(os.homedir(), ".pi", "agent");
}

export function defaultSessionsRoot(agentDir = defaultAgentDir()) {
	return path.join(agentDir, "sessions");
}

function canonicalSourceRoot(root) {
	try { return fs.realpathSync.native(path.resolve(root)); }
	catch { return path.resolve(root); }
}

export function defaultCatalogPath(sessionsRoot = defaultSessionsRoot()) {
	const physical = canonicalSourceRoot(sessionsRoot);
	return path.join(path.dirname(physical), "cache", "session-store.sqlite3");
}

function ensurePrivatePath(databasePath) {
	const directory = path.dirname(databasePath);
	const existed = fs.existsSync(directory);
	fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
	if (!existed) fs.chmodSync(directory, 0o700);
	const fd = fs.openSync(databasePath, "a", 0o600);
	fs.closeSync(fd);
	fs.chmodSync(databasePath, 0o600);
}

function lockOwner(fd) {
	const stat = fs.fstatSync(fd, { bigint: true });
	return { dev: String(stat.dev), ino: String(stat.ino) };
}

function sameLockOwner(lockPath, owner) {
	try {
		const stat = fs.lstatSync(lockPath, { bigint: true });
		return stat.isFile() && !stat.isSymbolicLink() && String(stat.dev) === owner.dev && String(stat.ino) === owner.ino;
	} catch { return false; }
}

function lockIsStale(lockPath) {
	let fd;
	try {
		fd = fs.openSync(lockPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
		const owner = lockOwner(fd), raw = fs.readFileSync(fd, "utf8");
		if (!raw.length) return { stale: false, corrupt: false, transient: true, owner };
		const [pidText, timeText] = raw.split("\n");
		if (!/^[1-9]\d*$/u.test(pidText ?? "") || !/^\d{10,}$/u.test(timeText ?? "")) return { stale: false, corrupt: true, owner };
		const pid = Number(pidText), writtenAt = Number(timeText);
		if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(writtenAt) || writtenAt > nowMs() + 60_000) return { stale: false, corrupt: true, owner };
		let alive = true;
		try { process.kill(pid, 0); } catch (error) { alive = error?.code === "EPERM"; }
		return { stale: !alive && nowMs() - writtenAt > 1000, corrupt: false, owner };
	} catch { return { stale: false }; } finally { if (fd !== undefined) fs.closeSync(fd); }
}

function acquireWriterLock(databasePath, timeoutMs = LOCK_WAIT_MS) {
	const lockPath = `${databasePath}.writer-lock`;
	const reapPath = `${lockPath}.reap`;
	const started = nowMs();
	for (;;) {
		let fd;
		try {
			if (fs.existsSync(reapPath)) {
				const reap = lockIsStale(reapPath);
				if (reap.corrupt) throw new Error(`corrupt writer lock metadata at ${reapPath}; remove it only after confirming no live writer`);
				if (reap.stale && reap.owner && sameLockOwner(reapPath, reap.owner)) fs.unlinkSync(reapPath);
				else throw Object.assign(new Error("lock reap in progress"), { code: "EEXIST" });
			}
			fd = fs.openSync(lockPath, "wx", 0o600);
			const token = crypto.randomBytes(16).toString("hex");
			fs.writeFileSync(fd, `${process.pid}\n${nowMs()}\n${token}\n`);
			const owner = lockOwner(fd);
			return () => {
				try { if (sameLockOwner(lockPath, owner)) fs.unlinkSync(lockPath); }
				finally { fs.closeSync(fd); }
			};
		} catch (error) {
			if (fd !== undefined) try { fs.closeSync(fd); } catch {}
			if (error?.code !== "EEXIST") throw error;
			const observed = lockIsStale(lockPath);
			if (observed.corrupt) throw new Error(`corrupt writer lock metadata at ${lockPath}; remove it only after confirming no live writer`);
			if (observed.stale) {
				let reapFd;
				try {
					reapFd = fs.openSync(reapPath, "wx", 0o600);
					fs.writeFileSync(reapFd, `${process.pid}
${nowMs()}
reaper
`);
					const current = lockIsStale(lockPath);
					if (current.corrupt) throw new Error(`corrupt writer lock metadata at ${lockPath}; remove it only after confirming no live writer`);
					if (current.stale && current.owner && sameLockOwner(lockPath, current.owner)) fs.unlinkSync(lockPath);
				} catch (reapError) { if (reapError?.code !== "EEXIST") throw reapError; }
				finally { if (reapFd !== undefined) { fs.closeSync(reapFd); fs.rmSync(reapPath, { force: true }); } }
				continue;
			}
			if (nowMs() - started >= timeoutMs) throw new Error(`timed out waiting for session-store writer lock: ${lockPath}`);
			sleep(25);
		}
	}
}

function tableColumns(db, table) {
	return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name));
}

function migrateCatalog(db, observed) {
	if (observed !== 2 && observed !== 3) throw new Error(`standalone session store will not migrate schema ${observed}; use the new session-store.sqlite3 path`);
	const files = tableColumns(db, "files"), entries = tableColumns(db, "entries"), parts = tableColumns(db, "parts");
	db.exec("BEGIN EXCLUSIVE");
	try {
		if (!files.has("deferred_tail_bytes")) db.exec("ALTER TABLE files ADD COLUMN deferred_tail_bytes INTEGER NOT NULL DEFAULT 0");
		if (!files.has("first_message_chars")) db.exec("ALTER TABLE files ADD COLUMN first_message_chars INTEGER NOT NULL DEFAULT 0");
		if (!files.has("first_message_truncated")) db.exec("ALTER TABLE files ADD COLUMN first_message_truncated INTEGER NOT NULL DEFAULT 0");
		if (!entries.has("metadata_json")) db.exec("ALTER TABLE entries ADD COLUMN metadata_json TEXT");
		if (!parts.has("image_source_base")) db.exec("ALTER TABLE parts ADD COLUMN image_source_base TEXT");
		if (!parts.has("image_retained_index")) db.exec("ALTER TABLE parts ADD COLUMN image_retained_index INTEGER");
		if (!parts.has("image_content_index")) db.exec("ALTER TABLE parts ADD COLUMN image_content_index INTEGER");
		db.exec(`CREATE TABLE IF NOT EXISTS reconcile_scopes (
  scope_key TEXT PRIMARY KEY, source_root TEXT NOT NULL, scope_type TEXT NOT NULL, complete INTEGER NOT NULL,
  error_json TEXT, reconciled_at_ms INTEGER NOT NULL
) WITHOUT ROWID;`);
		db.prepare("INSERT INTO store_meta(key,value) VALUES('parser_version',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(CATALOG_PARSER_VERSION));
		db.exec(`PRAGMA user_version=${CATALOG_SCHEMA_VERSION}; COMMIT`);
	} catch (error) { db.exec("ROLLBACK"); throw error; }
}

function applySchema(db) {
	const observed = db.prepare("PRAGMA user_version").get().user_version;
	if (observed > CATALOG_SCHEMA_VERSION) throw new Error(`session-store schema ${observed} is newer than supported ${CATALOG_SCHEMA_VERSION}`);
	if (observed === CATALOG_SCHEMA_VERSION) return;
	if (observed !== 0) { migrateCatalog(db, observed); return; }
	db.exec(`
BEGIN EXCLUSIVE;
CREATE TABLE store_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
CREATE TABLE files (
  file_id INTEGER PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  canonical_path TEXT NOT NULL,
  source_root TEXT NOT NULL,
  bucket_path TEXT NOT NULL,
  session_id TEXT,
  cwd TEXT,
  cwd_normalized TEXT,
  name TEXT,
  parent_path TEXT,
  created_ms INTEGER,
  modified_ms INTEGER,
  message_count INTEGER NOT NULL DEFAULT 0,
  first_message TEXT NOT NULL DEFAULT '(no messages)',
  first_message_chars INTEGER NOT NULL DEFAULT 0,
  first_message_truncated INTEGER NOT NULL DEFAULT 0,
  dev TEXT NOT NULL,
  ino TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  mtime_ns TEXT NOT NULL,
  ctime_ns TEXT NOT NULL,
  indexed_offset INTEGER NOT NULL DEFAULT 0,
  deferred_tail_bytes INTEGER NOT NULL DEFAULT 0,
  sentinels_json TEXT NOT NULL DEFAULT '[]',
  parser_version INTEGER NOT NULL,
  active_epoch INTEGER NOT NULL DEFAULT 0,
  active_generation INTEGER NOT NULL DEFAULT 0,
  next_ordinal INTEGER NOT NULL DEFAULT 0,
  indexed_at_ms INTEGER,
  index_status TEXT NOT NULL DEFAULT 'indexing' CHECK(index_status IN ('indexing','fresh','stale','failed')),
  last_error TEXT,
  error_at_ms INTEGER,
  missing_since_ms INTEGER
);
CREATE INDEX files_cwd_modified ON files(cwd_normalized, modified_ms DESC);
CREATE INDEX files_bucket ON files(bucket_path);
CREATE INDEX files_identity ON files(dev, ino);
CREATE TABLE entries (
  entry_pk INTEGER PRIMARY KEY,
  file_id INTEGER NOT NULL REFERENCES files(file_id) ON DELETE CASCADE,
  epoch INTEGER NOT NULL,
  generation INTEGER NOT NULL,
  ordinal INTEGER NOT NULL,
  entry_id TEXT,
  parent_id TEXT,
  type TEXT NOT NULL,
  role TEXT,
  entry_timestamp_ms INTEGER,
  message_timestamp_ms INTEGER,
  byte_start INTEGER NOT NULL,
  byte_end INTEGER NOT NULL,
  source_sha256 TEXT NOT NULL,
  content_chars INTEGER NOT NULL DEFAULT 0,
  stored_chars INTEGER NOT NULL DEFAULT 0,
  content_truncated INTEGER NOT NULL DEFAULT 0,
  metadata_json TEXT,
  UNIQUE(file_id, epoch, ordinal)
);
CREATE INDEX entries_visible ON entries(file_id, epoch, generation, ordinal);
CREATE INDEX entries_id ON entries(file_id, epoch, entry_id, ordinal);
CREATE TABLE entry_content (
  entry_pk INTEGER PRIMARY KEY REFERENCES entries(entry_pk) ON DELETE CASCADE,
  text TEXT NOT NULL
);
CREATE TABLE parts (
  part_pk INTEGER PRIMARY KEY,
  entry_pk INTEGER NOT NULL REFERENCES entries(entry_pk) ON DELETE CASCADE,
  part_index INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('text','toolCall','toolResult','image')),
  search_class TEXT NOT NULL CHECK(search_class IN ('conversation','summary','tool','none')),
  text_start INTEGER,
  text_end INTEGER,
  tool_call_id TEXT,
  tool_name TEXT,
  tool_status TEXT,
  tool_path TEXT,
  is_error INTEGER,
  metadata_json TEXT,
  image_mime TEXT,
  image_sha256 TEXT,
  image_bytes INTEGER,
  image_source_index INTEGER,
  image_source_base TEXT,
  image_retained_index INTEGER,
  image_content_index INTEGER,
  extraction_chars INTEGER NOT NULL DEFAULT 0,
  extraction_truncated INTEGER NOT NULL DEFAULT 0,
  UNIQUE(entry_pk, part_index)
);
CREATE INDEX parts_entry ON parts(entry_pk, part_index);
CREATE TABLE summaries (
  entry_pk INTEGER PRIMARY KEY REFERENCES entries(entry_pk) ON DELETE CASCADE,
  summary_type TEXT NOT NULL,
  text_start INTEGER NOT NULL,
  text_end INTEGER NOT NULL
);
CREATE TABLE reconcile_scopes (
  scope_key TEXT PRIMARY KEY,
  source_root TEXT NOT NULL,
  scope_type TEXT NOT NULL,
  complete INTEGER NOT NULL,
  error_json TEXT,
  reconciled_at_ms INTEGER NOT NULL
) WITHOUT ROWID;
CREATE TABLE file_failures (
  path TEXT PRIMARY KEY,
  source_root TEXT NOT NULL,
  bucket_path TEXT NOT NULL,
  error TEXT NOT NULL,
  observed_at_ms INTEGER NOT NULL,
  dev TEXT,
  ino TEXT,
  size_bytes INTEGER,
  mtime_ns TEXT
) WITHOUT ROWID;
CREATE VIRTUAL TABLE entry_fts USING fts5(
  text,
  content='entry_content',
  content_rowid='entry_pk',
  tokenize="unicode61 remove_diacritics 2 tokenchars '_-'"
);
CREATE TRIGGER entry_content_ai AFTER INSERT ON entry_content BEGIN
  INSERT INTO entry_fts(rowid,text) VALUES(new.entry_pk,new.text);
END;
CREATE TRIGGER entry_content_ad AFTER DELETE ON entry_content BEGIN
  INSERT INTO entry_fts(entry_fts,rowid,text) VALUES('delete',old.entry_pk,old.text);
END;
CREATE TRIGGER entry_content_au AFTER UPDATE OF text ON entry_content BEGIN
  INSERT INTO entry_fts(entry_fts,rowid,text) VALUES('delete',old.entry_pk,old.text);
  INSERT INTO entry_fts(rowid,text) VALUES(new.entry_pk,new.text);
END;
PRAGMA user_version=${CATALOG_SCHEMA_VERSION};
COMMIT;
`);
	db.prepare("INSERT INTO store_meta(key,value) VALUES('parser_version',?)").run(String(CATALOG_PARSER_VERSION));
}

function recoverInterruptedWrites(db) {
	// Drive recovery from file visibility boundaries, not every historical entry.
	db.exec(`DELETE FROM entries WHERE entry_pk IN (
  SELECT e.entry_pk FROM files f CROSS JOIN entries e INDEXED BY entries_visible
  WHERE e.file_id=f.file_id AND e.epoch<f.active_epoch
  UNION ALL
  SELECT e.entry_pk FROM files f CROSS JOIN entries e INDEXED BY entries_visible
  WHERE e.file_id=f.file_id AND e.epoch>f.active_epoch
  UNION ALL
  SELECT e.entry_pk FROM files f CROSS JOIN entries e INDEXED BY entries_visible
  WHERE e.file_id=f.file_id AND e.epoch=f.active_epoch AND e.generation>f.active_generation
)`);
	const timestamp = nowMs();
	db.prepare(`UPDATE files SET index_status=CASE WHEN active_generation>0 THEN 'stale' ELSE 'failed' END,
last_error='interrupted indexing recovered',error_at_ms=? WHERE index_status='indexing'`).run(timestamp);
	db.prepare(`UPDATE files SET index_status=CASE WHEN active_generation>0 THEN 'stale' ELSE 'failed' END,
last_error='parser version requires reconciliation',error_at_ms=? WHERE parser_version<>?`)
		.run(timestamp, CATALOG_PARSER_VERSION);
}

export function openCatalog(databasePath = defaultCatalogPath(), options = {}) {
	const resolved = path.resolve(databasePath);
	const readOnly = Boolean(options.readOnly);
	let release;
	if (!readOnly) {
		ensurePrivatePath(resolved);
		if (!options.lockHeld) release = acquireWriterLock(resolved);
	} else if (!fs.existsSync(resolved)) {
		throw new Error(`session store does not exist: ${resolved}`);
	}
	const db = new DatabaseSync(resolved, { readOnly });
	try {
		db.exec("PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON");
		if (readOnly) {
			db.exec("PRAGMA query_only=ON");
			const version = db.prepare("PRAGMA user_version").get().user_version;
			if (version !== CATALOG_SCHEMA_VERSION) throw new Error(`unsupported session-store schema ${version}`);
		} else {
			applySchema(db);
			recoverInterruptedWrites(db);
			db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL");
			fs.chmodSync(resolved, 0o600);
		}
		if (release) { catalogReleases.set(db, release); release = undefined; }
		return db;
	} catch (error) {
		db.close();
		throw error;
	} finally { release?.(); }
}

export function closeCatalog(db, databasePath) {
	const release = catalogReleases.get(db); catalogReleases.delete(db);
	try { db.close(); } finally { release?.(); }
	if (!databasePath) return;
	for (const suffix of ["", "-wal", "-shm"]) {
		try { fs.chmodSync(`${databasePath}${suffix}`, 0o600); } catch (error) { if (error?.code !== "ENOENT") throw error; }
	}
}

function openReader(databasePath) {
	const db = openCatalog(databasePath, { readOnly: true });
	try { db.exec("BEGIN"); return db; }
	catch (error) { closeCatalog(db); throw error; }
}

function closeReader(db) {
	try { db.exec("ROLLBACK"); } catch {}
	closeCatalog(db);
}

function catalogReaderSourceRoot(db, options, databasePath) {
	if (options.sessionsRoot) return canonicalSourceRoot(options.sessionsRoot);
	const reconciled = db.prepare("SELECT source_root FROM reconcile_scopes WHERE scope_type<>'path' ORDER BY reconciled_at_ms DESC LIMIT 1").get();
	if (reconciled?.source_root) return reconciled.source_root;
	const inferred = path.join(path.dirname(path.dirname(databasePath)), "sessions");
	if (fs.existsSync(inferred)) return canonicalSourceRoot(inferred);
	return canonicalSourceRoot(defaultSessionsRoot());
}

function sourceRootClause(sourceRoot, prefix = "f") {
	return { sql: ` AND ${prefix}.source_root=?`, params: [sourceRoot] };
}

class BoundedText {
	constructor(limit) { this.limit = limit; this.text = ""; this.chars = 0; this.truncated = false; }
	add(value) {
		const text = String(value);
		this.chars += text.length;
		const remaining = this.limit - this.text.length;
		if (remaining > 0) this.text += text.slice(0, remaining);
		if (text.length > remaining) this.truncated = true;
	}
}

class Base64Digest {
	constructor(onBytes) { this.tail = ""; this.digest = hash(); this.bytes = 0; this.invalid = false; this.onBytes = onBytes; }
	consume(text) {
		const bytes = Buffer.from(text, "base64");
		this.onBytes?.(bytes); this.digest.update(bytes); this.bytes += bytes.length;
	}
	add(value) {
		const chunk = String(value);
		if (!/^[A-Za-z0-9+/=]*$/u.test(chunk)) this.invalid = true;
		const text = this.tail + chunk;
		const padding = text.indexOf("=");
		if (padding >= 0) {
			const boundary = padding - (padding % 4);
			if (boundary) this.consume(text.slice(0, boundary));
			this.tail = text.slice(boundary);
			const tailPadding = this.tail.indexOf("=");
			if (!/^={1,2}$/u.test(this.tail.slice(tailPadding)) || tailPadding < 2) this.invalid = true;
			return;
		}
		const usable = text.length - (text.length % 4);
		if (usable) this.consume(text.slice(0, usable));
		this.tail = text.slice(usable);
	}
	end() {
		if (this.tail.includes("=")) {
			if (!/^(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)$/u.test(this.tail)) this.invalid = true;
		} else if (this.tail.length === 1) this.invalid = true;
		if (!this.invalid && this.tail) this.consume(this.tail);
		if (this.invalid) throw new Error("invalid base64 image content");
		return { sha256: this.digest.digest("hex"), bytes: this.bytes };
	}
}

function pathEqual(actual, expected) {
	return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

function contentLocation(pathValue) {
	if (pathValue[0] === "message" && pathValue[1] === "content") {
		return { base: "message", index: typeof pathValue[2] === "number" ? pathValue[2] : 0, rest: pathValue.slice(typeof pathValue[2] === "number" ? 3 : 2) };
	}
	if (pathValue[0] === "content") {
		return { base: "entry", index: typeof pathValue[1] === "number" ? pathValue[1] : 0, rest: pathValue.slice(typeof pathValue[1] === "number" ? 2 : 1) };
	}
	if (pathValue[0] === "retainedTail" && typeof pathValue[1] === "number" && pathValue[2] === "content") {
		return { base: "retainedTail", retainedIndex: pathValue[1], index: typeof pathValue[3] === "number" ? pathValue[3] : 0,
			rest: pathValue.slice(typeof pathValue[3] === "number" ? 4 : 3) };
	}
	return undefined;
}

class BoundedJson {
	constructor(limit) { this.output = new BoundedText(limit); this.stack = []; this.inString = false; }
	get text() { return this.output.text; }
	get chars() { return this.output.chars; }
	get truncated() { return this.output.truncated; }
	get validJson() { return !this.output.truncated; }
	beforeValue() {
		const parent = this.stack.at(-1);
		if (parent?.kind === "array") { if (parent.count++) this.output.add(","); }
	}
	token(token) {
		if (token.name === "startObject" || token.name === "startArray") {
			this.beforeValue(); const object = token.name === "startObject";
			this.output.add(object ? "{" : "["); this.stack.push({ kind: object ? "object" : "array", count: 0 }); return;
		}
		if (token.name === "keyValue") {
			const parent = this.stack.at(-1); if (parent.count++) this.output.add(",");
			this.output.add(`${JSON.stringify(token.value)}:`); return;
		}
		if (token.name === "startString") { this.beforeValue(); this.output.add('"'); this.inString = true; return; }
		if (token.name === "stringChunk") { if (this.inString) this.output.add(JSON.stringify(String(token.value)).slice(1, -1)); return; }
		if (token.name === "endString") { this.output.add('"'); this.inString = false; return; }
		if (["numberValue", "trueValue", "falseValue", "nullValue"].includes(token.name)) {
			this.beforeValue();
			this.output.add(token.name === "numberValue" ? String(token.value) : JSON.stringify(token.value)); return;
		}
		if (token.name === "endObject" || token.name === "endArray") { this.output.add(token.name === "endObject" ? "}" : "]"); this.stack.pop(); }
	}
}

class EntryBuilder {
	constructor(options = {}) {
		this.options = options; this.top = {}; this.message = {}; this.parts = new Map(); this.tails = new Map();
		this.summary = new BoundedText(options.maxTextChars ?? DEFAULT_MAX_TEXT_CHARS);
		this.directContent = new BoundedText(options.maxTextChars ?? DEFAULT_MAX_TEXT_CHARS);
		this.partKeys = new Set(); this.omittedPartKeys = new Set(); this.partsSeen = 0; this.partsOmitted = 0;
		this.discardedPart = { discarded: true };
	}
	newPart(index, source) { return { index, source, type: undefined, text: new BoundedText(this.options.maxTextChars ?? DEFAULT_MAX_TEXT_CHARS),
		args: new BoundedText(this.options.maxToolMetaChars ?? DEFAULT_MAX_TOOL_META_CHARS),
		toolMeta: new BoundedText(this.options.maxToolMetaChars ?? DEFAULT_MAX_TOOL_META_CHARS) }; }
	tail(index) {
		if (!this.tails.has(index)) this.tails.set(index, { index, fields: {}, parts: new Map(), direct: new BoundedText(this.options.maxTextChars ?? DEFAULT_MAX_TEXT_CHARS) });
		return this.tails.get(index);
	}
	part(location) {
		if (typeof location === "number") location = { base: "message", index: location };
		const key = `${location.base}:${location.retainedIndex ?? ""}:${location.index}`;
		const target = location.base === "retainedTail" ? this.tail(location.retainedIndex).parts : this.parts;
		if (target.has(location.index)) return target.get(location.index);
		if (this.omittedPartKeys.has(key)) return this.discardedPart;
		this.partsSeen++;
		if (this.partKeys.size >= (this.options.maxParts ?? DEFAULT_MAX_PARTS)) {
			this.omittedPartKeys.add(key); this.partsOmitted++; return this.discardedPart;
		}
		this.partKeys.add(key);
		const source = { base: location.base, ...(location.retainedIndex === undefined ? {} : { retainedIndex: location.retainedIndex }), contentIndex: location.index };
		const part = this.newPart(location.index, source); target.set(location.index, part); return part;
	}
	jsonCaptureTarget(pathValue) {
		const content = contentLocation(pathValue);
		if (!content || content.rest.length !== 1 || content.rest[0] !== "arguments") return undefined;
		const part = this.part(content); if (part.discarded) return undefined;
		part.args = new BoundedJson(this.options.maxToolMetaChars ?? DEFAULT_MAX_TOOL_META_CHARS); return part.args;
	}
	stringTarget(pathValue) {
		if (pathValue[0] === "retainedTail" && typeof pathValue[1] === "number" && pathValue.length === 3 && pathValue[2] !== "content") {
			const target = new BoundedText(this.options.maxToolMetaChars ?? DEFAULT_MAX_TOOL_META_CHARS);
			target.tailField = { index: pathValue[1], key: pathValue[2] }; return target;
		}
		const content = contentLocation(pathValue);
		if (content) {
			if (content.rest.length === 0) return content.base === "retainedTail" ? this.tail(content.retainedIndex).direct : this.directContent;
			const part = this.part(content), field = content.rest[0];
			if (part.discarded || field === "thinking") return undefined;
			if (field === "text") return part.text;
			if (field === "data") { part.image = new Base64Digest(); return part.image; }
			if (field === "arguments" && content.rest.length === 1) { const target = new BoundedText(this.options.maxToolMetaChars ?? DEFAULT_MAX_TOOL_META_CHARS); target.argumentRoot = part; return target; }
			if (content.rest.includes("arguments")) {
				const target = new BoundedText(this.options.maxToolMetaChars ?? DEFAULT_MAX_TOOL_META_CHARS);
				target.argumentPart = part; target.argumentKey = String(content.rest.at(-1)); return target;
			}
			if (["type", "mimeType", "name", "id"].includes(field) && content.rest.length === 1) {
				const target = new BoundedText(this.options.maxToolMetaChars ?? DEFAULT_MAX_TOOL_META_CHARS); target.scalarPath = pathValue; return target;
			}
		}
		if (pathEqual(pathValue, ["summary"])) return this.summary;
		const topFields = new Set(["type", "id", "parentId", "timestamp", "name", "cwd", "parentSession", "firstKeptEntryId", "fromId"]);
		const messageFields = new Set(["role", "timestamp", "toolCallId", "toolName", "command", "output"]);
		const detailsField = pathValue[0] === "message" && pathValue[1] === "details" && ["path", "fullOutputPath", "status"].includes(pathValue.at(-1));
		if ((pathValue.length === 1 && topFields.has(pathValue[0])) ||
			(pathValue.length === 2 && pathValue[0] === "message" && messageFields.has(pathValue[1])) || detailsField) {
			const limit = pathValue.at(-1) === "output" ? (this.options.maxToolChars ?? DEFAULT_MAX_TOOL_CHARS) : (this.options.maxToolMetaChars ?? DEFAULT_MAX_TOOL_META_CHARS);
			const target = new BoundedText(limit); target.scalarPath = pathValue; return target;
		}
		return undefined;
	}
	setValue(pathValue, value) {
		if (pathValue[0] === "retainedTail" && typeof pathValue[1] === "number" && pathValue.length === 3) {
			this.tail(pathValue[1]).fields[pathValue[2]] = value; return;
		}
		const content = contentLocation(pathValue);
		if (content) {
			if (content.rest.length === 0) return;
			const part = this.part(content), [field] = content.rest;
			if (part.discarded) return;
			if (field === "type") part.type = String(value);
			else if (field === "mimeType") part.mime = String(value);
			else if (field === "name") part.name = String(value);
			else if (field === "id") part.callId = String(value);
			else if (field === "arguments" && content.rest.length === 1) { part.args = new BoundedText(this.options.maxToolMetaChars ?? DEFAULT_MAX_TOOL_META_CHARS); part.args.add(JSON.stringify(value)); }
			else if (content.rest.includes("arguments") && typeof value !== "object") {
				const key = String(content.rest.at(-1)); if (["path", "file", "filePath"].includes(key)) part.path = String(value); if (key === "status") part.status = String(value);
			}
			return;
		}
		if (pathValue.length === 1) this.top[pathValue[0]] = value;
		else if (pathValue[0] === "message" && pathValue.length === 2) this.message[pathValue[1]] = value;
		else if (pathValue[0] === "message" && pathValue[1] === "details") {
			const key = String(pathValue.at(-1)); if (key === "path" || key === "fullOutputPath") this.message.toolPath = String(value); if (key === "status") this.message.toolStatus = String(value);
		}
	}
	finishString(pathValue, target) {
		if (target instanceof Base64Digest || !(target instanceof BoundedText)) return;
		if (target.tailField) this.tail(target.tailField.index).fields[target.tailField.key] = target.text;
		if (target.argumentRoot) {
			target.argumentRoot.args = new BoundedText(this.options.maxToolMetaChars ?? DEFAULT_MAX_TOOL_META_CHARS);
			target.argumentRoot.args.add(JSON.stringify(target.text)); target.argumentRoot.args.truncated ||= target.truncated;
		}
		if (target.argumentPart) {
			const part = target.argumentPart, key = target.argumentKey;
			if (["path", "file", "filePath"].includes(key)) part.path = target.text; if (key === "status") part.status = target.text;
		}
		if (target.scalarPath) {
			this.setValue(target.scalarPath, target.text);
			if (target.scalarPath[0] === "message" && target.scalarPath.at(-1) === "output") { this.message.outputCoverage = target.chars; this.message.outputTruncated = target.truncated; }
			if (target.scalarPath[0] === "message" && target.scalarPath[1] === "details" && target.truncated) this.message.toolMetadataTruncated = true;
		}
	}
	boundedSource(source, limit) {
		if (!source) return source;
		return { text: source.text.slice(0, limit), chars: source.chars,
			truncated: source.truncated || source.chars > limit || source.text.length > limit };
	}
	finalize(descriptor, ordinal, generation, epoch) {
		const type = typeof this.top.type === "string" ? this.top.type : "unknown";
		if (type === "session") return { header: this.top };
		const role = type === "message" ? this.message.role : type === "custom_message" ? "custom" : undefined;
		const outputParts = [], contentPieces = [];
		const addText = (partIndex, kind, searchClass, source, extra = {}) => {
			if (!source?.text) return undefined;
			if (contentPieces.length) contentPieces.push("\n");
			const start = contentPieces.reduce((sum, item) => sum + item.length, 0); contentPieces.push(source.text); const end = start + source.text.length;
			const output = { partIndex, kind, searchClass, textStart: start, textEnd: end, extractionChars: source.chars, extractionTruncated: source.truncated, ...extra };
			outputParts.push(output); return output;
		};
		const emitPart = (part, partIndex, partRole, metadata) => {
			if (part.type === "thinking") return undefined;
			if (part.type === "image") {
				const image = part.image?.end(); if (!image) throw new Error(`image part ${part.index} has no data`);
				const output = { partIndex, kind: "image", searchClass: "none", imageMime: part.mime, imageSha256: image.sha256, imageBytes: image.bytes,
					imageSourceIndex: part.index, imageSource: part.source, extractionChars: 0, extractionTruncated: false, metadata }; outputParts.push(output); return output;
			}
			if (part.type === "toolCall") {
				const extra = { toolName: part.name, toolCallId: part.callId, toolPath: part.path, toolStatus: part.status,
					metadata: { ...metadata, coverage: part.args.chars, truncated: part.args.truncated,
						format: part.args.truncated ? "json-prefix" : "json", validJson: !part.args.truncated } };
				return addText(partIndex, "toolCall", "tool", part.args, extra) ?? (outputParts.push({ partIndex, kind: "toolCall", searchClass: "tool", ...extra,
					extractionChars: part.args.chars, extractionTruncated: part.args.truncated }), outputParts.at(-1));
			}
			const tool = partRole === "toolResult" || partRole === "bashExecution";
			const source = this.boundedSource(part.text, tool ? (this.options.maxToolChars ?? DEFAULT_MAX_TOOL_CHARS) : (this.options.maxTextChars ?? DEFAULT_MAX_TEXT_CHARS));
			return addText(partIndex, tool ? "toolResult" : "text", tool ? "tool" : "conversation", source, {
				toolName: part.name ?? this.message.toolName, toolCallId: part.callId ?? this.message.toolCallId,
				toolStatus: part.status ?? this.message.toolStatus, toolPath: part.path ?? this.message.toolPath,
				isError: this.message.isError === true, metadata: tool ? { ...metadata, coverage: source.chars, truncated: source.truncated } : metadata,
			});
		};
		if (this.directContent.text) {
			const directTool = role === "toolResult" || role === "bashExecution";
			addText(0, directTool ? "toolResult" : "text", type === "custom_message" || role === "user" || role === "assistant" ? "conversation" : "tool",
				this.boundedSource(this.directContent, directTool ? (this.options.maxToolChars ?? DEFAULT_MAX_TOOL_CHARS) : (this.options.maxTextChars ?? DEFAULT_MAX_TEXT_CHARS)));
		}
		for (const part of [...this.parts.values()].sort((x, y) => x.index - y.index)) emitPart(part, part.index, role);
		if ((type === "compaction" || type === "branch_summary") && this.summary.text) addText(0, "text", "summary", this.summary);
		if (type === "message" && role === "bashExecution") {
			const source = new BoundedText(this.options.maxToolChars ?? DEFAULT_MAX_TOOL_CHARS);
			if (typeof this.message.command === "string") source.add(`command=${this.message.command}`);
			if (typeof this.message.output === "string") { source.add(`${source.text ? "\n" : ""}${this.message.output}`); source.chars += Math.max(0, (this.message.outputCoverage ?? this.message.output.length) - this.message.output.length); source.truncated ||= Boolean(this.message.outputTruncated); }
			addText(0, "toolResult", "tool", source, { toolStatus: this.message.cancelled ? "cancelled" : this.message.exitCode === 0 ? "ok" : "error" });
		}
		let retainedPartIndex = outputParts.reduce((maximum, part) => Math.max(maximum, part.partIndex), 0) + 1;
		const retainedOutputs = [];
		for (const tail of [...this.tails.values()].sort((x, y) => x.index - y.index)) {
			const fields = tail.fields, provenance = { provenance: "retainedTail", checkpointEntryId: this.top.id, retainedIndex: tail.index, role: fields.role,
				...(fields.provider !== undefined ? { provider: fields.provider } : {}), ...(fields.model !== undefined ? { model: fields.model } : {}),
				...(fields.api !== undefined ? { api: fields.api } : {}), ...(fields.stopReason !== undefined ? { stopReason: fields.stopReason } : {}),
				...(fields.toolCallId !== undefined ? { toolCallId: fields.toolCallId } : {}), ...(fields.toolName !== undefined ? { toolName: fields.toolName } : {}),
				...(fields.isError !== undefined ? { isError: Boolean(fields.isError) } : {}), ...(fields.timestamp !== undefined ? { timestamp: fields.timestamp } : {}) };
			let emitted = 0;
			if (tail.direct.text) {
				const tailTool = fields.role === "toolResult" || fields.role === "bashExecution";
				const tailSource = this.boundedSource(tail.direct, tailTool ? (this.options.maxToolChars ?? DEFAULT_MAX_TOOL_CHARS) : (this.options.maxTextChars ?? DEFAULT_MAX_TEXT_CHARS));
				const item = addText(retainedPartIndex, tailTool ? "toolResult" : "text",
					fields.role === "user" || fields.role === "assistant" ? "conversation" : tailTool ? "tool" : "none", tailSource,
					{ toolName: fields.toolName, toolCallId: fields.toolCallId, isError: fields.isError === undefined ? undefined : Boolean(fields.isError),
						metadata: { ...provenance, contentIndex: 0 } });
				if (item) { retainedPartIndex++; retainedOutputs.push(item); emitted++; }
			}
			for (const part of [...tail.parts.values()].sort((x, y) => x.index - y.index)) {
				const before = outputParts.length;
				const item = emitPart(part, retainedPartIndex, fields.role, { ...provenance, contentIndex: part.index });
				if (item) {
					if (fields.role === "toolResult") { item.toolName ??= fields.toolName; item.toolCallId ??= fields.toolCallId; item.isError ??= fields.isError === undefined ? undefined : Boolean(fields.isError); }
					retainedPartIndex++; retainedOutputs.push(item); emitted++;
				} else if (outputParts.length !== before) throw new Error("retained part emission invariant failed");
			}
			if (!emitted) { const item = { partIndex: retainedPartIndex++, kind: "text", searchClass: "none", extractionChars: 0, extractionTruncated: false, metadata: provenance }; outputParts.push(item); retainedOutputs.push(item); }
		}
		const text = contentPieces.join("");
		const metadata = {};
		if (typeof this.top.firstKeptEntryId === "string") metadata.firstKeptEntryId = this.top.firstKeptEntryId;
		if (typeof this.top.fromId === "string") metadata.fromId = this.top.fromId;
		if (typeof this.top.tokensBefore === "number") metadata.tokensBefore = this.top.tokensBefore;
		if (this.partsOmitted) metadata.partCoverage = { seen: this.partsSeen, stored: this.partKeys.size, omitted: this.partsOmitted, truncated: true };
		if (this.tails.size) metadata.retainedTail = { messages: this.tails.size, parts: retainedOutputs.length,
			contentChars: retainedOutputs.reduce((sum, item) => sum + item.extractionChars, 0),
			storedChars: retainedOutputs.reduce((sum, item) => sum + (item.textEnd === undefined ? 0 : item.textEnd - item.textStart), 0),
			truncated: retainedOutputs.some((item) => item.extractionTruncated) };
		return { entry: { epoch, generation, ordinal, id: typeof this.top.id === "string" ? this.top.id : null,
			parentId: typeof this.top.parentId === "string" ? this.top.parentId : null, type, role: typeof role === "string" ? role : null,
			entryTimestampMs: parseTimestamp(this.top.timestamp) ?? null, messageTimestampMs: parseTimestamp(this.message.timestamp) ?? null,
			byteStart: descriptor.start, byteEnd: descriptor.end, sourceSha256: descriptor.hash,
			contentChars: outputParts.reduce((sum, item) => sum + item.extractionChars, 0), storedChars: text.length,
			contentTruncated: this.partsOmitted > 0 || outputParts.some((item) => item.extractionTruncated), metadata: Object.keys(metadata).length ? metadata : undefined },
			content: text, parts: outputParts,
			summary: (type === "compaction" || type === "branch_summary") && this.summary.text ? { type, start: 0, end: this.summary.text.length } : undefined,
			metadata: { type, role, name: this.top.name, cwd: this.top.cwd, sessionId: this.top.id, parentSession: this.top.parentSession,
				firstText: outputParts.find((item) => item.searchClass === "conversation") ? text : "" } };
	}
}

class JsonEntryCollector {
	constructor(descriptors, onRecord, options) {
		this.descriptors = descriptors;
		this.onRecord = onRecord;
		this.options = options;
		this.stack = [];
		this.builder = null;
		this.string = null;
		this.ordinal = options.startOrdinal ?? 0;
		this.records = 0;
		this.headers = 0;
		this.jsonCapture = null;
	}
	nextPath() {
		if (!this.stack.length) return [];
		const parent = this.stack.at(-1);
		return parent.kind === "object" ? [...parent.path, parent.key] : [...parent.path, parent.index];
	}
	completeValue() {
		const parent = this.stack.at(-1);
		if (!parent) return;
		if (parent.kind === "object") parent.key = undefined;
		else parent.index++;
	}
	token(token) {
		if (token.name === "startObject" || token.name === "startArray") {
			const pathValue = this.nextPath();
			if (!this.stack.length) this.builder = new EntryBuilder(this.options);
			const target = !this.jsonCapture && this.stack.length ? this.builder.jsonCaptureTarget(pathValue) : undefined;
			this.stack.push({ kind: token.name === "startObject" ? "object" : "array", path: pathValue, key: undefined, index: 0 });
			if (target) this.jsonCapture = { target, rootDepth: this.stack.length };
			this.jsonCapture?.target.token(token); return;
		}
		if (token.name === "keyValue") { this.jsonCapture?.target.token(token); this.stack.at(-1).key = token.value; return; }
		if (token.name === "startString") {
			this.jsonCapture?.target.token(token);
			const pathValue = this.nextPath(); this.string = { path: pathValue, target: this.builder.stringTarget(pathValue) }; return;
		}
		if (token.name === "stringChunk") {
			this.jsonCapture?.target.token(token);
			if (this.string && (this.string.target instanceof Base64Digest || this.string.target instanceof BoundedText)) this.string.target.add(token.value);
			return;
		}
		if (token.name === "endString") {
			this.jsonCapture?.target.token(token);
			if (!this.string) throw new Error("unexpected string terminator");
			if (!(this.string.target instanceof Base64Digest)) this.builder.finishString(this.string.path, this.string.target);
			this.string = null; this.completeValue(); return;
		}
		if (["numberValue", "trueValue", "falseValue", "nullValue"].includes(token.name)) {
			this.jsonCapture?.target.token(token);
			const value = token.name === "numberValue" ? Number(token.value) : token.value;
			this.builder.setValue(this.nextPath(), value); this.completeValue(); return;
		}
		if (token.name === "endObject" || token.name === "endArray") {
			this.jsonCapture?.target.token(token); this.stack.pop();
			if (this.jsonCapture && this.stack.length < this.jsonCapture.rootDepth) this.jsonCapture = null;
			if (!this.stack.length) {
				const descriptor = this.descriptors.shift();
				if (!descriptor) throw new Error("JSON parser produced an entry without a complete JSONL line");
				const record = this.builder.finalize(descriptor, this.ordinal, this.options.generation, this.options.epoch);
				if (record.header) { this.headers++; this.header = record.header; }
				else { this.onRecord(record); this.ordinal++; this.records++; }
				this.builder = null;
			} else this.completeValue();
		}
	}
}

function completedLfOffset(fd, snapshotEnd, floor = 0) {
	let end = snapshotEnd;
	const buffer = Buffer.allocUnsafe(READ_BUFFER_BYTES);
	while (end > floor) {
		const start = Math.max(floor, end - buffer.length);
		const length = end - start;
		const read = fs.readSync(fd, buffer, 0, length, start);
		for (let index = read - 1; index >= 0; index--) if (buffer[index] === 10) return start + index + 1;
		end = start;
	}
	return floor;
}

function hashFdRange(fd, start, end) {
	const digest = hash();
	const buffer = Buffer.allocUnsafe(READ_BUFFER_BYTES);
	let offset = start;
	while (offset < end) {
		const read = fs.readSync(fd, buffer, 0, Math.min(buffer.length, end - offset), offset);
		if (!read) break;
		digest.update(buffer.subarray(0, read)); offset += read;
	}
	if (offset !== end) throw new Error("session source shortened while verifying scan snapshot");
	return digest.digest("hex");
}

function createLineTracker(startOffset, descriptors, state, signal) {
	let offset = startOffset, lineStart = startOffset, lineHash = hash(), lineBytes = 0;
	let started = false, complete = false, inString = false, escaped = false, stack = [], holding = false, heldClose;
	const whitespace = (byte) => byte === 9 || byte === 13 || byte === 32;
	const reset = () => { started = false; complete = false; inString = false; escaped = false; stack = []; };
	const consume = (byte) => {
		if (inString) {
			if (escaped) escaped = false;
			else if (byte === 92) escaped = true;
			else if (byte === 34) inString = false;
			return;
		}
		if (!started) {
			if (whitespace(byte)) return;
			if (byte !== 123) throw new Error(`JSONL line at byte ${lineStart} must contain a top-level JSON object`);
			started = true; stack.push(125); return;
		}
		if (complete) {
			if (!whitespace(byte)) throw new Error(`JSONL line at byte ${lineStart} must contain exactly one JSON object`);
			return;
		}
		if (byte === 34) { inString = true; return; }
		if (byte === 123) stack.push(125);
		else if (byte === 91) stack.push(93);
		else if (byte === 125 || byte === 93) {
			if (stack.pop() !== byte) throw new Error(`mismatched JSON delimiter at byte ${lineStart + lineBytes}`);
			if (!stack.length) complete = true;
		}
	};
	return new Transform({
		transform(chunk, encoding, callback) {
			try {
				throwIfAborted(signal); state.fileHash.update(chunk); state.bytesRead += chunk.length;
				let hashStart = 0, outputStart = 0;
				for (let index = 0; index < chunk.length; index++) {
					const byte = chunk[index];
					if (byte !== 10) {
						const wasComplete = complete; consume(byte); lineBytes++;
						if (!wasComplete && complete && !holding) {
							if (index > outputStart) this.push(chunk.subarray(outputStart, index));
							heldClose = Buffer.from([byte]); outputStart = index + 1; holding = true;
						}
						continue;
					}
					lineHash.update(chunk.subarray(hashStart, index));
					if (started) {
						if (inString || !complete || stack.length) throw new Error(`incomplete JSON object at byte ${lineStart}`);
						descriptors.push({ start: lineStart, end: offset + index, hash: lineHash.digest("hex") });
						state.lines++; state.maxLineBytes = Math.max(state.maxLineBytes, lineBytes);
					}
					if (holding) {
						this.push(heldClose); this.push(Buffer.from([10])); heldClose = undefined; holding = false; outputStart = index + 1;
					}
					lineStart = offset + index + 1; lineHash = hash(); lineBytes = 0; hashStart = index + 1; reset();
				}
				if (hashStart < chunk.length) lineHash.update(chunk.subarray(hashStart));
				if (!holding && outputStart < chunk.length) this.push(chunk.subarray(outputStart));
				offset += chunk.length; callback();
			} catch (error) { callback(error); }
		},
		flush(callback) { callback(); },
	});
}

function validateOpened(filePath, sourceRoot, expectedCanonicalPath, opening) {
	const context = safeFileContext(filePath, sourceRoot);
	if (expectedCanonicalPath && context.canonicalPath !== expectedCanonicalPath) throw new Error("session canonical path changed during scan");
	const current = statIdentity(fs.statSync(filePath, { bigint: true }));
	if (current.dev !== opening.dev || current.ino !== opening.ino) throw new Error("session path no longer references opened source");
}

export async function scanSessionFile(filePath, options = {}) {
	const sourceRoot = fs.realpathSync.native(path.resolve(options.sourceRoot ?? path.dirname(filePath)));
	const expectedCanonicalPath = options.expectedCanonicalPath;
	const startOffset = options.startOffset ?? 0;
	const fd = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
	let opening, snapshotEnd, indexedOffset, openingTailHash;
	try {
		opening = statIdentity(fs.fstatSync(fd, { bigint: true }));
		validateOpened(filePath, sourceRoot, expectedCanonicalPath, opening);
		snapshotEnd = options.endOffset ?? opening.size;
		if (startOffset < 0 || snapshotEnd < startOffset || snapshotEnd > opening.size) throw new Error(`invalid scan range ${startOffset}:${snapshotEnd}`);
		indexedOffset = options.endOffset === undefined ? completedLfOffset(fd, snapshotEnd, startOffset) : snapshotEnd;
		if (options.endOffset !== undefined && indexedOffset > startOffset && readRange(fd, indexedOffset - 1, 1)[0] !== 10) throw new Error("explicit scan end is not a completed LF boundary");
		if (startOffset > 0 && !verifySentinels(fd, options.expectedSentinels, startOffset)) {
			throw Object.assign(new Error("indexed prefix changed before append scan"), { code: "STORE_REBUILD" });
		}
		openingTailHash = hashFdRange(fd, indexedOffset, snapshotEnd);
	} catch (error) { fs.closeSync(fd); throw error; }
	const descriptors = [], state = { bytesRead: 0, lines: 0, maxLineBytes: 0, fileHash: hash() }, records = [];
	let batch = [];
	const flushBatch = () => { if (!batch.length) return; if (options.onBatch) options.onBatch(batch); else records.push(...batch); batch = []; };
	const collector = new JsonEntryCollector(descriptors, (record) => {
		batch.push(record); if (batch.length >= (options.batchEntries ?? DEFAULT_BATCH_ENTRIES)) flushBatch();
	}, options);
	let rangeSha256 = sha256(Buffer.alloc(0));
	try {
		if (indexedOffset > startOffset) {
			const tokenizer = parser.asStream({ jsonStreaming: true, packKeys: true, streamKeys: false,
				packStrings: false, streamStrings: true, packNumbers: true, streamNumbers: false });
			const sink = new Writable({ objectMode: true, write(token, encoding, callback) {
				try { collector.token(token); callback(); } catch (error) { callback(error); }
			} });
			const tracker = createLineTracker(startOffset, descriptors, state, options.signal);
			await pipeline(fs.createReadStream(null, { fd, autoClose: false, start: startOffset, end: indexedOffset - 1,
				highWaterMark: options.readBufferBytes ?? READ_BUFFER_BYTES }), tracker, tokenizer, sink);
			flushBatch();
			if (descriptors.length) throw new Error(`${descriptors.length} complete JSONL lines were not parsed`);
		}
		if (startOffset === 0 && indexedOffset > 0 && collector.headers !== 1) throw new Error(`expected exactly one session header, found ${collector.headers}`);
		if (startOffset > 0 && collector.headers) throw new Error("session header appeared in append region");
		rangeSha256 = state.fileHash.digest("hex");
	} catch (error) {
		try { fs.closeSync(fd); } catch {}
		throw new Error(`invalid session JSONL at ${filePath}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
	}
	let ending, sentinels;
	try {
		ending = statIdentity(fs.fstatSync(fd, { bigint: true }));
		validateOpened(filePath, sourceRoot, expectedCanonicalPath, ending);
		if (ending.dev !== opening.dev || ending.ino !== opening.ino || ending.size < snapshotEnd) throw new Error("session source identity or prefix changed during scan");
		if (!sameSnapshot(ending, { dev: opening.dev, ino: opening.ino, size_bytes: opening.size, mtime_ns: opening.mtimeNs, ctime_ns: opening.ctimeNs })) {
			if (hashFdRange(fd, startOffset, indexedOffset) !== rangeSha256 || hashFdRange(fd, indexedOffset, snapshotEnd) !== openingTailHash) {
				throw new Error("session source prefix changed during scan");
			}
			ending = statIdentity(fs.fstatSync(fd, { bigint: true }));
			if (ending.dev !== opening.dev || ending.ino !== opening.ino || ending.size < snapshotEnd) throw new Error("session source changed during prefix verification");
		}
		sentinels = buildSentinels(fd, indexedOffset);
	} finally { try { fs.closeSync(fd); } catch {} }
	return { opening, ending, indexedOffset, deferredTailBytes: Math.max(0, ending.size - indexedOffset), sentinels, records,
		startOrdinal: options.startOrdinal ?? 0, nextOrdinal: collector.ordinal,
		metrics: { bytesRead: state.bytesRead, lines: state.lines, maxLineBytes: state.maxLineBytes, records: collector.records },
		rangeSha256, header: collector.header };
}

function cwdContains(root, candidate, tree) {
	const normalizedRoot = path.resolve(root), normalizedCandidate = path.resolve(candidate);
	if (!tree) return normalizedCandidate === normalizedRoot;
	const prefix = normalizedRoot.endsWith(path.sep) ? normalizedRoot : `${normalizedRoot}${path.sep}`;
	return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(prefix);
}

function bucketDirectories(logicalRoot, cwd, all, tree) {
	if (!all && !tree) return [path.join(logicalRoot, encodeSessionBucket(cwd))];
	if (!fs.existsSync(logicalRoot)) return [];
	const entries = fs.readdirSync(logicalRoot, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() || entry.isSymbolicLink());
	if (all || path.resolve(cwd) === path.parse(path.resolve(cwd)).root) return entries.map((entry) => path.join(logicalRoot, entry.name));
	const exact = encodeSessionBucket(cwd), descendantPrefix = `${exact.slice(0, -2)}-`;
	return entries.filter((entry) => entry.name === exact || entry.name.startsWith(descendantPrefix))
		.map((entry) => path.join(logicalRoot, entry.name));
}

function sessionHeaderCwd(filePath, maxBytes = 1024 * 1024) {
	let fd;
	try {
		fd = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
		const stat = fs.fstatSync(fd);
		const length = Math.min(Number(stat.size), maxBytes);
		const bytes = readRange(fd, 0, length), lf = bytes.indexOf(10);
		if (lf < 0) return undefined;
		const header = JSON.parse(bytes.subarray(0, lf).toString("utf8"));
		return header?.type === "session" && typeof header.cwd === "string" ? path.resolve(header.cwd) : undefined;
	} catch { return undefined; } finally { if (fd !== undefined) fs.closeSync(fd); }
}

export function discoverSessionFiles({ sessionsRoot = defaultSessionsRoot(), cwd, all = false, tree = false, path: explicitPath } = {}) {
	if (!explicitPath && !all && !cwd) throw new Error("cwd is required unless all=true or path is supplied");
	const logicalRoot = path.resolve(sessionsRoot);
	let sourceRoot;
	try { sourceRoot = fs.realpathSync.native(logicalRoot); } catch { sourceRoot = logicalRoot; }
	const files = [], failures = [], seen = new Set();
	if (!fs.existsSync(logicalRoot)) {
		failures.push({ path: logicalRoot, error: "sessions root does not exist" });
		return { sourceRoot, buckets: [], files, failures, complete: false };
	}
	const addFile = (filePath, bucketPath) => {
		try {
			const context = safeFileContext(filePath, sourceRoot);
			if (seen.has(context.canonicalPath)) return;
			seen.add(context.canonicalPath); files.push({ ...context, sourceRoot, bucketPath });
		} catch (error) { failures.push({ path: filePath, error: error instanceof Error ? error.message : String(error) }); }
	};
	if (explicitPath) {
		const filePath = path.resolve(explicitPath), bucketPath = path.dirname(filePath);
		try {
			const lstat = fs.lstatSync(filePath);
			if (!lstat.isFile() || lstat.isSymbolicLink()) throw new Error(`unsafe session file path: ${filePath}`);
			const canonicalPath = fs.realpathSync.native(filePath);
			const explicitRoot = isWithinRoot(canonicalPath, sourceRoot) ? sourceRoot : path.dirname(canonicalPath);
			const context = safeFileContext(filePath, explicitRoot);
			files.push({ ...context, sourceRoot: explicitRoot, bucketPath });
			return { sourceRoot: explicitRoot, buckets: [bucketPath], files, failures, complete: true };
		} catch (error) {
			// A missing/corrupt explicit source still gets a parent-root failure scope without broadening discovery.
			const parentRoot = canonicalSourceRoot(bucketPath);
			const explicitRoot = isWithinRoot(parentRoot, sourceRoot) ? sourceRoot : parentRoot;
			failures.push({ path: filePath, error: error instanceof Error ? error.message : String(error) });
			return { sourceRoot: explicitRoot, buckets: [bucketPath], files, failures, complete: false };
		}
	}
	let buckets;
	try { buckets = bucketDirectories(logicalRoot, cwd, all, tree); }
	catch (error) { return { sourceRoot, buckets: [], files, failures: [{ path: logicalRoot, error: error.message }], complete: false }; }
	for (const bucketPath of buckets) {
		let canonicalBucket;
		try {
			canonicalBucket = fs.realpathSync.native(bucketPath);
			if (!isWithinRoot(canonicalBucket, sourceRoot) || !fs.statSync(bucketPath).isDirectory()) { failures.push({ path: bucketPath, error: "unsafe session bucket" }); continue; }
		} catch (error) {
			if (error?.code === "ENOENT") continue;
			failures.push({ path: bucketPath, error: error.message }); continue;
		}
		let entries;
		try { entries = fs.readdirSync(bucketPath, { withFileTypes: true }); }
		catch (error) { failures.push({ path: bucketPath, error: error.message }); continue; }
		for (const entry of entries) {
			if (!entry.name.endsWith(".jsonl") || entry.isSymbolicLink()) continue;
			const filePath = path.join(bucketPath, entry.name);
			try {
				const context = safeFileContext(filePath, sourceRoot);
				if (!isWithinRoot(context.canonicalPath, canonicalBucket) || seen.has(context.canonicalPath)) continue;
				if (tree) {
					const headerCwd = sessionHeaderCwd(filePath);
					if (headerCwd && !cwdContains(cwd, headerCwd, true)) continue;
				}
				seen.add(context.canonicalPath); files.push({ ...context, sourceRoot, bucketPath });
			} catch (error) { failures.push({ path: filePath, error: error.message }); }
		}
	}
	files.sort((x, y) => x.filePath.localeCompare(y.filePath));
	return { sourceRoot, buckets, files, failures, complete: failures.length === 0 };
}

function rowForPath(db, filePath) { return db.prepare("SELECT * FROM files WHERE path=?").get(filePath); }

function verifyStoredPrefix(filePath, row) {
	let fd;
	try {
		fd = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
		const stat = statIdentity(fs.fstatSync(fd, { bigint: true }));
		return stat.dev === row.dev && stat.ino === row.ino && stat.size >= row.indexed_offset &&
			verifySentinels(fd, row.sentinels_json, row.indexed_offset);
	} catch { return false; } finally { if (fd !== undefined) fs.closeSync(fd); }
}

function chooseMode(filePath, row, stat) {
	if (!row || row.active_generation === 0 || row.parser_version !== CATALOG_PARSER_VERSION) return { mode: "full", startOffset: 0 };
	if (sameSnapshot(stat, row) && row.index_status === "fresh") {
		// Publish records the final stat, which may include completed lines appended after the scan opened.
		let fd;
		try {
			if (!row.deferred_tail_bytes) return { mode: "unchanged", startOffset: row.indexed_offset };
			fd = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
			if (completedLfOffset(fd, stat.size, row.indexed_offset) === row.indexed_offset) {
				return { mode: "unchanged", startOffset: row.indexed_offset };
			}
		} finally { if (fd !== undefined) fs.closeSync(fd); }
	}
	if (stat.dev === row.dev && stat.ino === row.ino && stat.size > row.indexed_offset && verifyStoredPrefix(filePath, row)) {
		return { mode: "append", startOffset: row.indexed_offset };
	}
	return { mode: "full", startOffset: 0 };
}

function tryRenameByInode(db, context, observedPaths) {
	const stat = statIdentity(fs.statSync(context.filePath, { bigint: true }));
	const candidates = db.prepare("SELECT * FROM files WHERE dev=? AND ino=? AND path<>?").all(stat.dev, stat.ino, context.filePath)
		.filter((row) => !observedPaths.has(row.path) && !isSafeRegularFile(row.path, row.source_root));
	if (candidates.length !== 1) return undefined;
	const row = candidates[0];
	db.prepare("UPDATE files SET path=?,canonical_path=?,source_root=?,bucket_path=?,missing_since_ms=NULL WHERE file_id=?")
		.run(context.filePath, context.canonicalPath, context.sourceRoot, context.bucketPath, row.file_id);
	return rowForPath(db, context.filePath);
}

function createPlaceholder(db, context, stat) {
	const result = db.prepare(`INSERT INTO files(
path,canonical_path,source_root,bucket_path,dev,ino,size_bytes,mtime_ns,ctime_ns,parser_version,index_status
) VALUES(?,?,?,?,?,?,?,?,?,?,'indexing')`).run(context.filePath, context.canonicalPath, context.sourceRoot, context.bucketPath,
		stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, CATALOG_PARSER_VERSION);
	return db.prepare("SELECT * FROM files WHERE file_id=?").get(Number(result.lastInsertRowid));
}

function insertRecordBatch(db, fileId, records) {
	const insertEntry = db.prepare(`INSERT INTO entries(
file_id,epoch,generation,ordinal,entry_id,parent_id,type,role,entry_timestamp_ms,message_timestamp_ms,
byte_start,byte_end,source_sha256,content_chars,stored_chars,content_truncated,metadata_json
) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
	const insertContent = db.prepare("INSERT INTO entry_content(entry_pk,text) VALUES(?,?)");
	const insertPart = db.prepare(`INSERT INTO parts(
entry_pk,part_index,kind,search_class,text_start,text_end,tool_call_id,tool_name,tool_status,tool_path,is_error,
metadata_json,image_mime,image_sha256,image_bytes,image_source_index,image_source_base,image_retained_index,image_content_index,extraction_chars,extraction_truncated
) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
	const insertSummary = db.prepare("INSERT INTO summaries(entry_pk,summary_type,text_start,text_end) VALUES(?,?,?,?)");
	db.exec("BEGIN IMMEDIATE");
	try {
		for (const record of records) {
			const e = record.entry;
			const result = insertEntry.run(fileId, e.epoch, e.generation, e.ordinal, e.id, e.parentId, e.type, e.role,
				e.entryTimestampMs, e.messageTimestampMs, e.byteStart, e.byteEnd, e.sourceSha256,
				e.contentChars, e.storedChars, e.contentTruncated ? 1 : 0, e.metadata ? JSON.stringify(e.metadata) : null);
			const entryPk = Number(result.lastInsertRowid);
			if (record.content) insertContent.run(entryPk, record.content);
			for (const part of record.parts) insertPart.run(entryPk, part.partIndex, part.kind, part.searchClass,
				part.textStart ?? null, part.textEnd ?? null, part.toolCallId ?? null, part.toolName ?? null,
				part.toolStatus ?? null, part.toolPath ?? null, part.isError === undefined ? null : part.isError ? 1 : 0,
				part.metadata ? JSON.stringify(part.metadata) : null, part.imageMime ?? null, part.imageSha256 ?? null,
				part.imageBytes ?? null, part.imageSourceIndex ?? null, part.imageSource?.base ?? null, part.imageSource?.retainedIndex ?? null,
				part.imageSource?.contentIndex ?? part.imageSourceIndex ?? null, part.extractionChars ?? 0, part.extractionTruncated ? 1 : 0);
			if (record.summary) insertSummary.run(entryPk, record.summary.type, record.summary.start, record.summary.end);
		}
		db.exec("COMMIT");
	} catch (error) { db.exec("ROLLBACK"); throw error; }
}

function visibleState(db, fileId, epoch, generation) {
	const entries = db.prepare(`SELECT e.*,c.text FROM entries e LEFT JOIN entry_content c ON c.entry_pk=e.entry_pk
WHERE e.file_id=? AND e.epoch=? AND e.generation<=? ORDER BY e.ordinal`).all(fileId, epoch, generation);
	let name;
	let messageCount = 0;
	let firstMessage, firstMessageChars = 0, firstMessageTruncated = false;
	let lastActivity;
	for (const entry of entries) {
		if (entry.type === "session_info") {
			// Names are top-level fields and are finalized separately by scan metadata.
		}
		if (entry.type === "message") {
			messageCount++;
			if ((entry.role === "user" || entry.role === "assistant") && entry.message_timestamp_ms !== null) {
				lastActivity = Math.max(lastActivity ?? 0, entry.message_timestamp_ms);
			}
			if (!firstMessage && entry.role === "user" && entry.text) {
				const part = db.prepare("SELECT text_start,text_end,extraction_chars,extraction_truncated FROM parts WHERE entry_pk=? AND search_class='conversation' ORDER BY part_index LIMIT 1").get(entry.entry_pk);
				if (part) {
					const full = entry.text.slice(part.text_start, part.text_end);
					firstMessage = full.slice(0, DEFAULT_MAX_FIRST_MESSAGE_CHARS);
					firstMessageChars = part.extraction_chars;
					firstMessageTruncated = Boolean(part.extraction_truncated) || part.extraction_chars > firstMessage.length;
				}
			}
		}
	}
	return { entries, name, messageCount, firstMessage: firstMessage || "(no messages)",
		firstMessageChars: firstMessage ? firstMessageChars : 0, firstMessageTruncated, lastActivity };
}

function discardInvisibleEntries(db, row) {
	if (!row) return;
	db.prepare("DELETE FROM entries WHERE file_id=? AND (epoch<>? OR generation>?)")
		.run(row.file_id, row.active_epoch, row.active_generation);
}

function markFailure(db, context, stat, error, row) {
	discardInvisibleEntries(db, row);
	const message = error instanceof Error ? error.message : String(error);
	const timestamp = nowMs();
	if (row) db.prepare("UPDATE files SET index_status=?,last_error=?,error_at_ms=? WHERE file_id=?")
		.run(row.active_generation ? "stale" : "failed", message, timestamp, row.file_id);
	db.prepare(`INSERT INTO file_failures(path,source_root,bucket_path,error,observed_at_ms,dev,ino,size_bytes,mtime_ns)
VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(path) DO UPDATE SET error=excluded.error,observed_at_ms=excluded.observed_at_ms,
dev=excluded.dev,ino=excluded.ino,size_bytes=excluded.size_bytes,mtime_ns=excluded.mtime_ns`)
		.run(context.filePath, context.sourceRoot, context.bucketPath, message, timestamp,
			stat?.dev ?? null, stat?.ino ?? null, stat?.size ?? null, stat?.mtimeNs ?? null);
}

async function indexOneFile(db, context, observedPaths, options) {
	let row = rowForPath(db, context.filePath);
	let stat;
	try {
		stat = statIdentity(fs.statSync(context.filePath, { bigint: true }));
		row ??= tryRenameByInode(db, context, observedPaths);
	} catch (error) {
		markFailure(db, context, undefined, error, row);
		if (row && error?.code === "ENOENT") db.prepare("UPDATE files SET missing_since_ms=COALESCE(missing_since_ms,?) WHERE file_id=?").run(nowMs(), row.file_id);
		throw error;
	}
	if (!row) row = createPlaceholder(db, context, stat);
	let choice;
	try { choice = options.forceFull ? { mode: "full", startOffset: 0 } : chooseMode(context.filePath, row, stat); }
	catch (error) { markFailure(db, context, stat, error, row); throw error; }
	if (choice.mode === "unchanged") {
		if (row.missing_since_ms !== null) db.prepare("UPDATE files SET missing_since_ms=NULL WHERE file_id=?").run(row.file_id);
		db.prepare("DELETE FROM file_failures WHERE path=?").run(context.filePath);
		return { status: "unchanged", bytesRead: 0, records: 0, deferred: row.deferred_tail_bytes > 0 };
	}
	db.prepare("UPDATE files SET index_status='indexing',last_error=NULL,error_at_ms=NULL WHERE file_id=?").run(row.file_id);
	const epoch = choice.mode === "append" ? row.active_epoch : Math.max(row.active_epoch + 1, 1);
	const generation = choice.mode === "append" ? row.active_generation + 1 : 1;
	const startOrdinal = choice.mode === "append" ? row.next_ordinal : 0;
	db.prepare("DELETE FROM entries WHERE file_id=? AND (epoch<>? OR (epoch=? AND generation>?))")
		.run(row.file_id, row.active_epoch, row.active_epoch, row.active_generation);
	db.prepare("DELETE FROM entries WHERE file_id=? AND epoch=? AND generation=?").run(row.file_id, epoch, generation);
	let scan;
	const seenMetadata = { name: choice.mode === "append" ? row.name : undefined };
	const onBatch = (records) => {
		for (const record of records) {
			if (record.metadata.type === "session_info") seenMetadata.name = typeof record.metadata.name === "string" && record.metadata.name.trim() ? record.metadata.name.trim() : undefined;
		}
		insertRecordBatch(db, row.file_id, records);
	};
	try {
		scan = await scanSessionFile(context.filePath, {
			startOffset: choice.startOffset, startOrdinal, epoch, generation, onBatch,
			expectedSentinels: choice.mode === "append" ? row.sentinels_json : undefined,
			expectedCanonicalPath: context.canonicalPath, sourceRoot: context.sourceRoot,
			batchEntries: options.batchEntries, signal: options.signal,
		});
	} catch (error) {
		if (error?.cause?.code === "STORE_REBUILD" || error?.code === "STORE_REBUILD") {
			return indexOneFile(db, context, observedPaths, { ...options, forceFull: true });
		}
		markFailure(db, context, stat, error, row);
		throw error;
	}
	if (choice.mode === "full" && !scan.header && scan.indexedOffset === 0 && !row.active_generation) {
		discardInvisibleEntries(db, row);
		db.prepare("DELETE FROM files WHERE file_id=?").run(row.file_id);
		db.prepare("DELETE FROM file_failures WHERE path=?").run(context.filePath);
		return { status: "deferred", bytesRead: 0, records: 0, deferred: true, maxLineBytes: 0 };
	}
	const header = choice.mode === "append" ? { id: row.session_id, cwd: row.cwd, timestamp: row.created_ms, parentSession: row.parent_path } : scan.header;
	if (!header || typeof header.id !== "string" || typeof header.cwd !== "string") {
		const error = new Error("invalid session header: id and cwd are required"); markFailure(db, context, stat, error, row); throw error;
	}
	let finalSourceStat;
	let finalFd;
	try {
		finalFd = fs.openSync(context.filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
		finalSourceStat = statIdentity(fs.fstatSync(finalFd, { bigint: true }));
		const sameAsValidatedScan = sameSnapshot(finalSourceStat, { dev: scan.ending.dev, ino: scan.ending.ino, size_bytes: scan.ending.size,
			mtime_ns: scan.ending.mtimeNs, ctime_ns: scan.ending.ctimeNs });
		if (finalSourceStat.dev !== scan.opening.dev || finalSourceStat.ino !== scan.opening.ino || finalSourceStat.size < scan.indexedOffset ||
			!verifySentinels(finalFd, JSON.stringify(scan.sentinels), scan.indexedOffset) ||
			(!sameAsValidatedScan && hashFdRange(finalFd, choice.startOffset, scan.indexedOffset) !== scan.rangeSha256)) {
			throw new Error("session source prefix changed before generation publish");
		}
	} catch (error) { markFailure(db, context, finalSourceStat ?? stat, error, row); throw error; }
	finally { if (finalFd !== undefined) fs.closeSync(finalFd); }
	const deferredTailBytes = Math.max(0, finalSourceStat.size - scan.indexedOffset);
	const state = visibleState(db, row.file_id, epoch, generation);
	const createdMs = parseTimestamp(header.timestamp) ?? stat.mtimeMs;
	const modifiedMs = state.lastActivity ?? createdMs;
	db.exec("BEGIN IMMEDIATE");
	try {
		db.prepare(`UPDATE files SET canonical_path=?,source_root=?,bucket_path=?,session_id=?,cwd=?,cwd_normalized=?,name=?,parent_path=?,
created_ms=?,modified_ms=?,message_count=?,first_message=?,first_message_chars=?,first_message_truncated=?,dev=?,ino=?,size_bytes=?,mtime_ns=?,ctime_ns=?,indexed_offset=?,deferred_tail_bytes=?,
sentinels_json=?,parser_version=?,active_epoch=?,active_generation=?,next_ordinal=?,indexed_at_ms=?,index_status='fresh',last_error=NULL,error_at_ms=NULL,missing_since_ms=NULL
WHERE file_id=?`).run(context.canonicalPath, context.sourceRoot, context.bucketPath, header.id, header.cwd, path.resolve(header.cwd),
			seenMetadata.name ?? null, typeof header.parentSession === "string" ? header.parentSession : null,
			createdMs, modifiedMs, state.messageCount, state.firstMessage, state.firstMessageChars, state.firstMessageTruncated ? 1 : 0, finalSourceStat.dev, finalSourceStat.ino, finalSourceStat.size,
			finalSourceStat.mtimeNs, finalSourceStat.ctimeNs, scan.indexedOffset, deferredTailBytes, JSON.stringify(scan.sentinels), CATALOG_PARSER_VERSION,
			epoch, generation, scan.nextOrdinal, nowMs(), row.file_id);
		db.prepare("DELETE FROM file_failures WHERE path=?").run(context.filePath);
		db.exec("COMMIT");
	} catch (error) { db.exec("ROLLBACK"); markFailure(db, context, stat, error, row); throw error; }
	// Cleanup is deliberately after the visibility flip.
	db.prepare("DELETE FROM entries WHERE file_id=? AND epoch<>?").run(row.file_id, epoch);
	return { status: choice.mode === "append" ? "appended" : row.active_generation ? "rebuilt" : "created",
		bytesRead: scan.metrics.bytesRead, records: scan.metrics.records, maxLineBytes: scan.metrics.maxLineBytes, deferred: deferredTailBytes > 0 };
}

function reconcileMissing(db, discovery, observedPaths, graceMs, options) {
	if (!discovery.complete || options.path) return { marked: [], deleted: [] };
	const timestamp = nowMs();
	let rows;
	if (options.all) rows = db.prepare("SELECT file_id,path,missing_since_ms FROM files WHERE source_root=? AND bucket_path<>source_root").all(discovery.sourceRoot);
	else if (options.tree) {
		const filter = cwdClause(options.cwd, true);
		const selected = db.prepare(`SELECT f.file_id,f.path,f.missing_since_ms FROM files f WHERE 1=1${filter.sql}`).all(...filter.params);
		const byId = new Map(selected.map((row) => [row.file_id, row]));
		for (const bucket of discovery.buckets) for (const row of db.prepare("SELECT file_id,path,missing_since_ms FROM files WHERE bucket_path=? AND cwd_normalized IS NULL").all(bucket)) byId.set(row.file_id, row);
		rows = [...byId.values()];
	} else rows = discovery.buckets.flatMap((bucket) => db.prepare("SELECT file_id,path,missing_since_ms FROM files WHERE bucket_path=?").all(bucket));
	const marked = [], deleted = [];
	for (const row of rows) {
		if (observedPaths.has(row.path) || (!options.tree && isSafeRegularFile(row.path, discovery.sourceRoot))) continue;
		if (row.missing_since_ms === null) {
			db.prepare("UPDATE files SET missing_since_ms=?,index_status='stale',last_error='source file missing',error_at_ms=? WHERE file_id=?")
				.run(timestamp, timestamp, row.file_id); marked.push(row.path);
		} else if (timestamp - row.missing_since_ms >= graceMs) {
			db.prepare("DELETE FROM files WHERE file_id=?").run(row.file_id);
			db.prepare("DELETE FROM file_failures WHERE path=?").run(row.path); deleted.push(row.path);
		}
	}
	return { marked, deleted };
}

function reconciliationScopeKey(options, sourceRoot) {
	if (options.path) return { key: `path:${path.resolve(options.path)}`, type: "path" };
	if (options.all) return { key: `all:${sourceRoot}`, type: "all" };
	if (options.tree) return { key: `tree:${path.resolve(options.cwd)}`, type: "tree" };
	return { key: `cwd:${path.resolve(options.cwd)}`, type: "cwd" };
}

function repairCoveredFailures(db, discovery, observedPaths, options, sessionsRoot, scope) {
	const absentBucketFile = (filePath) => {
		if (options.path || observedPaths.has(filePath)) return false;
		const relative = path.relative(sessionsRoot, filePath);
		const directBucketFile = isWithinRoot(filePath, sessionsRoot) && relative.split(path.sep).length === 2 && filePath.endsWith(".jsonl");
		const bucketName = path.basename(path.dirname(filePath)), exact = options.cwd ? encodeSessionBucket(options.cwd) : undefined;
		const bucketCovered = options.all || bucketName === exact || (options.tree && bucketName.startsWith(`${exact.slice(0, -2)}-`));
		if (!directBucketFile || !bucketCovered) return false;
		try { fs.lstatSync(filePath); return false; }
		catch (error) { return error?.code === "ENOENT"; }
	};
	// A pre-stat failure has no files row for reconcileMissing to retire. Only a successful covering inventory proves absence.
	const unbound = db.prepare(`SELECT ff.path FROM file_failures ff WHERE ff.source_root=?
AND NOT EXISTS (SELECT 1 FROM files f WHERE f.path=ff.path)`).all(discovery.sourceRoot);
	for (const failed of unbound) if (absentBucketFile(failed.path)) db.prepare("DELETE FROM file_failures WHERE path=?").run(failed.path);
	const failedScopes = db.prepare("SELECT scope_key,scope_type FROM reconcile_scopes WHERE source_root=? AND complete=0").all(discovery.sourceRoot);
	for (const failed of failedScopes) {
		let covered = failed.scope_key === scope.key;
		if (!options.path) {
			if (failed.scope_type === "path") {
				const failedPath = failed.scope_key.slice("path:".length);
				covered ||= observedPaths.has(failedPath) || absentBucketFile(failedPath);
			} else if (options.all) covered = true;
			else if (options.tree && (failed.scope_type === "cwd" || failed.scope_type === "tree")) {
				covered ||= cwdContains(options.cwd, failed.scope_key.slice(failed.scope_type.length + 1), true);
			}
		}
		if (covered) db.prepare("DELETE FROM reconcile_scopes WHERE scope_key=?").run(failed.scope_key);
	}
}

export async function reconcileCatalog(options = {}) {
	const started = performance.now(), requestedAt = nowMs();
	const sessionsRoot = path.resolve(options.sessionsRoot ?? defaultSessionsRoot());
	const databasePath = path.resolve(options.databasePath ?? defaultCatalogPath(sessionsRoot));
	ensurePrivatePath(databasePath);
	const release = acquireWriterLock(databasePath, options.lockTimeoutMs);
	let db;
	try {
		throwIfAborted(options.signal);
		const discovery = discoverSessionFiles({ sessionsRoot, cwd: options.cwd, all: options.all, tree: options.tree, path: options.path });
		db = openCatalog(databasePath, { lockHeld: true });
		if (options.path && discovery.failures.length && !discovery.files.length) {
			const filePath = path.resolve(options.path), row = rowForPath(db, filePath);
			if (row) markFailure(db, { filePath, sourceRoot: discovery.sourceRoot, bucketPath: path.dirname(filePath) }, undefined,
				new Error(discovery.failures[0].error), row);
		}
		const observedPaths = new Set(discovery.files.map((item) => item.filePath));
		const totals = { files: discovery.files.length, created: 0, appended: 0, rebuilt: 0, unchanged: 0, deferred: 0,
			failed: discovery.failures.length, bytesRead: 0, entries: 0, maxLineBytes: 0,
			failures: [...discovery.failures], scopeComplete: discovery.complete };
		const scope = reconciliationScopeKey(options, discovery.sourceRoot);
		const prior = db.prepare("SELECT complete,reconciled_at_ms FROM reconcile_scopes WHERE scope_key=? AND source_root=?").get(scope.key, discovery.sourceRoot);
		// Only overlapping, successful equivalent scopes are reusable. Recheck inventory and source identities under the lock.
		// Callbacks, forced rebuilds, and tree discovery keep their full reconciliation behavior.
		if (!options.onFile && !options.forceFull && !options.tree && discovery.complete && prior?.complete && prior.reconciled_at_ms > requestedAt) {
			const rows = options.path ? [rowForPath(db, path.resolve(options.path))].filter(Boolean)
				: options.all ? db.prepare("SELECT * FROM files WHERE source_root=? AND bucket_path<>source_root").all(discovery.sourceRoot)
					: db.prepare("SELECT * FROM files WHERE source_root=? AND bucket_path=?").all(discovery.sourceRoot, path.join(sessionsRoot, encodeSessionBucket(options.cwd)));
			const byFile = new Map(rows.map((row) => [row.path, row]));
			const reusable = rows.length === discovery.files.length && discovery.files.every((context) => {
				const row = byFile.get(context.filePath);
				if (!row || row.index_status !== "fresh" || row.missing_since_ms !== null || row.source_root !== context.sourceRoot || row.canonical_path !== context.canonicalPath) return false;
				try { return chooseMode(context.filePath, row, statIdentity(fs.statSync(context.filePath, { bigint: true }))).mode === "unchanged"; }
				catch { return false; }
			});
			if (reusable) {
				repairCoveredFailures(db, discovery, observedPaths, options, sessionsRoot, scope);
				return { databasePath, sessionsRoot, sourceRoot: discovery.sourceRoot, buckets: discovery.buckets,
					...totals, unchanged: rows.length, deferred: rows.filter((row) => row.deferred_tail_bytes > 0).length,
					coalesced: true, missingMarked: 0, missingDeleted: 0, durationMs: performance.now() - started };
			}
		}
		for (const context of discovery.files) {
			throwIfAborted(options.signal);
			try {
				const result = await indexOneFile(db, context, observedPaths, options);
				totals[result.status]++; if (result.deferred && result.status !== "deferred") totals.deferred++; totals.bytesRead += result.bytesRead; totals.entries += result.records;
				totals.maxLineBytes = Math.max(totals.maxLineBytes, result.maxLineBytes ?? 0);
				options.onFile?.(context.filePath, result);
			} catch (error) {
				totals.failed++; totals.scopeComplete = false;
				totals.failures.push({ path: context.filePath, error: error instanceof Error ? error.message : String(error) });
				options.onFile?.(context.filePath, { status: "failed", error });
			}
		}
		const missing = reconcileMissing(db, discovery, observedPaths, options.missingGraceMs ?? DEFAULT_MISSING_GRACE_MS, options);
		db.prepare("INSERT INTO store_meta(key,value) VALUES('last_reconcile_ms',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(nowMs()));
		db.prepare("INSERT INTO store_meta(key,value) VALUES('last_reconcile_complete',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(totals.scopeComplete ? "1" : "0");
		if (totals.scopeComplete) repairCoveredFailures(db, discovery, observedPaths, options, sessionsRoot, scope);
		db.prepare(`INSERT INTO reconcile_scopes(scope_key,source_root,scope_type,complete,error_json,reconciled_at_ms)
VALUES(?,?,?,?,?,?) ON CONFLICT(scope_key) DO UPDATE SET source_root=excluded.source_root,scope_type=excluded.scope_type,
complete=excluded.complete,error_json=excluded.error_json,reconciled_at_ms=excluded.reconciled_at_ms`)
			.run(scope.key, discovery.sourceRoot, scope.type, totals.scopeComplete ? 1 : 0,
				totals.failures.length ? JSON.stringify(totals.failures) : null, nowMs());
		return { databasePath, sessionsRoot, sourceRoot: discovery.sourceRoot, buckets: discovery.buckets, ...totals,
			missingMarked: missing.marked.length, missingDeleted: missing.deleted.length, durationMs: performance.now() - started };
	} finally { if (db) closeCatalog(db, databasePath); release(); }
}

function cwdClause(cwd, tree = false, prefix = "f") {
	if (!cwd) return { sql: "", params: [] };
	const resolved = path.resolve(cwd);
	if (!tree) return { sql: ` AND ${prefix}.cwd_normalized=?`, params: [resolved] };
	const child = `${resolved.endsWith(path.sep) ? resolved : `${resolved}${path.sep}`}`
		.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
	return { sql: ` AND (${prefix}.cwd_normalized=? OR ${prefix}.cwd_normalized LIKE ? ESCAPE '\\')`, params: [resolved, `${child}%`] };
}

function rowMatchesScope(row, options) {
	if (!options.path && options.catalogSourceRoot && row.source_root !== options.catalogSourceRoot) return false;
	if (options.path) return path.resolve(row.path) === path.resolve(options.path);
	if (!options.cwd) return true;
	if (row.cwd_normalized) return cwdContains(options.cwd, row.cwd_normalized, Boolean(options.tree));
	const exact = encodeSessionBucket(options.cwd), bucket = path.basename(row.bucket_path ?? "");
	return options.tree ? bucket === exact || bucket.startsWith(`${exact.slice(0, -2)}-`) : bucket === exact;
}

function freshnessReceipt(db, options) {
	const fileFailures = db.prepare("SELECT path,cwd_normalized,bucket_path,source_root,index_status,last_error,missing_since_ms FROM files WHERE index_status<>'fresh' OR missing_since_ms IS NOT NULL").all()
		.filter((row) => rowMatchesScope(row, options));
	const unbound = db.prepare(`SELECT ff.path,NULL AS cwd_normalized,ff.bucket_path,ff.source_root,'failed' AS index_status,ff.error AS last_error
FROM file_failures ff WHERE ff.path NOT IN (SELECT path FROM files)`).all().filter((row) => rowMatchesScope(row, options));
	const scopes = db.prepare("SELECT scope_key,scope_type,source_root,error_json FROM reconcile_scopes WHERE complete=0").all().filter((scope) => {
		if (!options.path && options.catalogSourceRoot && scope.source_root !== options.catalogSourceRoot) return false;
		if (options.path) return scope.scope_key === `path:${path.resolve(options.path)}`;
		if (!options.cwd) return true;
		const cwd = path.resolve(options.cwd);
		if (scope.scope_key === `${options.tree ? "tree" : "cwd"}:${cwd}`) return true;
		if (options.tree && scope.scope_type === "cwd") {
			const scopedCwd = scope.scope_key.slice("cwd:".length); return cwdContains(cwd, scopedCwd, true);
		}
		return false;
	});
	const failures = [...fileFailures, ...unbound];
	const staleFiles = fileFailures.filter((row) => row.index_status === "stale" && row.missing_since_ms === null).length;
	const failedFiles = fileFailures.filter((row) => row.index_status === "failed").length + unbound.length;
	const missingFiles = fileFailures.filter((row) => row.missing_since_ms !== null).length;
	const lastReconcileMs = Number(db.prepare("SELECT value FROM store_meta WHERE key='last_reconcile_ms'").get()?.value ?? 0);
	const receipt = {
		freshness: options.path ? "live-source-validated" : "catalog-snapshot",
		receiptAt: new Date().toISOString(),
		...(lastReconcileMs > 0 ? { catalogSnapshotAt: iso(lastReconcileMs) } : {}),
		sourceValidation: options.path ? "exact-path" : "not-performed",
		liveSourceFreshness: options.path ? undefined : false,
		scopeComplete: failures.length === 0 && scopes.length === 0,
		excludedFiles: options.allowStale ? unbound.length + missingFiles : failures.length,
		failureCount: failures.length,
		staleFiles, failedFiles, missingFiles, failedScopes: scopes.length,
	};
	if (options.path && !receipt.scopeComplete) receipt.failures = failures.map((row) => ({ path: row.path, status: row.index_status, error: row.last_error }))
		.concat(scopes.map((scope) => ({ scope: scope.scope_key, error: scope.error_json })));
	return receipt;
}

function validatePartialMode(options) {
	if (!options.allowPartial) return;
	if (options.path) throw new Error("allowPartial is available only for global or cwd list/search scopes");
	if (options.allowStale) throw new Error("allowPartial and allowStale are distinct and cannot be combined");
}

function enforceCoveragePolicy(receipt, options) {
	if (receipt.scopeComplete) { receipt.partialResults = false; return; }
	if (!options.allowPartial && !options.allowStale) {
		const error = new Error(`session store scope is incomplete: ${receipt.failureCount} stale/failed/missing file(s), ${receipt.failedScopes} failed reconciliation scope(s); use allowPartial for fresh rows only or allowStale for diagnostics`);
		error.coverage = receipt; throw error;
	}
	receipt.partialResults = Boolean(options.allowPartial);
}

function requireSearchablePath(db, options) {
	if (!options.path) return undefined;
	const file = fileRowByPath(db, options.path), source = sourceState(file);
	if ((file.index_status !== "fresh" || !source.exact) && !options.allowStale) {
		const error = new Error(`session source snapshot is not fresh: ${file.path}`);
		error.failures = [{ path: file.path, status: file.index_status, error: file.last_error, sourceMatchesSnapshot: source.exact }]; throw error;
	}
	return { file, source };
}

function sinceClause(options, prefix = "f") {
	if (options.sinceHours === undefined) return { sql: "", params: [] };
	const hours = Number(options.sinceHours);
	if (!Number.isFinite(hours) || hours < 0) throw new Error("sinceHours must be a non-negative finite number");
	return { sql: ` AND ${prefix}.modified_ms>=?`, params: [nowMs() - hours * 3600_000] };
}

const PUBLIC_COLUMNS = `f.path,f.session_id,f.cwd,f.name,f.parent_path,f.created_ms,f.modified_ms,f.message_count,f.first_message,f.first_message_chars,f.first_message_truncated,f.index_status`;
function boundedUtf8(value, maxBytes) {
	const text = String(value ?? ""); if (Buffer.byteLength(text) <= maxBytes) return { text, truncated: false };
	let output = "", bytes = 0;
	for (const character of text) { const size = Buffer.byteLength(character); if (bytes + size > maxBytes) break; output += character; bytes += size; }
	return { text: output, truncated: true };
}
function publicSession(row, match = {}, coverage) {
	const name = row.name === null || row.name === undefined ? undefined : boundedUtf8(row.name, DEFAULT_MAX_NAME_CHARS);
	const first = boundedUtf8(row.first_message, DEFAULT_MAX_FIRST_MESSAGE_CHARS);
	return {
		path: row.path, id: row.session_id, cwd: row.cwd ?? "", name: name?.text,
		...(name?.truncated ? { nameTruncated: true } : {}),
		...(row.parent_path ? { parentSessionPath: row.parent_path } : {}),
		created: iso(row.created_ms), modified: iso(row.modified_ms), messageCount: row.message_count, firstMessage: first.text,
		...((Boolean(row.first_message_truncated) || first.truncated) ? { firstMessageTruncated: true, firstMessageChars: row.first_message_chars || String(row.first_message ?? "").length } : {}),
		...(match.excerpt !== undefined ? { excerpt: match.excerpt } : {}),
		...(match.matchedEntryId !== undefined ? { matchedEntryId: match.matchedEntryId } : {}),
		...(match.matchedEntryRef !== undefined ? { matchedEntryRef: match.matchedEntryRef } : {}),
		...(match.matchedRole !== undefined ? { matchedRole: match.matchedRole } : {}),
		...(match.matchKind !== undefined ? { matchKind: match.matchKind } : {}),
		...(match.matchedField !== undefined ? { matchedField: match.matchedField } : {}),
		...(match.matches ? { matches: match.matches } : {}),
		...(coverage ? { coverage: { ...coverage, indexStatus: row.index_status } } : {}),
	};
}

export function listCatalogSessions(options = {}) {
	const databasePath = path.resolve(options.databasePath ?? defaultCatalogPath(options.sessionsRoot));
	const db = openReader(databasePath);
	try {
		validatePartialMode(options);
		const catalogSourceRoot = catalogReaderSourceRoot(db, options, databasePath);
		const scopedOptions = options.path ? options : { ...options, catalogSourceRoot };
		const receipt = freshnessReceipt(db, scopedOptions), filter = cwdClause(options.cwd, options.tree), since = sinceClause(options);
		if (!options.path) enforceCoveragePolicy(receipt, options);
		const selected = requireSearchablePath(db, options);
		if (selected) Object.assign(receipt, { liveSourceFreshness: selected.source.exact, sourceMatchesSnapshot: selected.source.exact });
		const limit = Math.max(1, Math.min(Number(options.limit ?? 1000), 100_000));
		const pathFilter = options.path ? " AND f.path=?" : "";
		const root = options.path ? { sql: "", params: [] } : sourceRootClause(catalogSourceRoot);
		const fresh = options.allowStale ? "" : " AND f.index_status='fresh'";
		const params = [...root.params, ...filter.params, ...(options.path ? [path.resolve(options.path)] : []), ...since.params, limit];
		const rows = db.prepare(`SELECT ${PUBLIC_COLUMNS} FROM files f WHERE f.missing_since_ms IS NULL AND f.active_generation>0${root.sql}${filter.sql}${pathFilter}${since.sql}${fresh}
ORDER BY f.modified_ms DESC,f.path LIMIT ?`).all(...params);
		const results = rows.map((row) => publicSession(row, {}, receipt.scopeComplete ? undefined : receipt));
		if (options.includeText) {
			const text = db.prepare(`SELECT group_concat(c.text,'\n') AS text FROM entries e JOIN files f ON f.file_id=e.file_id
JOIN entry_content c ON c.entry_pk=e.entry_pk JOIN parts p ON p.entry_pk=e.entry_pk
WHERE f.path=? AND e.epoch=f.active_epoch AND e.generation<=f.active_generation AND p.search_class IN ('conversation','summary')`);
			for (const result of results) result.excerpt = (text.get(result.path)?.text ?? "").slice(0, Math.max(0, Number(options.maxChars ?? 64 * 1024)));
		}
		Object.defineProperty(results, "coverage", { value: receipt, enumerable: false });
		return results;
	} finally { closeReader(db); }
}

function ftsTerms(value) { return String(value).match(/[\p{L}\p{N}_-]+/gu) ?? []; }
function ftsQuery(terms) { return terms.length ? terms.map((term) => `"${term.replaceAll('"', '""')}"*`).join(" AND ") : undefined; }
function excerptAround(text, index, length, maxChars = 320) {
	const before = Math.min(100, Math.floor(maxChars / 3)), start = Math.max(0, index - before), end = Math.min(text.length, start + maxChars);
	return `${start ? "… " : ""}${text.slice(start, end)}${end < text.length ? " …" : ""}`;
}

function roleTypeClause(options) {
	const clauses = [], params = [], roles = options.roles ?? (options.role ? [options.role] : []), types = options.types ?? (options.type ? [options.type] : []);
	if (roles.length) { clauses.push(`e.role IN (${roles.map(() => "?").join(",")})`); params.push(...roles); }
	if (types.length) { clauses.push(`e.type IN (${types.map(() => "?").join(",")})`); params.push(...types); }
	return { sql: clauses.length ? ` AND ${clauses.join(" AND ")}` : "", params };
}

function allowedClasses(options) {
	const roles = new Set(options.roles ?? (options.role ? [options.role] : []));
	return options.includeTools || roles.has("toolResult") || roles.has("bashExecution") ? ["conversation", "summary", "tool"] : ["conversation", "summary"];
}

function allowedText(statement, entryPk, fullText, classes) {
	const parts = statement.all(entryPk, ...classes);
	return { parts, text: parts.map((part) => fullText.slice(part.text_start, part.text_end)).join("\n") };
}

const ROLE_BOOST = { user: 1.2, assistantFinal: 1.1, assistantIntermediate: 1, summary: 1, tool: 0.85 };
const MAX_ROLE_BOOST = ROLE_BOOST.user;
function boostedRank(rank, boost) { return rank <= 0 ? rank * boost : rank / boost; }

function foldUnicode61(value) {
	return String(value ?? "").normalize("NFD").replace(/\p{M}+/gu, "").toLowerCase();
}

function textMatch(text, query, mode, terms, regex) {
	if (mode === "phrase") {
		const haystack = normalizeWhitespace(text).toLowerCase(), needle = normalizeWhitespace(query).toLowerCase(), index = haystack.indexOf(needle);
		return index < 0 ? undefined : { index, length: needle.length, display: text };
	}
	if (mode === "regex") { regex.lastIndex = 0; const match = regex.exec(text); return match ? { index: match.index ?? 0, length: match[0]?.length ?? 0, display: text } : undefined; }
	const folded = foldUnicode61(text), foldedTerms = terms.map(foldUnicode61), positions = foldedTerms.map((term) => folded.indexOf(term));
	if (positions.some((position) => position < 0)) return undefined;
	const index = Math.min(...positions); return { index, length: foldedTerms[positions.indexOf(index)]?.length ?? 0, display: text };
}

function metadataFieldMatch(value, query, mode, terms, regex) {
	const text = String(value ?? ""); if (!text) return undefined;
	if (mode === "regex") { regex.lastIndex = 0; const match = regex.exec(text); return match ? { index: match.index ?? 0, length: match[0]?.length ?? 0, display: text } : undefined; }
	if (mode === "phrase") {
		const index = normalizeWhitespace(text).toLowerCase().indexOf(normalizeWhitespace(query).toLowerCase());
		return index < 0 ? undefined : { index, length: String(query).length, display: text };
	}
	const tokens = ftsTerms(foldUnicode61(text)), foldedTerms = terms.map(foldUnicode61);
	if (!foldedTerms.every((term) => tokens.some((token) => token.startsWith(term)))) return undefined;
	const index = Math.max(0, foldUnicode61(text).indexOf(foldedTerms[0] ?? ""));
	return { index, length: foldedTerms[0]?.length ?? 0, display: text };
}

function fuzzyNameMatch(value, query, terms) {
	const text = String(value ?? ""), folded = foldUnicode61(text), needle = foldUnicode61(normalizeWhitespace(query));
	if (!folded || !terms.length) return undefined;
	const direct = folded.indexOf(needle);
	if (direct >= 0) return { index: direct, length: needle.length, display: text, tier: 0 };
	const foldedTerms = terms.map(foldUnicode61);
	if (foldedTerms.every((term) => folded.includes(term))) return { index: 0, length: text.length, display: text, tier: 1 };
	for (const term of foldedTerms) {
		let position = 0;
		for (const character of term) {
			const index = folded.indexOf(character, position);
			if (index < 0) return undefined;
			position = index + character.length;
		}
	}
	return { index: 0, length: text.length, display: text, tier: 2 };
}

function searchBranchCte(db, file, leafValue, byteStart, leafLocator) {
	const locator = normalizeEntryLocator(leafValue, byteStart, leafLocator);
	const visible = locator ? db.prepare(`SELECT entry_pk,entry_id,ordinal,byte_start,byte_end,source_sha256 FROM entries
WHERE file_id=? AND epoch=? AND generation<=?${locator?.id !== undefined ? " AND entry_id=?" : ""}${locator?.byteStart !== undefined ? " AND byte_start=?" : ""}
ORDER BY ordinal`).all(file.file_id, file.active_epoch, file.active_generation,
		...(locator?.id !== undefined ? [locator.id] : []), ...(locator?.byteStart !== undefined ? [locator.byteStart] : [])) : [];
	let leaf;
	if (locator) leaf = resolveEntryRow(selectEntryRows(visible, locator), locator, "leaf");
	else leaf = db.prepare(`SELECT entry_pk,entry_id,ordinal,byte_start,byte_end,source_sha256 FROM entries
WHERE file_id=? AND epoch=? AND generation<=? ORDER BY ordinal DESC LIMIT 1`).get(file.file_id, file.active_epoch, file.active_generation);
	if (!leaf) return { sql: "", params: [], empty: true, selection: locator ? "explicit-leaf-ancestry" : "latest-persisted-ancestry-not-live" };
	return {
		sql: `WITH RECURSIVE branch(entry_pk,parent_id,ordinal) AS (
  SELECT entry_pk,parent_id,ordinal FROM entries WHERE entry_pk=?
  UNION ALL
  SELECT p.entry_pk,p.parent_id,p.ordinal FROM branch child CROSS JOIN entries p INDEXED BY entries_id ON p.entry_id=child.parent_id
  WHERE p.file_id=? AND p.epoch=? AND p.generation<=? AND p.ordinal=(
    SELECT MAX(p2.ordinal) FROM entries p2 WHERE p2.file_id=? AND p2.epoch=? AND p2.generation<=?
      AND p2.entry_id=child.parent_id AND p2.ordinal<child.ordinal)
) `,
		params: [leaf.entry_pk, file.file_id, file.active_epoch, file.active_generation, file.file_id, file.active_epoch, file.active_generation],
		where: " AND e.entry_pk IN (SELECT entry_pk FROM branch)", empty: false,
		selection: locator ? "explicit-leaf-ancestry" : "latest-persisted-ancestry-not-live", leafRef: entryRef(leaf),
	};
}

export function searchCatalog(query, options = {}) {
	const databasePath = path.resolve(options.databasePath ?? defaultCatalogPath(options.sessionsRoot)), db = openReader(databasePath), started = globalThis.performance.now();
	const metrics = { candidateRowsScanned: 0, contentRowsFetched: 0, candidatesVerified: 0, metadataRowsScanned: 0, earlyStopped: false };
	try {
		validatePartialMode(options);
		if ((options.leaf || options.leafLocator || options.byteStart !== undefined) && !options.path) throw new Error("search leaf requires an explicit path");
		const catalogSourceRoot = catalogReaderSourceRoot(db, options, databasePath);
		const scopedOptions = options.path ? options : { ...options, catalogSourceRoot };
		const receipt = freshnessReceipt(db, scopedOptions); if (!options.path) enforceCoveragePolicy(receipt, options);
		const selectedPath = requireSearchablePath(db, options), file = selectedPath?.file;
		if (selectedPath) Object.assign(receipt, { liveSourceFreshness: selectedPath.source.exact, sourceMatchesSnapshot: selectedPath.source.exact });
		const mode = options.mode ?? "bm25";
		if (!["bm25", "phrase", "regex"].includes(mode)) throw new Error(`unknown search mode: ${mode}`);
		const terms = ftsTerms(query), compiled = ftsQuery(terms);
		const branch = file ? searchBranchCte(db, file, options.leaf, options.leafByteStart ?? options.byteStart, options.leafLocator)
			: { sql: "", params: [], where: "", empty: false, selection: "all-visible-entries" };
		const coverage = { ...receipt, branchSelection: branch.selection, ...(branch.leafRef ? { leafRef: branch.leafRef } : {}) };
		const emptyResponse = () => ({ mode, query, results: [], coverage, performance: metrics, durationMs: globalThis.performance.now() - started });
		if (branch.empty || (mode === "bm25" && !compiled)) return emptyResponse();
		let regex;
		if (mode === "regex") try { regex = new RegExp(query, "iu"); } catch (error) { throw new Error(`invalid regex: ${error.message}`); }
		if ((mode === "phrase" || mode === "regex") && !String(query)) return emptyResponse();
		const filter = cwdClause(options.cwd, options.tree), since = sinceClause(options), rt = roleTypeClause(options), classes = allowedClasses(options);
		const named = options.namedOnly ? " AND f.name IS NOT NULL AND trim(f.name)<>''" : "";
		const root = file ? { sql: "", params: [] } : sourceRootClause(catalogSourceRoot);
		const pathFilter = file ? " AND f.file_id=?" : "", fresh = options.allowStale ? "" : " AND f.index_status='fresh'";
		const classPlaceholders = classes.map(() => "?").join(",");
		const permitted = ` AND EXISTS (SELECT 1 FROM parts permitted WHERE permitted.entry_pk=e.entry_pk
  AND permitted.search_class IN (${classPlaceholders}) AND permitted.text_start IS NOT NULL)`;
		const allowedStatement = db.prepare(`SELECT text_start,text_end,search_class FROM parts WHERE entry_pk=? AND search_class IN (${classPlaceholders}) AND text_start IS NOT NULL ORDER BY part_index`);
		const assistantToolCallStatement = db.prepare("SELECT 1 FROM parts WHERE entry_pk=? AND kind='toolCall' LIMIT 1");
		const contentStatement = db.prepare("SELECT text FROM entry_content WHERE entry_pk=?");
		const fileStatement = db.prepare(`SELECT ${PUBLIC_COLUMNS} FROM files f WHERE f.file_id=?`), fileRows = new Map();
		const commonParams = [...root.params, ...filter.params, ...(file ? [file.file_id] : []), ...since.params, ...rt.params];
		const matchLimit = Math.max(1, Math.min(Number(options.matchLimit ?? 1), 50));
		const limit = Math.max(1, Math.min(Number(options.limit ?? 50), 1000));
		const byPath = new Map();
		const titleFirst = options.titleFirst && mode === "bm25";
		const titleTier = (item) => titleFirst ? item.titleTier ?? 3 : 0;
		const itemOrdinal = (item) => item.ordinal ?? item.row.ordinal ?? -1;
		const comparePath = (left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right));
		const compareRelevance = (left, right) => titleTier(left) - titleTier(right) || left.rank - right.rank || right.row.modified_ms - left.row.modified_ms ||
			comparePath(left.row.path, right.row.path) || itemOrdinal(left) - itemOrdinal(right);
		const compareRecent = (left, right) => titleTier(left) - titleTier(right) || right.row.modified_ms - left.row.modified_ms || comparePath(left.row.path, right.row.path) ||
			itemOrdinal(left) - itemOrdinal(right);
		const addMatch = (item) => {
			const existing = byPath.get(item.row.path);
			if (!existing) { byPath.set(item.row.path, { best: item, matches: [item] }); return; }
			existing.matches.push(item);
			existing.matches.sort(compareRelevance);
			if (existing.matches.length > matchLimit) existing.matches.pop();
			existing.best = existing.matches[0];
		};
		const roles = options.roles ?? (options.role ? [options.role] : []), types = options.types ?? (options.type ? [options.type] : []);
		const maxRoleBoost = roles.length && roles.every((role) => role === "assistant") ? ROLE_BOOST.assistantFinal
			: roles.length && roles.every((role) => role === "toolResult" || role === "bashExecution") ? ROLE_BOOST.tool : MAX_ROLE_BOOST;
		if (!file && options.metadata !== false && !roles.length && !types.length) {
			const metadataRows = db.prepare(`SELECT ${PUBLIC_COLUMNS} FROM files f
WHERE f.missing_since_ms IS NULL AND f.active_generation>0${root.sql}${fresh}${filter.sql}${since.sql}${named}
ORDER BY f.modified_ms DESC,f.path`).iterate(...root.params, ...filter.params, ...since.params);
			const fields = [["name", 0], ["id", 1], ["cwd", 2]];
			for (const row of metadataRows) {
				metrics.metadataRowsScanned++;
				const values = { name: row.name, id: row.session_id, cwd: row.cwd }; let selected;
				for (const [field, priority] of fields) {
					const match = titleFirst && field === "name" ? fuzzyNameMatch(values[field], query, terms)
						: metadataFieldMatch(values[field], query, mode, terms, regex);
					if (match) { selected = { field, priority, match }; break; }
				}
				if (!selected) continue;
				addMatch({ excerpt: excerptAround(selected.match.display, selected.match.index, selected.match.length, Number(options.maxExcerptChars ?? 320)),
					matchKind: "metadata", matchedField: selected.field, titleTier: selected.match.tier,
					rank: mode === "bm25" ? -1000 + selected.priority : 0,
					ordinal: Number.MAX_SAFE_INTEGER, row });
			}
		}
		// Bound one FTS scan by the ancestry rowid envelope; rowid IN would restart MATCH per ancestor.
		const ftsBounds = file ? " AND entry_fts.rowid>=(SELECT MIN(entry_pk) FROM branch) AND entry_fts.rowid<=(SELECT MAX(entry_pk) FROM branch)" : "";
		let rows;
		if (mode === "bm25") rows = db.prepare(`${branch.sql}SELECT e.entry_pk,e.file_id,e.entry_id,e.ordinal,e.byte_start,e.byte_end,e.source_sha256,e.role,f.path,f.modified_ms,bm25(entry_fts) AS rank
FROM entry_fts CROSS JOIN entries e ON e.entry_pk=entry_fts.rowid JOIN files f ON f.file_id=e.file_id
WHERE entry_fts MATCH ? AND e.epoch=f.active_epoch AND e.generation<=f.active_generation AND f.missing_since_ms IS NULL${root.sql}${fresh}${filter.sql}${pathFilter}${since.sql}${named}${rt.sql}${branch.where ?? ""}${ftsBounds}${permitted}
ORDER BY rank ASC,f.modified_ms DESC,f.path ASC,e.ordinal ASC`).iterate(...branch.params, compiled, ...commonParams, ...classes);
		else rows = db.prepare(`${branch.sql}SELECT ${PUBLIC_COLUMNS},e.entry_pk,e.entry_id,e.ordinal,e.byte_start,e.byte_end,e.source_sha256,e.role,c.text,0 AS rank
FROM entries e JOIN entry_content c ON c.entry_pk=e.entry_pk JOIN files f ON f.file_id=e.file_id
WHERE e.epoch=f.active_epoch AND e.generation<=f.active_generation AND f.missing_since_ms IS NULL${root.sql}${fresh}${filter.sql}${pathFilter}${since.sql}${named}${rt.sql}${branch.where ?? ""}${permitted}
ORDER BY f.modified_ms DESC,f.path ASC,e.ordinal ASC`).iterate(...branch.params, ...commonParams, ...classes);
		const boundedEnumeration = mode === "bm25" && (options.sort === undefined || options.sort === "relevance") && !options.exhaustive;
		const resultLimit = file ? 1 : limit;
		for (const row of rows) {
			metrics.candidateRowsScanned++;
			if (boundedEnumeration && byPath.size >= resultLimit) {
				const current = [...byPath.values()].sort((left, right) => compareRelevance(left.best, right.best));
				// FTS rows arrive in raw-rank and tie-break order. Bound the best possible later role boost.
				const optimistic = { rank: boostedRank(row.rank, maxRoleBoost), ordinal: row.ordinal, row };
				const retained = current.slice(0, resultLimit);
				if (compareRelevance(optimistic, retained.at(-1).best) >= 0) {
					// Result membership is settled, but every returned group's additional matches must also be settled.
					if (retained.every((group) => group.matches.length === matchLimit &&
						compareRelevance(optimistic, group.matches.at(-1)) >= 0)) { metrics.earlyStopped = true; break; }
					const group = byPath.get(row.path);
					if (!retained.includes(group) || (group.matches.length === matchLimit &&
						compareRelevance(optimistic, group.matches.at(-1)) >= 0)) continue;
				}
			}
			let fullText;
			if (mode === "bm25") { fullText = contentStatement.get(row.entry_pk)?.text ?? ""; metrics.contentRowsFetched++; }
			else { fullText = row.text; metrics.contentRowsFetched++; }
			const allowed = allowedText(allowedStatement, row.entry_pk, fullText, classes); if (!allowed.text) continue;
			metrics.candidatesVerified++;
			const match = textMatch(allowed.text, query, mode, terms, regex); if (!match) continue;
			const matchedPart = allowed.parts.find((part) => textMatch(fullText.slice(part.text_start, part.text_end), query, mode, terms, regex));
			const searchClass = matchedPart?.search_class ?? (allowed.parts.some((part) => part.search_class === "tool") ? "tool"
				: allowed.parts.some((part) => part.search_class === "summary") ? "summary" : "conversation");
			const boost = searchClass === "tool" ? ROLE_BOOST.tool : searchClass === "summary" ? ROLE_BOOST.summary
				: row.role === "user" ? ROLE_BOOST.user : row.role === "assistant"
					? (assistantToolCallStatement.get(row.entry_pk) ? ROLE_BOOST.assistantIntermediate : ROLE_BOOST.assistantFinal)
					: ROLE_BOOST.assistantIntermediate;
			let retainedRow;
			if (mode === "bm25") {
				let publicRow = fileRows.get(row.file_id);
				if (!publicRow) { publicRow = fileStatement.get(row.file_id); fileRows.set(row.file_id, publicRow); }
				retainedRow = { ...publicRow, entry_pk: row.entry_pk, entry_id: row.entry_id, ordinal: row.ordinal, byte_start: row.byte_start,
					byte_end: row.byte_end, source_sha256: row.source_sha256, role: row.role, rank: boostedRank(row.rank, boost) };
			} else { const { text: discardedText, ...rest } = row; retainedRow = rest; }
			addMatch({ excerpt: excerptAround(match.display, match.index, match.length, Number(options.maxExcerptChars ?? 320)),
				matchedEntryId: row.entry_id ?? `byte:${row.byte_start}`, matchedEntryRef: entryRef(row), matchedRole: row.role ?? undefined,
				matchKind: "entry", rank: boostedRank(row.rank, boost), ordinal: row.ordinal, row: retainedRow });
		}
		const grouped = [...byPath.values()];
		grouped.sort((left, right) => options.sort === "recent" ? compareRecent(left.best, right.best) : compareRelevance(left.best, right.best));
		const results = grouped.slice(0, limit).map(({ best, matches }) => publicSession(best.row, {
			excerpt: best.excerpt, matchedEntryId: best.matchedEntryId, matchedEntryRef: best.matchedEntryRef, matchedRole: best.matchedRole,
			matchKind: best.matchKind, matchedField: best.matchedField,
			matches: matchLimit > 1 ? matches.sort(compareRelevance).slice(0, matchLimit).map(({ excerpt, matchedEntryId, matchedEntryRef, matchedRole, matchKind, matchedField }) => ({
				excerpt, ...(matchedEntryId !== undefined ? { matchedEntryId } : {}), ...(matchedEntryRef !== undefined ? { matchedEntryRef } : {}),
				...(matchedRole !== undefined ? { matchedRole } : {}), matchKind, ...(matchedField !== undefined ? { matchedField } : {}),
			})) : undefined,
		}, coverage));
		return { mode, query, results, coverage, performance: metrics, durationMs: globalThis.performance.now() - started };
	} finally { closeReader(db); }
}

function fileRowByPath(db, filePath) {
	const row = db.prepare("SELECT * FROM files WHERE path=? AND missing_since_ms IS NULL AND active_generation>0").get(path.resolve(filePath));
	if (!row) throw new Error(`session is not indexed: ${path.resolve(filePath)}`);
	return row;
}

function entryRef(row) {
	return { id: row.entry_id ?? null, ordinal: row.ordinal, byteStart: row.byte_start, byteEnd: row.byte_end, sourceSha256: row.source_sha256 };
}

function normalizeEntryLocator(value, byteStart, locator) {
	let selected = locator ?? value, id;
	const output = {};
	if (selected && typeof selected === "object") Object.assign(output, selected);
	else if (typeof selected === "string" && /^byte:\d+$/u.test(selected)) output.byteStart = Number(selected.slice(5));
	else if (typeof selected === "string") id = selected;
	if (id !== undefined && output.id === undefined) output.id = id;
	if (byteStart !== undefined) output.byteStart = Number(byteStart);
	if (output.byteStart !== undefined && (!Number.isSafeInteger(output.byteStart) || output.byteStart < 0)) throw new Error("entry byteStart must be a non-negative safe integer");
	if (output.ordinal !== undefined && (!Number.isSafeInteger(Number(output.ordinal)) || Number(output.ordinal) < 0)) throw new Error("entry ordinal must be a non-negative safe integer");
	return Object.keys(output).length ? output : undefined;
}

function selectEntryRows(rows, locator) {
	if (!locator) return rows;
	return rows.filter((row) => (locator.id === undefined || row.entry_id === locator.id) &&
		(locator.byteStart === undefined || row.byte_start === locator.byteStart) &&
		(locator.ordinal === undefined || row.ordinal === Number(locator.ordinal)) &&
		(locator.sourceSha256 === undefined || row.source_sha256 === locator.sourceSha256));
}

function resolveEntryRow(rows, locator, label) {
	const matches = selectEntryRows(rows, locator);
	if (!matches.length) throw new Error(`${label} not found`);
	if (matches.length > 1) throw new Error(`ambiguous ${label}; supply byteStart or an exact entry locator`);
	return matches[0];
}

function sourceState(row) {
	let fd;
	try {
		if (!isSafeRegularFile(row.path, row.source_root)) return { prefix: false, exact: false };
		fd = fs.openSync(row.path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
		const stat = statIdentity(fs.fstatSync(fd, { bigint: true }));
		const prefix = stat.dev === row.dev && stat.ino === row.ino && stat.size >= row.indexed_offset &&
			verifySentinels(fd, row.sentinels_json, row.indexed_offset);
		return { prefix, exact: prefix && sameSnapshot(stat, row) };
	} catch { return { prefix: false, exact: false }; } finally { if (fd !== undefined) fs.closeSync(fd); }
}
function sourceMatchesRow(row) { return sourceState(row).prefix; }

const READ_ENTRY_METADATA_BYTES = 64 * 1024;
const READ_RESPONSE_METADATA_BYTES = 128 * 1024;
const READ_ENTRY_PARTS = 256;
const jsonBytes = (value) => Buffer.byteLength(JSON.stringify(value));

function branchData(rows) {
	const byId = new Map(), byPk = new Map(), parentByPk = new Map(), children = new Map();
	for (const row of rows) {
		byPk.set(row.entry_pk, row);
		if (row.entry_id) { if (!byId.has(row.entry_id)) byId.set(row.entry_id, []); byId.get(row.entry_id).push(row); }
		if (row.parent_id) {
			const parent = [...(byId.get(row.parent_id) ?? [])].reverse().find((candidate) => candidate.ordinal < row.ordinal);
			if (parent) {
				parentByPk.set(row.entry_pk, parent.entry_pk);
				if (!children.has(parent.entry_pk)) children.set(parent.entry_pk, []);
				children.get(parent.entry_pk).push(row);
			}
		}
	}
	return { byId, byPk, parentByPk, children };
}

function ancestryFor(leaf, graph) {
	const branch = [], seen = new Set(); let current = leaf;
	while (current) {
		if (seen.has(current.entry_pk)) throw new Error(`entry ancestry cycle at ${current.entry_id ?? current.entry_pk}`);
		seen.add(current.entry_pk); branch.push(current);
		current = graph.byPk.get(graph.parentByPk.get(current.entry_pk));
	}
	return branch.reverse();
}

function newestDescendant(anchors, graph) {
	let newest;
	const seen = new Set(), stack = [...anchors];
	while (stack.length) {
		const row = stack.pop(); if (seen.has(row.entry_pk)) continue; seen.add(row.entry_pk);
		if (!newest || row.ordinal > newest.ordinal) newest = row;
		stack.push(...(graph.children.get(row.entry_pk) ?? []));
	}
	return newest;
}

export function readCatalogSession(options = {}) {
	if (!options.path) throw new Error("read requires path");
	if (options.allowPartial) throw new Error("allowPartial is not supported for exact path reads");
	const databasePath = path.resolve(options.databasePath ?? defaultCatalogPath(options.sessionsRoot)), db = openReader(databasePath);
	try {
		const file = fileRowByPath(db, options.path), source = sourceState(file), sourceMatchesSnapshot = source.exact;
		if ((file.index_status !== "fresh" || !source.exact) && !options.allowStale) throw new Error(`session source is not fresh: ${file.path}`);
		const rows = db.prepare(`SELECT e.*,COALESCE(length(c.text),0) AS text_length FROM entries e LEFT JOIN entry_content c ON c.entry_pk=e.entry_pk
WHERE e.file_id=? AND e.epoch=? AND e.generation<=? ORDER BY e.ordinal`).all(file.file_id, file.active_epoch, file.active_generation);
		if (!rows.length) return { path: file.path, id: file.session_id, entries: [], coverage: { branchEntries: 0, returnedEntries: 0,
			leafSelection: "none", sourceMatchesSnapshot, sourcePrefixMatches: source.prefix, deferredTailBytes: file.deferred_tail_bytes, sourceSnapshotChecked: true,
			partsAvailable: 0, partsReturned: 0, partsOmitted: 0, metadataBytesReturned: 0, metadataTruncated: false } };
		const graph = branchData(rows);
		const entrySelector = normalizeEntryLocator(options.entry, options.entryByteStart ?? (options.entry ? options.byteStart : undefined), options.entryLocator);
		const leafSelector = normalizeEntryLocator(options.leaf, options.leafByteStart ?? (!options.entry ? options.byteStart : undefined), options.leafLocator);
		let leaf, leafSelection, anchor;
		if (leafSelector) { leaf = resolveEntryRow(rows, leafSelector, "leaf"); leafSelection = "explicit"; }
		else if (entrySelector) { anchor = resolveEntryRow(rows, entrySelector, "entry"); leaf = newestDescendant([anchor], graph); leafSelection = "latest-descendant-not-live"; }
		else { leaf = rows.at(-1); leafSelection = "latest-persisted-entry-not-guaranteed-live-leaf"; }
		const branch = ancestryFor(leaf, graph);
		let focus = branch.length - 1, duplicateEntryMatches = 0;
		if (entrySelector) {
			anchor ??= resolveEntryRow(rows, entrySelector, "entry");
			const matching = branch.map((row, index) => ({ row, index })).filter((item) => item.row.entry_pk === anchor.entry_pk);
			if (!matching.length) throw new Error("entry is not on selected branch");
			focus = matching[0].index;
			duplicateEntryMatches = entrySelector.id === undefined ? 1 : (graph.byId.get(entrySelector.id) ?? []).length;
		}
		const focusRow = branch[focus];
		const before = options.before === undefined ? branch.length : Math.max(0, Number(options.before));
		const after = options.after === undefined ? (entrySelector ? 0 : branch.length) : Math.max(0, Number(options.after));
		let selected = branch.slice(Math.max(0, focus - before), Math.min(branch.length, focus + after + 1));
		if (options.roles?.length || options.role) { const roles = new Set(options.roles ?? [options.role]); selected = selected.filter((row) => roles.has(row.role)); }
		const limit = Math.max(1, Math.min(Number(options.limit ?? 200), 10_000));
		let limited;
		if (selected.length <= limit) limited = selected;
		else {
			const selectedFocus = selected.findIndex((row) => row.entry_pk === focusRow.entry_pk);
			const start = selectedFocus < 0 ? selected.length - limit : Math.max(0, Math.min(selectedFocus, selected.length - limit));
			limited = selected.slice(start, start + limit);
		}
		const textBudget = Math.max(0, Math.min(Number(options.maxChars ?? 256 * 1024), 16 * 1024 * 1024));
		let charsLeft = textBudget;
		let charsAvailable = 0, charsReturned = 0, metadataLeft = READ_RESPONSE_METADATA_BYTES - 4096;
		let metadataBytesReturned = 0, metadataTruncated = false, partsAvailable = 0, partsReturned = 0, entriesOmittedByMetadata = 0;
		const partStatement = db.prepare("SELECT * FROM parts WHERE entry_pk=? ORDER BY part_index LIMIT ?");
		const partCountStatement = db.prepare("SELECT COUNT(*) count FROM parts WHERE entry_pk=?");
		const contentStatement = db.prepare("SELECT substr(text,1,?) text FROM entry_content WHERE entry_pk=?");
		const entries = [], textAllocations = new Map();
		const priority = [...limited].sort((left, right) => {
			if (left.entry_pk === focusRow.entry_pk) return -1;
			if (right.entry_pk === focusRow.entry_pk) return 1;
			return right.ordinal - left.ordinal;
		});
		for (const row of priority) {
			const allocation = Math.min(row.text_length ?? 0, charsLeft); textAllocations.set(row.entry_pk, allocation); charsLeft -= allocation;
		}
		const metadataPriority = [
			...limited.filter((row) => row.entry_pk === focusRow.entry_pk),
			...limited.filter((row) => row.entry_pk !== focusRow.entry_pk),
		];
		for (const row of metadataPriority) {
			const fullLength = row.text_length ?? 0; charsAvailable += fullLength;
			const allocation = textAllocations.get(row.entry_pk) ?? 0;
			const text = allocation > 0 ? (contentStatement.get(allocation, row.entry_pk)?.text ?? "") : "";
			charsReturned += text.length;
			const base = { id: row.entry_id, parentId: row.parent_id, type: row.type, role: row.role ?? undefined,
				timestamp: row.entry_timestamp_ms === null ? undefined : iso(row.entry_timestamp_ms),
				messageTimestamp: row.message_timestamp_ms === null ? undefined : iso(row.message_timestamp_ms),
				ordinal: row.ordinal, byteStart: row.byte_start, byteEnd: row.byte_end, sourceSha256: row.source_sha256, entryRef: entryRef(row) };
			let entryLeft = Math.min(READ_ENTRY_METADATA_BYTES - 1024, metadataLeft), used = jsonBytes(base);
			if (used > entryLeft) { entriesOmittedByMetadata += limited.length - entries.length; metadataTruncated = true; break; }
			const output = { ...base };
			if (row.metadata_json) {
				const metadata = JSON.parse(row.metadata_json), size = jsonBytes(metadata);
				if (used + size <= entryLeft) { output.metadata = metadata; used += size; }
				else metadataTruncated = true;
			}
			const availableParts = partCountStatement.get(row.entry_pk).count;
			const rawParts = partStatement.all(row.entry_pk, READ_ENTRY_PARTS); partsAvailable += availableParts;
			const parts = [];
			for (const part of rawParts) {
				let item = { part: part.part_index, kind: part.kind,
					...(part.tool_call_id ? { toolCallId: part.tool_call_id } : {}), ...(part.tool_name ? { toolName: part.tool_name } : {}),
					...(part.tool_status ? { status: part.tool_status } : {}), ...(part.tool_path ? { path: part.tool_path } : {}),
					...(part.image_sha256 ? { image: { mime: part.image_mime, sha256: part.image_sha256, bytes: part.image_bytes },
						imageSource: { base: part.image_source_base ?? "message", ...(part.image_retained_index === null ? {} : { retainedIndex: part.image_retained_index }), contentIndex: part.image_content_index ?? part.image_source_index } } : {}),
					coverage: { extractedChars: part.extraction_chars, truncated: Boolean(part.extraction_truncated) } };
				if (part.metadata_json) item.metadata = JSON.parse(part.metadata_json);
				let size = jsonBytes(item);
				if (used + size > entryLeft && item.metadata !== undefined) { delete item.metadata; item.metadataTruncated = true; size = jsonBytes(item); metadataTruncated = true; }
				if (used + size > entryLeft) { metadataTruncated = true; break; }
				if (part.text_start !== null) item.text = text.slice(part.text_start, Math.min(part.text_end, text.length));
				parts.push(item); used += size;
			}
			partsReturned += parts.length;
			if (parts.length < availableParts) metadataTruncated = true;
			output.text = text; if (text.length < fullLength) output.textTruncated = true; output.parts = parts;
			entries.push(output); metadataLeft -= used; metadataBytesReturned += used;
		}
		entries.sort((left, right) => left.ordinal - right.ordinal);
		return {
			path: file.path, id: file.session_id, leafId: leaf.entry_id, leafRef: entryRef(leaf), leafSelection, entries,
			coverage: { branchEntries: branch.length, selectedEntries: selected.length, returnedEntries: entries.length,
				entriesOmittedByLimit: selected.length - limited.length, entriesOmittedByMetadata,
				charsAvailable, charsReturned, textTruncated: charsReturned < charsAvailable,
				duplicateLeafMatches: leafSelector?.id === undefined ? 1 : (graph.byId.get(leafSelector.id) ?? []).length,
				duplicateEntryMatches, indexStatus: file.index_status, sourceMatchesSnapshot, sourcePrefixMatches: source.prefix,
				deferredTailBytes: file.deferred_tail_bytes, sourceSnapshotChecked: true,
				partsAvailable, partsReturned, partsOmitted: partsAvailable - partsReturned,
				metadataBytesReturned, metadataLimitBytes: READ_RESPONSE_METADATA_BYTES, entryMetadataLimitBytes: READ_ENTRY_METADATA_BYTES, metadataTruncated },
		};
	} finally { closeReader(db); }
}

function inspectedSource(row) {
	const source = sourceState(row);
	return { indexStatus: row.index_status, indexedOffset: row.indexed_offset, deferredTailBytes: row.deferred_tail_bytes,
		sourceBytes: row.size_bytes, sourcePrefixMatches: source.prefix, sourceMatchesSnapshot: source.exact,
		indexedAt: row.indexed_at_ms === null ? undefined : iso(row.indexed_at_ms), lastError: row.last_error ?? undefined };
}

export function inspectCatalogSession(options = {}) {
	if (Number(Boolean(options.path)) + Number(Boolean(options.id)) !== 1) throw new Error("inspect requires exactly one of path or id");
	const databasePath = path.resolve(options.databasePath ?? defaultCatalogPath(options.sessionsRoot)), db = openReader(databasePath);
	try {
		const rows = options.path
			? [fileRowByPath(db, options.path)]
			: db.prepare("SELECT * FROM files WHERE session_id=? AND missing_since_ms IS NULL AND active_generation>0 ORDER BY modified_ms DESC,path").all(options.id);
		if (!rows.length) throw new Error(`session is not indexed: ${options.id}`);
		const values = rows.map((row) => ({ ...publicSession(row), source: inspectedSource(row) }));
		return values.length === 1 ? values[0] : { id: options.id, ambiguous: true, sources: values };
	} finally { closeReader(db); }
}

export const inspectSession = inspectCatalogSession;

class OutputBase64 extends Base64Digest {
	constructor(fd) { super((bytes) => fs.writeSync(fd, bytes)); }
	end() {
		try { return super.end(); }
		catch (error) { throw new Error("invalid base64 image source", { cause: error }); }
	}
}

class ImageTokenSink {
	constructor(sourcePointer, output) { this.sourcePointer = sourcePointer; this.output = output; this.stack = []; this.string = null; this.found = 0; }
	nextPath() { const p = this.stack.at(-1); return !p ? [] : p.kind === "object" ? [...p.path, p.key] : [...p.path, p.index]; }
	complete() { const p = this.stack.at(-1); if (!p) return; if (p.kind === "object") p.key = undefined; else p.index++; }
	token(token) {
		if (token.name === "startObject" || token.name === "startArray") { const pv = this.nextPath(); this.stack.push({ kind: token.name === "startObject" ? "object" : "array", path: pv, key: undefined, index: 0 }); return; }
		if (token.name === "keyValue") { this.stack.at(-1).key = token.value; return; }
		if (token.name === "startString") {
			const pv = this.nextPath(); const loc = contentLocation(pv), pointer = this.sourcePointer;
			const selected = loc && loc.rest.length === 1 && loc.rest[0] === "data" && loc.base === pointer.base &&
				loc.index === pointer.contentIndex && (loc.retainedIndex ?? null) === (pointer.retainedIndex ?? null);
			this.string = { selected }; if (selected) { if (this.found) throw new Error("duplicate image source pointer"); this.decoder = this.output; this.found++; } return;
		}
		if (token.name === "stringChunk") { if (this.string?.selected) this.decoder.add(token.value); return; }
		if (token.name === "endString") { this.string = null; this.complete(); return; }
		if (["numberValue","trueValue","falseValue","nullValue"].includes(token.name)) { this.complete(); return; }
		if (token.name === "endObject" || token.name === "endArray") { this.stack.pop(); this.complete(); }
	}
}

export async function extractCatalogImage(options = {}) {
	if (!options.path || !options.entry || options.part === undefined || !options.output) throw new Error("image requires path, entry, part, and output");
	const databasePath = path.resolve(options.databasePath ?? defaultCatalogPath(options.sessionsRoot));
	const db = openReader(databasePath);
	let file, entry, image;
	try {
		file = fileRowByPath(db, options.path);
		if (file.index_status !== "fresh" || !sourceMatchesRow(file)) throw new Error("source generation differs from indexed image pointer");
		const locator = normalizeEntryLocator(options.entry, options.entryByteStart ?? options.byteStart, options.entryLocator);
		const candidates = db.prepare(`SELECT * FROM entries WHERE file_id=? AND epoch=? AND generation<=?${locator?.id !== undefined ? " AND entry_id=?" : ""}${locator?.byteStart !== undefined ? " AND byte_start=?" : ""} ORDER BY ordinal`)
			.all(file.file_id, file.active_epoch, file.active_generation, ...(locator?.id !== undefined ? [locator.id] : []), ...(locator?.byteStart !== undefined ? [locator.byteStart] : []));
		entry = resolveEntryRow(candidates, locator, "entry");
		image = db.prepare("SELECT * FROM parts WHERE entry_pk=? AND part_index=? AND kind='image'").get(entry.entry_pk, Number(options.part));
		if (!image) throw new Error(`image part not found: ${options.part}`);
	} finally { closeReader(db); }
	const outputPath = path.resolve(options.output);
	if (outputPath === path.resolve(file.path)) throw new Error("image output cannot replace its source session");
	fs.mkdirSync(path.dirname(outputPath), { recursive: true });
	const temporary = `${outputPath}.tmp-${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
	const outputFd = fs.openSync(temporary, "wx", 0o600);
	let sourceFd;
	try {
		sourceFd = fs.openSync(file.path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
		const opened = statIdentity(fs.fstatSync(sourceFd, { bigint: true }));
		validateOpened(file.path, file.source_root, file.canonical_path, opened);
		if (!sameSnapshot(opened, file)) throw new Error("source generation differs before image read");
		const sourceHash = hash();
		const decoder = new OutputBase64(outputFd);
		const sourcePointer = { base: image.image_source_base ?? "message",
			...(image.image_retained_index === null ? {} : { retainedIndex: image.image_retained_index }),
			contentIndex: image.image_content_index ?? image.image_source_index };
		const imageSink = new ImageTokenSink(sourcePointer, decoder);
		const tracker = new Transform({ transform(chunk, encoding, callback) { sourceHash.update(chunk); callback(null, chunk); } });
		const tokenizer = parser.asStream({ packKeys: true, streamKeys: false, packStrings: false, streamStrings: true, packNumbers: true, streamNumbers: false });
		const sink = new Writable({ objectMode: true, write(token, encoding, callback) { try { imageSink.token(token); callback(); } catch (error) { callback(error); } } });
		await pipeline(fs.createReadStream(null, { fd: sourceFd, autoClose: false, start: entry.byte_start, end: entry.byte_end - 1, highWaterMark: READ_BUFFER_BYTES }), tracker, tokenizer, sink);
		if (sourceHash.digest("hex") !== entry.source_sha256) throw new Error("image source entry hash changed");
		if (imageSink.found !== 1) throw new Error("image source pointer did not resolve exactly once");
		const ending = statIdentity(fs.fstatSync(sourceFd, { bigint: true }));
		validateOpened(file.path, file.source_root, file.canonical_path, ending);
		if (!sameSnapshot(ending, file)) throw new Error("source generation differs during image read");
		const actual = decoder.end();
		if (actual.sha256 !== image.image_sha256 || actual.bytes !== image.image_bytes) throw new Error("decoded image hash or length differs from index");
		fs.fsyncSync(outputFd); fs.closeSync(outputFd); try { fs.closeSync(sourceFd); } catch {} sourceFd = undefined;
		fs.renameSync(temporary, outputPath); fs.chmodSync(outputPath, 0o600);
		return { path: file.path, entry: entry.entry_id, entryRef: entryRef(entry), part: image.part_index, output: outputPath,
			imageSource: sourcePointer, mime: image.image_mime, sha256: actual.sha256, bytes: actual.bytes };
	} catch (error) {
		try { fs.closeSync(outputFd); } catch {}
		fs.rmSync(temporary, { force: true }); throw error;
	} finally { if (sourceFd !== undefined) try { fs.closeSync(sourceFd); } catch {} }
}

function storageBytes(databasePath) {
	const storage = {}; let total = 0;
	for (const [name, suffix] of [["database", ""], ["wal", "-wal"], ["shm", "-shm"]]) {
		try { storage[name] = fs.statSync(`${databasePath}${suffix}`).size; total += storage[name]; }
		catch (error) { if (error?.code !== "ENOENT") throw error; storage[name] = 0; }
	}
	return { storage, total };
}

export function catalogStatus(options = {}) {
	const databasePath = path.resolve(options.databasePath ?? defaultCatalogPath(options.sessionsRoot));
	const db = openReader(databasePath);
	try {
		const sourceRoot = catalogReaderSourceRoot(db, options, databasePath);
		const files = db.prepare(`SELECT COUNT(*) count,COALESCE(SUM(size_bytes),0) bytes,COALESCE(SUM(message_count),0) messages,
SUM(CASE WHEN deferred_tail_bytes>0 THEN 1 ELSE 0 END) deferred_files,COALESCE(SUM(deferred_tail_bytes),0) deferred_bytes
FROM files WHERE source_root=? AND missing_since_ms IS NULL AND active_generation>0`).get(sourceRoot);
		const entries = db.prepare(`SELECT COUNT(*) count,COALESCE(SUM(e.stored_chars),0) text_chars,
COALESCE(SUM(CASE WHEN e.stored_chars>0 THEN 1 ELSE 0 END),0) documents
FROM entries e JOIN files f ON f.file_id=e.file_id
WHERE f.source_root=? AND e.epoch=f.active_epoch AND e.generation<=f.active_generation AND f.missing_since_ms IS NULL`).get(sourceRoot);
		const parts = db.prepare(`SELECT kind,COUNT(*) count FROM parts p JOIN entries e ON e.entry_pk=p.entry_pk JOIN files f ON f.file_id=e.file_id
WHERE f.source_root=? AND e.epoch=f.active_epoch AND e.generation<=f.active_generation AND f.missing_since_ms IS NULL GROUP BY kind`).all(sourceRoot);
		const failures = db.prepare("SELECT path,index_status,last_error,error_at_ms FROM files WHERE source_root=? AND (index_status<>'fresh' OR missing_since_ms IS NOT NULL)").all(sourceRoot);
		const unbound = db.prepare("SELECT * FROM file_failures WHERE source_root=? AND path NOT IN (SELECT path FROM files)").all(sourceRoot);
		const failedScopes = db.prepare("SELECT scope_key,error_json,reconciled_at_ms FROM reconcile_scopes WHERE source_root=? AND complete=0").all(sourceRoot);
		const projects = db.prepare(`SELECT cwd,COUNT(*) sessions,SUM(size_bytes) bytes FROM files
WHERE source_root=? AND missing_since_ms IS NULL AND active_generation>0 GROUP BY cwd ORDER BY bytes DESC`).all(sourceRoot);
		const scopedFtsRequired = Boolean(db.prepare(`SELECT 1 FROM files
WHERE active_generation>0 AND (source_root<>? OR missing_since_ms IS NOT NULL) LIMIT 1`).get(sourceRoot));
		const fts = scopedFtsRequired ? db.prepare(`SELECT COUNT(*) count FROM entry_fts JOIN entries e ON e.entry_pk=entry_fts.rowid JOIN files f ON f.file_id=e.file_id
WHERE f.source_root=? AND e.epoch=f.active_epoch AND e.generation<=f.active_generation AND f.missing_since_ms IS NULL`).get(sourceRoot)
			: db.prepare("SELECT COUNT(*) count FROM entry_fts_docsize").get();
		const disk = storageBytes(databasePath);
		return { databasePath, sourceRoot, databaseBytes: disk.total, storageBytes: disk.storage,
			schemaVersion: db.prepare("PRAGMA user_version").get().user_version,
			parserVersion: Number(db.prepare("SELECT value FROM store_meta WHERE key='parser_version'").get()?.value ?? 0),
			integrity: options.integrity ? db.prepare("PRAGMA integrity_check").get().integrity_check : "not-checked",
			files: files.count, sourceBytes: files.bytes, messageEntries: files.messages, deferredFiles: files.deferred_files, deferredBytes: files.deferred_bytes,
			entries: entries.count, extractedTextChars: entries.text_chars, documents: entries.documents, ftsContentRows: fts.count,
			parts: Object.fromEntries(parts.map((row) => [row.kind, row.count])), failures: [...failures, ...unbound], failedScopes,
			fresh: failures.length === 0 && unbound.length === 0 && failedScopes.length === 0, projects };
	} finally { closeReader(db); }
}

export function rebuildFts(options = {}) {
	const databasePath = path.resolve(options.databasePath ?? defaultCatalogPath(options.sessionsRoot));
	ensurePrivatePath(databasePath); const release = acquireWriterLock(databasePath); let db;
	try {
		db = openCatalog(databasePath, { lockHeld: true });
		db.exec("INSERT INTO entry_fts(entry_fts) VALUES('rebuild')");
		return { databasePath, ftsContentRows: db.prepare("SELECT COUNT(*) count FROM entry_fts").get().count };
	} finally { if (db) closeCatalog(db, databasePath); release(); }
}

export async function verifyCatalog(options = {}) {
	const started = performance.now();
	const sessionsRoot = path.resolve(options.sessionsRoot ?? defaultSessionsRoot());
	const databasePath = path.resolve(options.databasePath ?? defaultCatalogPath(sessionsRoot));
	const discovery = discoverSessionFiles({ sessionsRoot, cwd: options.cwd, all: options.all, tree: options.tree, path: options.path });
	const db = openReader(databasePath);
	const failures = [...discovery.failures]; let verified = 0, bytesRead = 0;
	try {
		for (const context of discovery.files) {
			throwIfAborted(options.signal);
			const file = rowForPath(db, context.filePath);
			if (!file || !file.active_generation) { failures.push({ path: context.filePath, reason: "missing active store row" }); continue; }
			if (file.index_status !== "fresh") { failures.push({ path: context.filePath, reason: `index status ${file.index_status}`, error: file.last_error }); continue; }
			const iterator = db.prepare(`SELECT e.*,c.text FROM entries e LEFT JOIN entry_content c ON c.entry_pk=e.entry_pk
WHERE e.file_id=? AND e.epoch=? AND e.generation<=? ORDER BY e.ordinal`).iterate(file.file_id, file.active_epoch, file.active_generation)[Symbol.iterator]();
			let mismatch; let seen = 0, observedName, observedMessageCount = 0, observedFirstMessage, observedFirstMessageChars = 0,
				observedFirstMessageTruncated = false, observedLastActivity;
			try {
				const scan = await scanSessionFile(context.filePath, { epoch: file.active_epoch, generation: file.active_generation,
					expectedCanonicalPath: context.canonicalPath, sourceRoot: context.sourceRoot, signal: options.signal,
					endOffset: file.indexed_offset, expectedSentinels: file.sentinels_json, onBatch(records) {
						for (const record of records) {
							if (record.metadata.type === "session_info") observedName = typeof record.metadata.name === "string" && record.metadata.name.trim() ? record.metadata.name.trim() : undefined;
							if (record.entry.type === "message") {
								observedMessageCount++;
								if ((record.entry.role === "user" || record.entry.role === "assistant") && record.entry.messageTimestampMs !== null) observedLastActivity = Math.max(observedLastActivity ?? 0, record.entry.messageTimestampMs);
								if (!observedFirstMessage && record.entry.role === "user") {
									const part = record.parts.find((item) => item.searchClass === "conversation" && item.textStart !== undefined);
									if (part) {
										const full = record.content.slice(part.textStart, part.textEnd);
										observedFirstMessage = full.slice(0, DEFAULT_MAX_FIRST_MESSAGE_CHARS);
										observedFirstMessageChars = part.extractionChars;
										observedFirstMessageTruncated = part.extractionTruncated || part.extractionChars > observedFirstMessage.length;
									}
								}
							}
							const expected = iterator.next().value; seen++;
							if (!expected || expected.ordinal !== record.entry.ordinal || expected.entry_id !== record.entry.id ||
								expected.parent_id !== record.entry.parentId || expected.type !== record.entry.type || expected.role !== record.entry.role ||
								expected.byte_start !== record.entry.byteStart || expected.byte_end !== record.entry.byteEnd ||
								expected.source_sha256 !== record.entry.sourceSha256 || (expected.text ?? "") !== record.content ||
								(expected.metadata_json ?? null) !== (record.entry.metadata ? JSON.stringify(record.entry.metadata) : null)) {
								mismatch ??= { ordinal: record.entry.ordinal, reason: "normalized entry mismatch" };
							} else {
								const storedParts = db.prepare(`SELECT part_index,kind,search_class,text_start,text_end,tool_call_id,tool_name,tool_status,tool_path,metadata_json,
image_mime,image_sha256,image_bytes,image_source_index,image_source_base,image_retained_index,image_content_index,extraction_chars,extraction_truncated FROM parts WHERE entry_pk=? ORDER BY part_index`).all(expected.entry_pk);
								const normalizedParts = record.parts.map((part) => ({ part_index: part.partIndex, kind: part.kind, search_class: part.searchClass,
									text_start: part.textStart ?? null, text_end: part.textEnd ?? null, tool_call_id: part.toolCallId ?? null,
									tool_name: part.toolName ?? null, tool_status: part.toolStatus ?? null, tool_path: part.toolPath ?? null,
									metadata_json: part.metadata ? JSON.stringify(part.metadata) : null, image_mime: part.imageMime ?? null, image_sha256: part.imageSha256 ?? null, image_bytes: part.imageBytes ?? null,
									image_source_index: part.imageSourceIndex ?? null, image_source_base: part.imageSource?.base ?? null,
									image_retained_index: part.imageSource?.retainedIndex ?? null,
									image_content_index: part.imageSource?.contentIndex ?? part.imageSourceIndex ?? null, extraction_chars: part.extractionChars ?? 0,
									extraction_truncated: part.extractionTruncated ? 1 : 0 }));
								if (JSON.stringify(storedParts) !== JSON.stringify(normalizedParts)) mismatch ??= { ordinal: record.entry.ordinal, reason: "normalized part mismatch" };
							}
						}
					},
				});
				bytesRead += scan.metrics.bytesRead;
				if (iterator.next().done !== true) mismatch ??= { reason: "catalog has extra active entries" };
				const header = scan.header;
				const observedCreated = parseTimestamp(header?.timestamp) ?? scan.opening.mtimeMs;
				if (header?.id !== file.session_id || header?.cwd !== file.cwd || (header?.parentSession ?? null) !== file.parent_path ||
					scan.indexedOffset !== file.indexed_offset || observedCreated !== file.created_ms || (observedLastActivity ?? observedCreated) !== file.modified_ms ||
					(observedName ?? null) !== file.name || observedMessageCount !== file.message_count || (observedFirstMessage || "(no messages)") !== file.first_message ||
					observedFirstMessageChars !== file.first_message_chars || Number(observedFirstMessageTruncated) !== file.first_message_truncated) {
					mismatch ??= { reason: "file metadata mismatch" };
				}
				if (mismatch) failures.push({ path: context.filePath, ...mismatch }); else verified++;
			} catch (error) { failures.push({ path: context.filePath, reason: error instanceof Error ? error.message : String(error) }); }
		}
		const observed = new Set(discovery.files.map((item) => item.filePath));
		let rows;
		if (options.path) rows = [];
		else if (options.all) rows = db.prepare("SELECT path,missing_since_ms FROM files WHERE source_root=?").all(discovery.sourceRoot);
		else if (options.tree) {
			const filter = cwdClause(options.cwd, true);
			rows = db.prepare(`SELECT f.path,f.missing_since_ms FROM files f WHERE 1=1${filter.sql}`).all(...filter.params);
		} else rows = discovery.buckets.flatMap((bucket) => db.prepare("SELECT path,missing_since_ms FROM files WHERE bucket_path=?").all(bucket));
		for (const row of rows) if (!observed.has(row.path)) failures.push({ path: row.path, reason: row.missing_since_ms === null ? "catalog-only active row" : "catalog-only row pending deletion" });
		return { files: discovery.files.length, verified, failures, bytesRead, scopeComplete: discovery.complete && failures.length === 0,
			ok: discovery.complete && failures.length === 0, durationMs: performance.now() - started };
	} finally { closeReader(db); }
}

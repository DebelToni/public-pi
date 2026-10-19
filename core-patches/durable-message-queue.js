import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
    chmodSync,
    closeSync,
    existsSync,
    fstatSync,
    fsyncSync,
    mkdirSync,
    openSync,
    readFileSync,
    readdirSync,
    readSync,
    renameSync,
    statSync,
    unlinkSync,
    writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import properLockfile from "proper-lockfile";

export const DURABLE_QUEUE_PATCH_VERSION = 11;
const QUEUE_VERSION = 1;
const DURABLE_ID_FIELD = "__piDurableQueueId";
const ORIGINAL_DETAILS_FIELD = "__piDurableOriginalDetails";
const activeOwners = new Set();
const processIdentityCache = new Map();
let enqueueSequence = 0;

function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function ensurePrivateDirectory(path) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    chmodSync(path, 0o700);
}

function writeAll(fd, data) {
    let offset = 0;
    while (offset < data.length) {
        const written = writeSync(fd, data, offset, data.length - offset);
        if (written <= 0) throw new Error("Short write while persisting durable queued input.");
        offset += written;
    }
}

function fsyncDirectory(path) {
    const fd = openSync(path, "r");
    try {
        fsyncSync(fd);
    }
    finally {
        closeSync(fd);
    }
}

function atomicWrite(path, value) {
    const directory = dirname(path);
    ensurePrivateDirectory(directory);
    const temporaryPath = join(directory, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
    const data = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
    let fd;
    try {
        fd = openSync(temporaryPath, "wx", 0o600);
        writeAll(fd, data);
        fsyncSync(fd);
        closeSync(fd);
        fd = undefined;
        renameSync(temporaryPath, path);
        try {
            fsyncDirectory(directory);
        }
        catch {
            // The atomic rename is already visible and must remain accepted rather
            // than leaving a ghost record after reporting failure.
        }
    }
    catch (error) {
        if (fd !== undefined) {
            try {
                closeSync(fd);
            }
            catch {
                // Preserve the original write failure.
            }
        }
        try {
            unlinkSync(temporaryPath);
        }
        catch {
            // The temporary file may not have been created or may already be renamed.
        }
        throw error;
    }
}

function processIsAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (error) {
        return error?.code === "EPERM";
    }
}

function processIdentity(pid) {
    const cached = processIdentityCache.get(pid);
    if (cached && Date.now() - cached.checkedAt < 1000) return cached.identity;
    let identity;
    try {
        identity = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
        }).trim() || undefined;
    }
    catch {
        identity = undefined;
    }
    processIdentityCache.set(pid, { checkedAt: Date.now(), identity });
    return identity;
}

const currentProcessIdentity = processIdentity(process.pid);

function ownerIsActive(record) {
    if (record.ownerPid === process.pid) {
        return activeOwners.has(record.ownerToken);
    }
    if (!processIsAlive(record.ownerPid)) return false;
    if (typeof record.ownerProcessIdentity !== "string") return true;
    return processIdentity(record.ownerPid) === record.ownerProcessIdentity;
}

function validBehavior(value) {
    return value === "steer" || value === "followUp";
}

function validMessage(value) {
    return isRecord(value) && (value.role === "user" || value.role === "custom") && "content" in value;
}

function validRecord(value, sessionId) {
    return isRecord(value)
        && value.version === QUEUE_VERSION
        && typeof value.id === "string"
        && /^[0-9a-f-]{36}$/i.test(value.id)
        && value.sessionId === sessionId
        && typeof value.sessionFile === "string"
        && (value.branchAnchor === null || typeof value.branchAnchor === "string")
        && validBehavior(value.behavior)
        && validMessage(value.message)
        && typeof value.createdAt === "number"
        && Number.isFinite(value.createdAt)
        && typeof value.sequence === "number"
        && Number.isFinite(value.sequence)
        && Number.isInteger(value.ownerPid)
        && typeof value.ownerToken === "string"
        && (value.ownerProcessIdentity === undefined || typeof value.ownerProcessIdentity === "string");
}

function validCancellation(value, sessionId) {
    return isRecord(value)
        && value.version === QUEUE_VERSION
        && value.type === "cancel"
        && value.sessionId === sessionId
        && Array.isArray(value.ids)
        && value.ids.every((id) => typeof id === "string" && /^[0-9a-f-]{36}$/i.test(id));
}

export function getDurableMessageId(message) {
    if (!isRecord(message)) return undefined;
    if (typeof message[DURABLE_ID_FIELD] === "string") return message[DURABLE_ID_FIELD];
    if (message.role === "custom" && isRecord(message.details) && typeof message.details[DURABLE_ID_FIELD] === "string") {
        return message.details[DURABLE_ID_FIELD];
    }
    return undefined;
}

export function preserveDurableMessageId(message, id) {
    if (!id || !isRecord(message)) return;
    message[DURABLE_ID_FIELD] = id;
}

function restoreLegacyCustomDetails(message) {
    if (message.role !== "custom" || !isRecord(message.details) || !(DURABLE_ID_FIELD in message.details)) return message;
    if (ORIGINAL_DETAILS_FIELD in message.details) {
        return { ...message, details: message.details[ORIGINAL_DETAILS_FIELD] };
    }
    const details = { ...message.details };
    delete details[DURABLE_ID_FIELD];
    return { ...message, details: Object.keys(details).length > 0 ? details : undefined };
}

function tagMessage(message, id) {
    const tagged = restoreLegacyCustomDetails({ ...message });
    preserveDurableMessageId(tagged, id);
    return tagged;
}

function entryDurableId(entry) {
    if (!isRecord(entry)) return undefined;
    if (entry.type === "message") return getDurableMessageId(entry.message);
    if (entry.type === "custom_message") {
        if (typeof entry.durableQueueId === "string") return entry.durableQueueId;
        if (isRecord(entry.details)) {
            const id = entry.details[DURABLE_ID_FIELD];
            return typeof id === "string" ? id : undefined;
        }
    }
    return undefined;
}

async function committedIdsFromDisk(sessionFile) {
    const ids = new Set();
    if (!sessionFile || !existsSync(sessionFile)) return ids;
    const fd = openSync(sessionFile, "r");
    const inspectLine = (line) => {
        if (!line.includes(DURABLE_ID_FIELD) && !line.includes("durableQueueId")) return;
        try {
            const id = entryDurableId(JSON.parse(line));
            if (id) ids.add(id);
        }
        catch {
            // A torn or malformed physical entry is not a durable commitment.
        }
    };
    try {
        // Bind acknowledgement to one file snapshot: bytes appended after this size
        // are excluded even if a concurrent writer adds them before scanning starts.
        const size = fstatSync(fd).size;
        fsyncSync(fd);
        const decoder = new StringDecoder("utf8");
        const buffer = Buffer.allocUnsafe(64 * 1024);
        let pending = "";
        let position = 0;
        let chunksSinceYield = 0;
        while (position < size) {
            const length = Math.min(buffer.length, size - position);
            const bytesRead = readSync(fd, buffer, 0, length, position);
            if (bytesRead === 0) break;
            position += bytesRead;
            const text = pending + decoder.write(buffer.subarray(0, bytesRead));
            const lines = text.split("\n");
            pending = lines.pop() ?? "";
            for (const line of lines) inspectLine(line);
            if (++chunksSinceYield >= 16) {
                chunksSinceYield = 0;
                await new Promise((resolve) => setImmediate(resolve));
            }
        }
        pending += decoder.end();
        if (pending) inspectLine(pending);
        return ids;
    }
    finally {
        closeSync(fd);
    }
}

function lastSessionEntry(sessionFile) {
    if (!sessionFile || !existsSync(sessionFile)) return undefined;
    const fd = openSync(sessionFile, "r");
    try {
        fsyncSync(fd);
        let position = fstatSync(fd).size;
        let data = Buffer.alloc(0);
        while (position > 0) {
            const length = Math.min(64 * 1024, position);
            position -= length;
            const chunk = Buffer.allocUnsafe(length);
            const bytesRead = readSync(fd, chunk, 0, length, position);
            data = Buffer.concat([chunk.subarray(0, bytesRead), data]);
            let end = data.length;
            while (end > 0 && (data[end - 1] === 0x0a || data[end - 1] === 0x0d)) end--;
            const start = data.lastIndexOf(0x0a, end - 1) + 1;
            if (start > 0 || position === 0) {
                try {
                    return JSON.parse(data.subarray(start, end).toString("utf8"));
                }
                catch {
                    return undefined;
                }
            }
        }
        return undefined;
    }
    finally {
        closeSync(fd);
    }
}

function removeFile(path) {
    try {
        unlinkSync(path);
        return true;
    }
    catch (error) {
        return error?.code === "ENOENT";
    }
}

function sameFileIdentity(left, right) {
    if (typeof left !== "string" || typeof right !== "string") return false;
    if (left === right) return true;
    try {
        const leftStat = statSync(left);
        const rightStat = statSync(right);
        return leftStat.dev === rightStat.dev && leftStat.ino === rightStat.ino;
    }
    catch {
        // A vanished original path represents a moved session. A copied session keeps
        // the original path alive and therefore fails closed.
        return !existsSync(left);
    }
}

function recordOrder(a, b) {
    const behaviorOrder = Number(a.behavior === "followUp") - Number(b.behavior === "followUp");
    if (behaviorOrder !== 0) return behaviorOrder;
    if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
    if (a.sequence !== b.sequence) return a.sequence - b.sequence;
    return a.id.localeCompare(b.id);
}

export class DurableMessageQueue {
    constructor(sessionManager) {
        this.sessionManager = sessionManager;
        this.enabled = sessionManager.isPersisted();
        this.ownerToken = randomUUID();
        this.knownIds = new Set();
        this.disposed = false;
        const sessionHash = createHash("sha256").update(sessionManager.getSessionId()).digest("hex");
        const agentDirectory = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
        this.rootDirectory = join(agentDirectory, "durable-message-queue");
        this.directory = join(this.rootDirectory, sessionHash);
        activeOwners.add(this.ownerToken);
    }

    _ensureDirectory() {
        ensurePrivateDirectory(this.rootDirectory);
        ensurePrivateDirectory(this.directory);
    }

    _recordPath(id) {
        return join(this.directory, `${id}.json`);
    }

    async _withLock(callback) {
        this._ensureDirectory();
        const release = await properLockfile.lock(this.directory, {
            realpath: false,
            stale: 10_000,
            update: 2_000,
            retries: {
                retries: 100,
                factor: 1,
                minTimeout: 50,
                maxTimeout: 100,
            },
        });
        try {
            return await callback();
        }
        finally {
            await release();
        }
    }

    enqueue(behavior, message) {
        if (!this.enabled) return message;
        if (!validBehavior(behavior) || !validMessage(message)) {
            throw new Error("Only user and custom steering/follow-up messages can be made durable.");
        }
        // A new SessionManager normally defers its JSONL until the first assistant
        // response. Materialize the active user turn before accepting queued input so
        // the session itself remains discoverable if that first response crashes.
        this.sessionManager.flushPendingEntries();
        this._ensureDirectory();
        const id = randomUUID();
        const taggedMessage = tagMessage(message, id);
        const record = {
            version: QUEUE_VERSION,
            id,
            sessionId: this.sessionManager.getSessionId(),
            sessionFile: this.sessionManager.getSessionFile(),
            branchAnchor: this.sessionManager.getLeafId(),
            behavior,
            createdAt: Date.now(),
            sequence: ++enqueueSequence,
            ownerPid: process.pid,
            ownerToken: this.ownerToken,
            ownerProcessIdentity: currentProcessIdentity,
            message: taggedMessage,
        };
        atomicWrite(this._recordPath(id), record);
        this.knownIds.add(id);
        return taggedMessage;
    }

    discardMessages(messages) {
        if (!this.enabled) return 0;
        const ids = [...new Set(messages.map(getDurableMessageId).filter(Boolean))];
        if (ids.length === 0) return 0;
        this._ensureDirectory();
        const cancellationPath = join(this.directory, `${randomUUID()}.cancel.json`);
        atomicWrite(cancellationPath, {
            version: QUEUE_VERSION,
            type: "cancel",
            sessionId: this.sessionManager.getSessionId(),
            ids,
        });
        let complete = true;
        for (const id of ids) {
            if (removeFile(this._recordPath(id))) {
                this.knownIds.delete(id);
            }
            else {
                complete = false;
            }
        }
        try {
            fsyncDirectory(this.directory);
        }
        catch {
            complete = false;
        }
        if (complete && removeFile(cancellationPath)) {
            try {
                fsyncDirectory(this.directory);
            }
            catch {
                // A leftover cancellation marker is safe and idempotent on recovery.
            }
        }
        return complete ? 0 : 1;
    }

    reconcileCommitted(id) {
        if (!this.enabled || !id || !this.knownIds.has(id)) return;
        let entry;
        try {
            entry = lastSessionEntry(this.sessionManager.getSessionFile());
        }
        catch {
            return;
        }
        if (entryDurableId(entry) !== id) return;
        if (!removeFile(this._recordPath(id))) return;
        this.knownIds.delete(id);
        try {
            fsyncDirectory(this.directory);
        }
        catch {
            // The physical JSONL entry was fsynced before the queue record was removed.
        }
    }

    async loadRecoverable() {
        if (!this.enabled) return { records: [], invalidCount: 0, skippedLiveCount: 0, skippedScopeCount: 0 };
        return await this._withLock(async () => {
            let names = readdirSync(this.directory);
            let invalidCount = 0;
            let changed = false;
            for (const name of names.filter((candidate) => candidate.endsWith(".cancel.json"))) {
                const path = join(this.directory, name);
                let cancellation;
                try {
                    cancellation = JSON.parse(readFileSync(path, "utf8"));
                }
                catch {
                    invalidCount++;
                    continue;
                }
                if (!validCancellation(cancellation, this.sessionManager.getSessionId())) {
                    invalidCount++;
                    continue;
                }
                let complete = true;
                for (const id of cancellation.ids) {
                    complete = removeFile(this._recordPath(id)) && complete;
                    this.knownIds.delete(id);
                }
                if (complete) changed = removeFile(path) || changed;
                await new Promise((resolve) => setImmediate(resolve));
            }
            names = readdirSync(this.directory);
            const currentSessionFile = this.sessionManager.getSessionFile();
            const hasRecordCandidates = names.some((name) => name.endsWith(".json") && !name.endsWith(".cancel.json"));
            const committedIds = hasRecordCandidates
                ? await committedIdsFromDisk(currentSessionFile)
                : new Set();
            const activeBranchIds = new Set(this.sessionManager.getBranch().map((entry) => entry.id));
            const records = [];
            let skippedLiveCount = 0;
            let skippedScopeCount = 0;
            for (const name of names) {
                if (!name.endsWith(".json") || name.endsWith(".cancel.json")) continue;
                const path = join(this.directory, name);
                let record;
                try {
                    record = JSON.parse(readFileSync(path, "utf8"));
                }
                catch {
                    invalidCount++;
                    continue;
                }
                if (!validRecord(record, this.sessionManager.getSessionId()) || name !== `${record.id}.json`) {
                    invalidCount++;
                    continue;
                }
                if (committedIds.has(record.id)) {
                    changed = removeFile(path) || changed;
                    continue;
                }
                if (!sameFileIdentity(record.sessionFile, currentSessionFile)
                    || (record.branchAnchor !== null && !activeBranchIds.has(record.branchAnchor))) {
                    skippedScopeCount++;
                    continue;
                }
                if (ownerIsActive(record)) {
                    skippedLiveCount++;
                    continue;
                }
                record = {
                    ...record,
                    ownerPid: process.pid,
                    ownerToken: this.ownerToken,
                    ownerProcessIdentity: currentProcessIdentity,
                    message: tagMessage(record.message, record.id),
                };
                atomicWrite(path, record);
                this.knownIds.add(record.id);
                records.push(record);
                await new Promise((resolve) => setImmediate(resolve));
            }
            if (changed) {
                try {
                    fsyncDirectory(this.directory);
                }
                catch {
                    // Reconciliation is complete; directory sync is best-effort here.
                }
            }
            records.sort(recordOrder);
            return { records, invalidCount, skippedLiveCount, skippedScopeCount };
        });
    }

    dispose() {
        if (this.disposed) return;
        this.disposed = true;
        activeOwners.delete(this.ownerToken);
    }
}

import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const codingAgentRoot = process.env.PI_CODING_AGENT_ROOT
    ?? "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent";
const temporaryRoot = mkdtempSync("/tmp/pi-durable-queue-unit-");
process.env.PI_CODING_AGENT_DIR = join(temporaryRoot, "agent");
const {
    DurableMessageQueue,
    getDurableMessageId,
} = await import(`${codingAgentRoot}/dist/core/durable-message-queue.js?unit=${Date.now()}`);

class FakeSessionManager {
    constructor(id, sessionFile) {
        this.id = id;
        this.sessionFile = sessionFile;
        this.entries = [];
        this.leaf = null;
    }
    isPersisted() { return true; }
    getSessionId() { return this.id; }
    getSessionFile() { return this.sessionFile; }
    getLeafId() { return this.leaf; }
    getEntries() { return this.entries.slice(); }
    getBranch() { return this.entries.slice(); }
    flushPendingEntries() {}
}

function user(text, extra = []) {
    return {
        role: "user",
        content: [{ type: "text", text }, ...extra],
        timestamp: Date.now(),
    };
}

function queueDirectory() {
    const root = join(process.env.PI_CODING_AGENT_DIR, "durable-message-queue");
    const directories = readdirSync(root).filter((name) => !name.endsWith(".lock"));
    assert.equal(directories.length, 1);
    return join(root, directories[0]);
}

function recordFiles(directory) {
    return readdirSync(directory).filter((name) => name.endsWith(".json"));
}

function hasRecord(id) {
    const root = join(process.env.PI_CODING_AGENT_DIR, "durable-message-queue");
    return readdirSync(root)
        .filter((name) => !name.endsWith(".lock"))
        .some((name) => readdirSync(join(root, name)).includes(`${id}.json`));
}

const sessionFile = join(temporaryRoot, "session.jsonl");
const manager = new FakeSessionManager("00000000-0000-0000-0000-000000000001", sessionFile);
const original = new DurableMessageQueue(manager);
const image = { type: "image", data: "aW1hZ2U=", mimeType: "image/png" };
const followFirst = original.enqueue("followUp", user("same"));
const steerFirst = original.enqueue("steer", user("same", [image]));
const custom = original.enqueue("steer", {
    role: "custom",
    customType: "continuity",
    content: "hidden",
    display: false,
    details: "original details",
    timestamp: Date.now(),
});
const steerSecond = original.enqueue("steer", user("same"));

const directory = queueDirectory();
assert.equal(statSync(join(process.env.PI_CODING_AGENT_DIR, "durable-message-queue")).mode & 0o777, 0o700);
assert.equal(statSync(directory).mode & 0o777, 0o700);
for (const name of recordFiles(directory)) {
    assert.equal(statSync(join(directory, name)).mode & 0o777, 0o600);
}
assert.equal(recordFiles(directory).length, 4);
assert.equal(new Set([followFirst, steerFirst, custom, steerSecond].map(getDurableMessageId)).size, 4);

const competing = new DurableMessageQueue(manager);
let recovery = await competing.loadRecoverable();
assert.equal(recovery.records.length, 0, "a live process must retain ownership");
assert.equal(recovery.skippedLiveCount, 4);
competing.dispose();

original.dispose();
const reopened = new DurableMessageQueue(manager);
recovery = await reopened.loadRecoverable();
assert.deepEqual(
    recovery.records.map((record) => [record.behavior, record.message.role]),
    [["steer", "user"], ["steer", "custom"], ["steer", "user"], ["followUp", "user"]],
);
assert.deepEqual(recovery.records[0].message.content[1], image);
assert.equal(recovery.records.find((record) => record.message.role === "custom").message.details, "original details");
assert.equal(recovery.records.filter((record) => record.message.role === "user").length, 3);

const canceled = recovery.records[2].message;
assert.equal(reopened.discardMessages([canceled]), 0);
assert.equal(recordFiles(directory).length, 3, "duplicate text must be canceled by ID, not content");

const committed = recovery.records[0];
manager.entries = [
    {
        type: "message",
        id: "assistant-entry",
        message: { role: "assistant", content: [], stopReason: "stop" },
    },
    {
        type: "message",
        id: "committed-entry",
        message: committed.message,
    },
];
writeFileSync(sessionFile, manager.entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
reopened.reconcileCommitted(getDurableMessageId(committed.message));
assert.equal(recordFiles(directory).length, 2);

const committedCustom = recovery.records.find((record) => record.message.role === "custom");
manager.entries.push({
    type: "custom_message",
    id: "custom-entry",
    customType: committedCustom.message.customType,
    content: committedCustom.message.content,
    display: false,
    details: committedCustom.message.details,
    durableQueueId: getDurableMessageId(committedCustom.message),
});
writeFileSync(sessionFile, manager.entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
reopened.dispose();

const afterAppendCrash = new DurableMessageQueue(manager);
recovery = await afterAppendCrash.loadRecoverable();
assert.equal(recovery.records.length, 1, "committed records must reconcile before replay");
assert.equal(recovery.records[0].behavior, "followUp");
assert.equal(recordFiles(directory).length, 1);

writeFileSync(join(directory, "malformed.json"), "{broken", { mode: 0o600 });
writeFileSync(join(directory, ".interrupted.tmp"), "partial", { mode: 0o600 });
afterAppendCrash.dispose();
const malformedRecovery = await new DurableMessageQueue(manager).loadRecoverable();
assert.equal(malformedRecovery.invalidCount, 1);
assert.equal(malformedRecovery.records.length, 1);
assert.ok(readFileSync(join(directory, "malformed.json"), "utf8").startsWith("{broken"));

const tombstonedId = getDurableMessageId(malformedRecovery.records[0].message);
writeFileSync(join(directory, "interrupted.cancel.json"), JSON.stringify({
    version: 1,
    type: "cancel",
    sessionId: manager.getSessionId(),
    ids: [tombstonedId],
}));
const afterCanceledCrash = await new DurableMessageQueue(manager).loadRecoverable();
assert.equal(afterCanceledCrash.records.length, 0, "a durable cancellation intent must survive a crash");
assert.ok(!recordFiles(directory).some((name) => name === `${tombstonedId}.json`));

const scopedOwner = new DurableMessageQueue(manager);
const scopedMessage = scopedOwner.enqueue("steer", user("session-file scope"));
scopedOwner.dispose();
const copiedSessionFile = join(temporaryRoot, "copied-session.jsonl");
copyFileSync(sessionFile, copiedSessionFile);
const copiedManager = new FakeSessionManager(manager.getSessionId(), copiedSessionFile);
copiedManager.entries = manager.entries.slice();
const copiedQueue = new DurableMessageQueue(copiedManager);
const copiedRecovery = await copiedQueue.loadRecoverable();
assert.equal(copiedRecovery.records.length, 0);
assert.equal(copiedRecovery.skippedScopeCount, 1, "a copied session ID must not steal the original queue");
copiedQueue.dispose();

const movedSessionFile = join(temporaryRoot, "moved-session.jsonl");
renameSync(sessionFile, movedSessionFile);
const movedManager = new FakeSessionManager(manager.getSessionId(), movedSessionFile);
movedManager.entries = manager.entries.slice();
const movedQueue = new DurableMessageQueue(movedManager);
const movedRecovery = await movedQueue.loadRecoverable();
assert.equal(getDurableMessageId(movedRecovery.records[0].message), getDurableMessageId(scopedMessage));
assert.equal(movedQueue.discardMessages([movedRecovery.records[0].message]), 0);
movedQueue.dispose();

const branchManager = new FakeSessionManager(manager.getSessionId(), movedSessionFile);
branchManager.entries = manager.entries.slice();
branchManager.leaf = "active-branch-anchor";
branchManager.entries.push({ type: "custom", id: branchManager.leaf });
const branchOwner = new DurableMessageQueue(branchManager);
branchOwner.enqueue("followUp", user("branch scope"));
branchOwner.dispose();
const otherBranch = new FakeSessionManager(manager.getSessionId(), movedSessionFile);
otherBranch.entries = manager.entries.slice();
const branchRecovery = await new DurableMessageQueue(otherBranch).loadRecoverable();
assert.equal(branchRecovery.records.length, 0);
assert.equal(branchRecovery.skippedScopeCount, 1, "pending input must remain on its active branch");

const noAssistantFile = join(temporaryRoot, "no-assistant.jsonl");
const noAssistantManager = new FakeSessionManager(
    "00000000-0000-0000-0000-000000000003",
    noAssistantFile,
);
const noAssistantQueue = new DurableMessageQueue(noAssistantManager);
const committedWithoutAssistant = noAssistantQueue.enqueue("followUp", user("commit before first assistant"));
const committedWithoutAssistantId = getDurableMessageId(committedWithoutAssistant);
noAssistantManager.entries = [{
    type: "message",
    id: "queued-user-entry",
    message: committedWithoutAssistant,
}];
writeFileSync(noAssistantFile, `${JSON.stringify(noAssistantManager.entries[0])}\n`);
noAssistantQueue.reconcileCommitted(committedWithoutAssistantId);
assert.equal(hasRecord(committedWithoutAssistantId), false, "a committed queue item must be acknowledged without an assistant entry");
noAssistantQueue.dispose();

const staleFile = join(temporaryRoot, "stale-manager.jsonl");
const staleOwnerManager = new FakeSessionManager(
    "00000000-0000-0000-0000-000000000004",
    staleFile,
);
const staleOwner = new DurableMessageQueue(staleOwnerManager);
const externallyCommitted = staleOwner.enqueue("steer", user(`committed by another manager\u2028${"x".repeat(150_000)}`));
const externallyCommittedId = getDurableMessageId(externallyCommitted);
staleOwner.dispose();
writeFileSync(staleFile, `${JSON.stringify({ type: "message", id: "external", message: externallyCommitted })}\n`);
const staleReader = new FakeSessionManager(staleOwnerManager.getSessionId(), staleFile);
assert.equal((await new DurableMessageQueue(staleReader).loadRecoverable()).records.length, 0);
assert.equal(hasRecord(externallyCommittedId), false, "physical JSONL must override a stale in-memory manager");

const tornFile = join(temporaryRoot, "torn-manager.jsonl");
const tornOwnerManager = new FakeSessionManager(
    "00000000-0000-0000-0000-000000000005",
    tornFile,
);
const tornOwner = new DurableMessageQueue(tornOwnerManager);
const absentFromDisk = tornOwner.enqueue("followUp", user("memory-only append"));
tornOwner.dispose();
writeFileSync(tornFile, `${JSON.stringify({ type: "session", id: tornOwnerManager.getSessionId() })}\n`);
const staleMemoryReader = new FakeSessionManager(tornOwnerManager.getSessionId(), tornFile);
staleMemoryReader.entries = [{ type: "message", id: "memory-only", message: absentFromDisk }];
const tornRecovery = await new DurableMessageQueue(staleMemoryReader).loadRecoverable();
assert.equal(tornRecovery.records.length, 1, "an in-memory-only or torn append must not acknowledge queued input");

const otherManager = new FakeSessionManager(
    "00000000-0000-0000-0000-000000000002",
    join(temporaryRoot, "other.jsonl"),
);
const isolated = new DurableMessageQueue(otherManager);
assert.equal((await isolated.loadRecoverable()).records.length, 0, "another session must never inherit pending input");
isolated.dispose();

rmSync(temporaryRoot, { recursive: true, force: true });
console.log("durable queue unit tests passed");

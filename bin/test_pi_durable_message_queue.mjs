#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
    copyFileSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const codingAgentRoot = process.env.PI_CODING_AGENT_ROOT
    ?? "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent";
const self = fileURLToPath(import.meta.url);
const CONTINUITY_TYPE = "durable-test-continuity";
const CONTINUITY_TEXT = "hidden steering continuity";
const NO_TRIGGER_TYPE = "durable-test-no-trigger";

function jsonLines(path) {
    return readFileSync(path, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
}

function contentText(content) {
    if (typeof content === "string") return content;
    return content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
}

function durableRecordFiles(agentDir) {
    const root = join(agentDir, "durable-message-queue");
    if (!existsSync(root)) return [];
    const files = [];
    for (const directory of readdirSync(root)) {
        if (directory.endsWith(".lock")) continue;
        const path = join(root, directory);
        for (const name of readdirSync(path)) {
            if (name.endsWith(".json")) files.push(join(path, name));
        }
    }
    return files;
}

async function createHarness(root, sessionFile, holdCall) {
    process.env.PI_CODING_AGENT_DIR = join(root, "agent");
    const cwd = join(root, "cwd");
    const sessions = join(root, "sessions");
    const skillDirectory = join(root, "skills", "durable");
    const promptDirectory = join(root, "prompts");
    mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
    mkdirSync(cwd, { recursive: true });
    mkdirSync(sessions, { recursive: true });
    mkdirSync(skillDirectory, { recursive: true });
    mkdirSync(promptDirectory, { recursive: true });
    const skillFile = join(skillDirectory, "SKILL.md");
    const promptFile = join(promptDirectory, "durable-template.md");
    if (!existsSync(skillFile)) {
        writeFileSync(skillFile, "---\nname: durable\ndescription: durable test\n---\nSKILL BODY\n");
    }
    if (!existsSync(promptFile)) {
        writeFileSync(promptFile, "---\ndescription: durable template\n---\nTEMPLATE $ARGUMENTS\n");
    }

    const { Agent } = await import(`${codingAgentRoot}/node_modules/@earendil-works/pi-agent-core/dist/index.js`);
    const { createAssistantMessageEventStream } = await import(`${codingAgentRoot}/node_modules/@earendil-works/pi-ai/dist/index.js`);
    const { AgentSession } = await import(`${codingAgentRoot}/dist/core/agent-session.js`);
    const { createEventBus } = await import(`${codingAgentRoot}/dist/core/event-bus.js`);
    const {
        createExtensionRuntime,
        loadExtensionFromFactory,
    } = await import(`${codingAgentRoot}/dist/core/extensions/loader.js`);
    const { loadPromptTemplates } = await import(`${codingAgentRoot}/dist/core/prompt-templates.js`);
    const { SessionManager } = await import(`${codingAgentRoot}/dist/core/session-manager.js`);
    const { loadSkills } = await import(`${codingAgentRoot}/dist/core/skills.js`);
    const { SettingsManager } = await import(`${codingAgentRoot}/dist/core/settings-manager.js`);

    const sessionManager = sessionFile
        ? SessionManager.open(sessionFile, sessions)
        : SessionManager.create(cwd, sessions);
    const model = {
        id: "durable-fake",
        name: "durable-fake",
        api: "durable-fake",
        provider: "durable-fake",
        baseUrl: "",
        reasoning: false,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 100_000,
        maxTokens: 1_000,
    };
    const usage = {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
    let providerCalls = 0;
    let heldStartedResolve;
    let heldRelease;
    const heldStarted = new Promise((resolve) => { heldStartedResolve = resolve; });
    const heldGate = new Promise((resolve) => { heldRelease = resolve; });
    function streamFn(activeModel) {
        providerCalls++;
        const call = providerCalls;
        const stream = createAssistantMessageEventStream();
        queueMicrotask(async () => {
            const partial = {
                role: "assistant",
                content: [],
                api: activeModel.api,
                provider: activeModel.provider,
                model: activeModel.id,
                usage: { ...usage },
                stopReason: "stop",
                timestamp: Date.now(),
            };
            stream.push({ type: "start", partial });
            if (call === holdCall) {
                heldStartedResolve();
                await heldGate;
            }
            stream.push({
                type: "done",
                reason: "stop",
                message: {
                    ...partial,
                    content: [{ type: "text", text: `fake answer ${call}` }],
                    timestamp: Date.now(),
                },
            });
        });
        return stream;
    }

    const runtime = createExtensionRuntime();
    const extension = await loadExtensionFromFactory((pi) => {
        pi.on("input", (event) => {
            if (event.streamingBehavior === "steer") {
                pi.sendMessage({
                    customType: CONTINUITY_TYPE,
                    content: CONTINUITY_TEXT,
                    display: false,
                    details: { source: "continuity-test" },
                }, { deliverAs: "steer" });
            }
            if (event.text === "transform me") {
                return { action: "transform", text: "transformed final", images: event.images };
            }
            return { action: "continue" };
        });
        pi.registerCommand("append-hidden", {
            description: "Append hidden context without triggering another turn",
            handler: async () => {
                pi.sendMessage({
                    customType: NO_TRIGGER_TYPE,
                    content: "hidden context",
                    display: false,
                }, { deliverAs: "steer", triggerTurn: false });
            },
        });
    }, cwd, createEventBus(), runtime, "<durable-test>");
    const skills = loadSkills({
        cwd,
        agentDir: process.env.PI_CODING_AGENT_DIR,
        skillPaths: [skillDirectory],
        includeDefaults: false,
    });
    const prompts = loadPromptTemplates({
        cwd,
        agentDir: process.env.PI_CODING_AGENT_DIR,
        promptPaths: [promptDirectory],
        includeDefaults: false,
    });
    const resourceLoader = {
        getExtensions: () => ({ extensions: [extension], errors: [], runtime }),
        getSkills: () => skills,
        getPrompts: () => ({ prompts, diagnostics: [] }),
        getThemes: () => ({ themes: [], diagnostics: [] }),
        getAgentsFiles: () => ({ agentsFiles: [] }),
        getSystemPrompt: () => "durable test",
        getAppendSystemPrompt: () => [],
        extendResources: () => {},
        reload: async () => {},
    };
    const modelRuntime = {
        hasConfiguredAuth: () => true,
        checkAuth: async () => ({ source: "runtime" }),
        getAuth: async () => ({ auth: { apiKey: "fake" } }),
        isUsingOAuth: () => false,
        getModel: (provider, id) => provider === model.provider && id === model.id ? model : undefined,
        getModels: () => [model],
        getAvailableSnapshot: () => [model],
        getProvider: () => undefined,
        getProviderAuthStatus: () => undefined,
        getCompatibilityRequestConfig: () => ({}),
        getRegisteredProviderIds: () => [],
        getError: () => undefined,
    };
    const steeringMode = process.env.DURABLE_STEERING_MODE ?? "all";
    const followUpMode = process.env.DURABLE_FOLLOW_UP_MODE ?? "all";
    const settingsManager = SettingsManager.inMemory({
        steeringMode,
        followUpMode,
        compaction: { enabled: false },
        retry: { enabled: false },
    });
    const agent = new Agent({
        initialState: {
            systemPrompt: "durable test",
            model,
            thinkingLevel: "off",
            tools: [],
            messages: sessionManager.buildSessionContext().messages,
        },
        streamFn,
        getApiKey: () => "fake",
        steeringMode,
        followUpMode,
    });
    const session = new AgentSession({
        agent,
        sessionManager,
        settingsManager,
        cwd,
        resourceLoader,
        modelRuntime,
        customTools: [],
        initialActiveToolNames: [],
    });
    session.syncQueueModesFromSettings();
    return {
        agentDir: process.env.PI_CODING_AGENT_DIR,
        heldStarted,
        releaseHeld: heldRelease,
        session,
        sessionManager,
        get providerCalls() { return providerCalls; },
    };
}

async function childMain(mode) {
    const root = process.env.DURABLE_TEST_ROOT;
    assert.ok(root);
    if (mode === "queue-crash" || mode === "queue-graceful" || mode === "cancel"
        || mode === "queue-first-turn-crash" || mode === "queue-one-at-a-time") {
        const firstTurn = mode === "queue-first-turn-crash";
        const harness = await createHarness(root, undefined, firstTurn ? 1 : 2);
        await harness.session.bindExtensions({ mode: "rpc" });
        if (!firstTurn) await harness.session.prompt("seed");
        const active = harness.session.prompt("long running turn");
        await harness.heldStarted;
        if (mode === "queue-crash") {
            await harness.session.prompt("/durable-template queued", { streamingBehavior: "followUp" });
            await harness.session.prompt("/skill:durable skill-arg", { streamingBehavior: "steer" });
            await harness.session.prompt("duplicate", { streamingBehavior: "steer" });
            await harness.session.prompt("duplicate", { streamingBehavior: "followUp" });
            await harness.session.prompt("transform me", {
                streamingBehavior: "steer",
                images: [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }],
            });
        }
        else if (mode === "queue-one-at-a-time") {
            await harness.session.steer("first one-at-a-time steering");
            await harness.session.steer("second one-at-a-time steering");
        }
        else {
            await harness.session.prompt(
                firstTurn ? "survive the first-turn crash" : "survive graceful shutdown",
                { streamingBehavior: "followUp" },
            );
        }
        if (mode === "cancel") {
            const cleared = harness.session.clearQueue();
            assert.deepEqual(cleared, { steering: [], followUp: ["survive graceful shutdown"] });
            assert.equal(durableRecordFiles(harness.agentDir).length, 0);
            harness.session.dispose();
            console.log(JSON.stringify({ ok: true }));
            process.exit(0);
        }
        const result = {
            agentDir: harness.agentDir,
            entries: harness.sessionManager.getEntries().length,
            queueFiles: durableRecordFiles(harness.agentDir).length,
            sessionFile: harness.sessionManager.getSessionFile(),
            sessionId: harness.sessionManager.getSessionId(),
        };
        if (mode === "queue-graceful") harness.session.dispose();
        console.log(JSON.stringify(result));
        if (mode === "queue-graceful") process.exit(0);
        const keepAlive = setInterval(() => {}, 60_000);
        await active;
        clearInterval(keepAlive);
        return;
    }

    if (mode === "no-trigger") {
        const harness = await createHarness(root, undefined, 2);
        await harness.session.bindExtensions({ mode: "rpc" });
        await harness.session.prompt("seed");
        const active = harness.session.prompt("long running turn");
        await harness.heldStarted;
        const beforeEntries = harness.sessionManager.getEntries().length;
        await harness.session.prompt("/append-hidden");
        const added = harness.sessionManager.getEntries().slice(beforeEntries);
        const result = {
            addedEntries: added.length,
            customCount: added.filter((entry) => entry.type === "custom_message" && entry.customType === NO_TRIGGER_TYPE).length,
            providerCalls: harness.providerCalls,
            queueFiles: durableRecordFiles(harness.agentDir).length,
        };
        harness.releaseHeld();
        await active;
        harness.session.dispose();
        console.log(JSON.stringify(result));
        return;
    }

    const sessionFile = process.env.DURABLE_SESSION_FILE;
    assert.ok(sessionFile);
    const harness = await createHarness(root, sessionFile, mode === "recover-mid-crash" ? 1 : -1);
    if (mode === "recover-mid-crash") {
        harness.session._durableMessageQueue.reconcileCommitted = () => {};
    }
    if (mode === "branch-probe") {
        harness.sessionManager.branch(process.env.DURABLE_BRANCH_ID);
        harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
    }
    const beforeEntries = harness.sessionManager.getEntries().length;
    await harness.session.bindExtensions({ mode: "rpc" });
    if (mode === "recover-mid-crash") {
        await harness.heldStarted;
        console.log(JSON.stringify({
            addedEntries: harness.sessionManager.getEntries().length - beforeEntries,
            providerCalls: harness.providerCalls,
            queueFiles: durableRecordFiles(harness.agentDir).length,
        }));
        const keepAlive = setInterval(() => {}, 60_000);
        await new Promise(() => {});
        clearInterval(keepAlive);
        return;
    }
    if (mode === "recover-with-prompt") {
        await harness.session.prompt("ordinary prompt after recovery");
    }
    else {
        await harness.session.waitForIdle();
    }
    const result = {
        addedEntries: harness.sessionManager.getEntries().length - beforeEntries,
        providerCalls: harness.providerCalls,
        queueFiles: durableRecordFiles(harness.agentDir).length,
    };
    harness.session.dispose();
    console.log(JSON.stringify(result));
}

function runChild(mode, env, waitForLine = false) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [self, mode], {
            env: { ...process.env, ...env },
            stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        let resolvedLine = false;
        child.stdout.on("data", (chunk) => {
            stdout += chunk;
            if (waitForLine && !resolvedLine && stdout.includes("\n")) {
                resolvedLine = true;
                resolve({ child, value: JSON.parse(stdout.slice(0, stdout.indexOf("\n"))) });
            }
        });
        child.stderr.on("data", (chunk) => { stderr += chunk; });
        child.on("error", reject);
        child.on("close", (code, signal) => {
            if (waitForLine && resolvedLine) return;
            if (code !== 0) {
                reject(new Error(`${mode} failed (${signal ?? code}): ${stderr}${stdout}`));
                return;
            }
            try {
                resolve({ child, value: JSON.parse(stdout.trim()) });
            }
            catch (error) {
                reject(new Error(`${mode} returned invalid output: ${stdout}\n${stderr}`, { cause: error }));
            }
        });
    });
}

async function parentMain() {
    const noTriggerRoot = mkdtempSync("/tmp/pi-durable-no-trigger-");
    const noTrigger = await runChild("no-trigger", { DURABLE_TEST_ROOT: noTriggerRoot });
    assert.deepEqual(noTrigger.value, {
        addedEntries: 1,
        customCount: 1,
        providerCalls: 2,
        queueFiles: 0,
    }, "triggerTurn:false must append immediately without entering either durable queue");

    const root = mkdtempSync("/tmp/pi-durable-integration-");
    const queued = await runChild("queue-crash", { DURABLE_TEST_ROOT: root }, true);
    assert.equal(queued.value.queueFiles, 8);

    const liveProbe = await runChild("recover", {
        DURABLE_TEST_ROOT: root,
        DURABLE_SESSION_FILE: queued.value.sessionFile,
    });
    assert.deepEqual(
        { addedEntries: liveProbe.value.addedEntries, providerCalls: liveProbe.value.providerCalls },
        { addedEntries: 0, providerCalls: 0 },
        "a second live process must not steal queued input",
    );
    assert.equal(liveProbe.value.queueFiles, 8);

    queued.child.kill("SIGKILL");
    await new Promise((resolve) => queued.child.once("close", resolve));

    const copiedSession = join(root, "copied-session.jsonl");
    copyFileSync(queued.value.sessionFile, copiedSession);
    const copiedProbe = await runChild("recover", {
        DURABLE_TEST_ROOT: root,
        DURABLE_SESSION_FILE: copiedSession,
    });
    assert.deepEqual(
        { addedEntries: copiedProbe.value.addedEntries, providerCalls: copiedProbe.value.providerCalls },
        { addedEntries: 0, providerCalls: 0 },
        "a copied JSONL with the same session ID must not claim the original queue",
    );

    const preCrashEntries = jsonLines(queued.value.sessionFile).slice(1);
    const earlierAssistant = preCrashEntries.find((entry) => entry.type === "message" && entry.message.role === "assistant");
    assert.ok(earlierAssistant);
    const branchProbe = await runChild("branch-probe", {
        DURABLE_TEST_ROOT: root,
        DURABLE_SESSION_FILE: queued.value.sessionFile,
        DURABLE_BRANCH_ID: earlierAssistant.id,
    });
    assert.deepEqual(
        { addedEntries: branchProbe.value.addedEntries, providerCalls: branchProbe.value.providerCalls },
        { addedEntries: 0, providerCalls: 0 },
        "pending input must remain anchored to its original branch",
    );

    const midDelivery = await runChild("recover-mid-crash", {
        DURABLE_TEST_ROOT: root,
        DURABLE_SESSION_FILE: queued.value.sessionFile,
    }, true);
    assert.equal(midDelivery.value.providerCalls, 1);
    assert.equal(midDelivery.value.addedEntries, 6);
    assert.equal(midDelivery.value.queueFiles, 8, "the append-before-ack crash window must retain queue copies");
    midDelivery.child.kill("SIGKILL");
    await new Promise((resolve) => midDelivery.child.once("close", resolve));

    const reconciled = await runChild("recover", {
        DURABLE_TEST_ROOT: root,
        DURABLE_SESSION_FILE: queued.value.sessionFile,
    });
    assert.deepEqual(reconciled.value, { addedEntries: 3, providerCalls: 1, queueFiles: 0 });

    const entries = jsonLines(queued.value.sessionFile).slice(1);
    const added = entries.slice(queued.value.entries);
    const reminders = added.filter((entry) => entry.type === "custom_message" && entry.customType === CONTINUITY_TYPE);
    assert.equal(reminders.length, 3, "steering continuity reminders must be recovered exactly once");
    assert.ok(reminders.every((entry) => entry.details?.source === "continuity-test"));
    const queuedUsers = added.filter((entry) => entry.type === "message" && entry.message.role === "user");
    assert.equal(queuedUsers.length, 5);
    const texts = queuedUsers.map((entry) => contentText(entry.message.content));
    assert.ok(texts[0].includes("<skill name=\"durable\""));
    assert.ok(texts[0].includes("SKILL BODY"));
    assert.ok(texts[0].endsWith("skill-arg"));
    assert.equal(texts[1], "duplicate");
    assert.equal(texts[2], "transformed final");
    assert.equal(texts[3], "TEMPLATE queued");
    assert.equal(texts[4], "duplicate");
    const transformed = queuedUsers.find((entry) => contentText(entry.message.content) === "transformed final");
    assert.deepEqual(
        transformed.message.content.find((part) => part.type === "image"),
        { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
    );
    const durableIds = [
        ...reminders.map((entry) => entry.durableQueueId),
        ...queuedUsers.map((entry) => entry.message.__piDurableQueueId),
    ];
    assert.equal(durableIds.filter(Boolean).length, 8);
    assert.equal(new Set(durableIds).size, 8, "identical text must retain distinct durable identities");

    const noReplay = await runChild("recover", {
        DURABLE_TEST_ROOT: root,
        DURABLE_SESSION_FILE: queued.value.sessionFile,
    });
    assert.deepEqual(noReplay.value, { addedEntries: 0, providerCalls: 0, queueFiles: 0 });
    assert.equal(jsonLines(queued.value.sessionFile).length - 1, entries.length, "committed messages must not replay");

    const gracefulRoot = mkdtempSync("/tmp/pi-durable-graceful-");
    const graceful = await runChild("queue-graceful", { DURABLE_TEST_ROOT: gracefulRoot });
    assert.equal(graceful.value.queueFiles, 1);
    const gracefulRecovery = await runChild("recover-with-prompt", {
        DURABLE_TEST_ROOT: gracefulRoot,
        DURABLE_SESSION_FILE: graceful.value.sessionFile,
    });
    assert.equal(gracefulRecovery.value.providerCalls, 2, "an ordinary startup prompt must wait for recovery, then run");
    assert.equal(gracefulRecovery.value.queueFiles, 0);

    const cancelRoot = mkdtempSync("/tmp/pi-durable-cancel-");
    const canceled = await runChild("cancel", { DURABLE_TEST_ROOT: cancelRoot });
    assert.equal(canceled.value.ok, true);

    const firstTurnRoot = mkdtempSync("/tmp/pi-durable-first-turn-");
    const firstTurn = await runChild("queue-first-turn-crash", { DURABLE_TEST_ROOT: firstTurnRoot }, true);
    assert.equal(firstTurn.value.queueFiles, 1);
    assert.ok(existsSync(firstTurn.value.sessionFile), "queue acceptance must materialize a brand-new session JSONL");
    assert.equal(jsonLines(firstTurn.value.sessionFile).length, 2, "the header and active user turn must be durable");
    firstTurn.child.kill("SIGKILL");
    await new Promise((resolve) => firstTurn.child.once("close", resolve));
    const firstTurnRecovery = await runChild("recover", {
        DURABLE_TEST_ROOT: firstTurnRoot,
        DURABLE_SESSION_FILE: firstTurn.value.sessionFile,
    });
    assert.deepEqual(firstTurnRecovery.value, { addedEntries: 2, providerCalls: 1, queueFiles: 0 });

    const oneAtATimeRoot = mkdtempSync("/tmp/pi-durable-one-at-a-time-");
    const oneAtATime = await runChild("queue-one-at-a-time", {
        DURABLE_TEST_ROOT: oneAtATimeRoot,
        DURABLE_STEERING_MODE: "one-at-a-time",
    }, true);
    assert.equal(oneAtATime.value.queueFiles, 2);
    oneAtATime.child.kill("SIGKILL");
    await new Promise((resolve) => oneAtATime.child.once("close", resolve));
    const oneAtATimeRecovery = await runChild("recover", {
        DURABLE_TEST_ROOT: oneAtATimeRoot,
        DURABLE_SESSION_FILE: oneAtATime.value.sessionFile,
        DURABLE_STEERING_MODE: "one-at-a-time",
    });
    assert.deepEqual(oneAtATimeRecovery.value, { addedEntries: 4, providerCalls: 2, queueFiles: 0 });

    for (const path of [noTriggerRoot, root, gracefulRoot, cancelRoot, firstTurnRoot, oneAtATimeRoot]) {
        rmSync(path, { recursive: true, force: true });
    }
    console.log("durable queue integration tests passed");
}

const mode = process.argv[2];
if (mode) {
    await childMain(mode);
}
else {
    await parentMain();
}

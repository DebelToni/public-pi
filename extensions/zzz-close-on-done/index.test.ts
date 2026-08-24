import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import test, { afterEach } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import closeOnDone from "./index.ts";

type Handler = (event: any, context: ExtensionContext) => unknown;
let serverSequence = 0;

afterEach(() => {
	delete (globalThis as typeof globalThis & { __piCloseOnDoneRuntimeStateV1?: unknown }).__piCloseOnDoneRuntimeStateV1;
});

function runTmux(server: string, args: string[]) {
	return execFileSync("tmux", ["-L", server, ...args], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
}

function hasSession(server: string, target: string) {
	return spawnSync("tmux", ["-L", server, "has-session", "-t", target], { stdio: "ignore" }).status === 0;
}

function createServer(sessionName = "source") {
	const server = `pi-close-on-done-test-${process.pid}-${++serverSequence}`;
	runTmux(server, ["-f", "/dev/null", "new-session", "-d", "-s", sessionName, "-n", "work", "exec /bin/sleep 300"]);
	runTmux(server, ["set-window-option", "-g", "remain-on-exit", "on"]);
	runTmux(server, ["new-window", "-d", "-t", `${sessionName}:`, "-n", "stay", "exec /bin/sleep 300"]);
	const pane = runTmux(server, ["display-message", "-t", `${sessionName}:work`, "-p", "#{pane_id}"]);
	const socket = runTmux(server, ["display-message", "-p", "#{socket_path}"]);
	const pid = runTmux(server, ["display-message", "-p", "#{pid}"]);
	return { server, pane, sessionName, tmuxEnvironment: `${socket},${pid},0` };
}

function extensionHarness() {
	const commands = new Map<string, any>();
	const handlers = new Map<string, Handler[]>();
	const pi = {
		registerCommand(name: string, command: any) { commands.set(name, command); },
		on(event: string, handler: Handler) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
	} as unknown as ExtensionAPI;
	closeOnDone(pi);
	return {
		command: commands.get("close-on-done"),
		async emit(event: string, value: any, context: ExtensionContext) {
			for (const handler of handlers.get(event) ?? []) await handler({ type: event, ...value }, context);
		},
	};
}

function bSession(server: string) {
	if (!hasSession(server, "B")) return undefined;
	return {
		id: runTmux(server, ["display-message", "-t", "B:", "-p", "#{session_id}"]),
		windows: runTmux(server, ["list-windows", "-t", "B", "-F", "#{window_name}|#{window_id}"])
			.split("\n").filter(Boolean).map((line) => line.split("|")),
	};
}

async function waitFor(predicate: () => boolean, message: string) {
	const deadline = Date.now() + 2000;
	while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
	assert.ok(predicate(), message);
}

function assistant(stopReason: string) {
	return { role: "assistant", content: [], stopReason };
}

function setupContext() {
	let idle = false;
	const notices: Array<{ message: string; level: string }> = [];
	const statuses: Array<string | undefined> = [];
	const context = {
		mode: "tui",
		isIdle: () => idle,
		ui: {
			notify(message: string, level: string) { notices.push({ message, level }); },
			setStatus(_key: string, value?: string) { statuses.push(value); },
		},
	} as unknown as ExtensionContext;
	return { context, notices, statuses, setIdle(value: boolean) { idle = value; } };
}

async function withServer(
	sessionName: string,
	run: (isolated: ReturnType<typeof createServer>, harness: ReturnType<typeof extensionHarness>) => Promise<void>,
) {
	const isolated = createServer(sessionName);
	const previousTmux = process.env.TMUX;
	const previousPane = process.env.TMUX_PANE;
	process.env.TMUX = isolated.tmuxEnvironment;
	process.env.TMUX_PANE = isolated.pane;
	const harness = extensionHarness();
	try {
		await run(isolated, harness);
	} finally {
		spawnSync("tmux", ["-L", isolated.server, "kill-server"], { stdio: "ignore" });
		if (previousTmux === undefined) delete process.env.TMUX;
		else process.env.TMUX = previousTmux;
		if (previousPane === undefined) delete process.env.TMUX_PANE;
		else process.env.TMUX_PANE = previousPane;
	}
}

test("creates B, parks there, and closes only after a successful final response", async () => {
	await withServer("source", async (isolated, harness) => {
		const state = setupContext();
		state.setIdle(true);
		await harness.command.handler("", state.context);
		assert.match(state.notices.at(-1)?.message ?? "", /Send the final task first/);
		assert.equal(bSession(isolated.server), undefined);

		state.setIdle(false);
		await harness.command.handler("", state.context);
		const parking = bSession(isolated.server);
		assert.ok(parking);
		assert.equal(runTmux(isolated.server, ["display-message", "-t", isolated.pane, "-p", "#{session_name}"]), "B");
		assert.deepEqual(runTmux(isolated.server, ["list-windows", "-t", "source", "-F", "#{window_name}"]).split("\n"), ["stay"]);
		assert.equal(state.statuses.at(-1), "closes after final response");
		assert.equal(state.notices.at(-1)?.message, "Parked in tmux session B.");

		await harness.emit("agent_end", { messages: [assistant("error")] }, state.context);
		state.setIdle(true);
		await harness.emit("agent_settled", {}, state.context);
		assert.equal(hasSession(isolated.server, "B"), true);

		await harness.emit("session_shutdown", { reason: "reload" }, state.context);
		const reloaded = extensionHarness();
		await reloaded.emit("session_start", { reason: "reload" }, state.context);
		state.setIdle(false);
		await reloaded.emit("agent_start", {}, state.context);
		await reloaded.emit("agent_end", { messages: [assistant("stop")] }, state.context);
		state.setIdle(true);
		await reloaded.emit("agent_settled", {}, state.context);
		await waitFor(() => !hasSession(isolated.server, "B"), "B survived after its only parked window closed");
		assert.equal(hasSession(isolated.server, "source"), true);
	});
});

test("reuses an existing B session and leaves its other windows intact", async () => {
	await withServer("source", async (isolated, harness) => {
		runTmux(isolated.server, ["new-session", "-d", "-s", "B", "-n", "keep", "exec /bin/sleep 300"]);
		const state = setupContext();
		await harness.command.handler("", state.context);
		assert.deepEqual(bSession(isolated.server)?.windows.map(([name]) => name).sort(), ["keep", "work"]);

		await harness.emit("agent_end", { messages: [assistant("stop")] }, state.context);
		state.setIdle(true);
		await harness.emit("agent_settled", {}, state.context);
		await waitFor(
			() => bSession(isolated.server)?.windows.map(([name]) => name).join(",") === "keep",
			"parked window survived in existing B",
		);
		assert.equal(hasSession(isolated.server, "B"), true);
	});
});

test("works when the Pi window already lives in B", async () => {
	await withServer("B", async (isolated, harness) => {
		const state = setupContext();
		const sourceWindow = runTmux(isolated.server, ["display-message", "-t", isolated.pane, "-p", "#{window_id}"]);
		await harness.command.handler("", state.context);
		assert.equal(runTmux(isolated.server, ["display-message", "-t", isolated.pane, "-p", "#{session_name}"]), "B");

		await harness.emit("agent_end", { messages: [assistant("stop")] }, state.context);
		state.setIdle(true);
		await harness.emit("agent_settled", {}, state.context);
		await waitFor(
			() => !runTmux(isolated.server, ["list-windows", "-t", "B", "-F", "#{window_id}"]).split("\n").includes(sourceWindow),
			"window already in B survived settlement",
		);
		assert.equal(hasSession(isolated.server, "B"), true);
		assert.equal(runTmux(isolated.server, ["list-windows", "-t", "B", "-F", "#{window_name}"]), "stay");
	});
});

test("refuses a window linked into another session", async () => {
	await withServer("source", async (isolated, harness) => {
		const state = setupContext();
		runTmux(isolated.server, ["new-session", "-d", "-s", "linked", "-n", "base", "exec /bin/sleep 300"]);
		const windowId = runTmux(isolated.server, ["display-message", "-t", isolated.pane, "-p", "#{window_id}"]);
		runTmux(isolated.server, ["link-window", "-a", "-d", "-s", windowId, "-t", "linked:base"]);
		await harness.command.handler("", state.context);
		assert.match(state.notices.at(-1)?.message ?? "", /linked into more than one tmux session/);
		assert.equal(bSession(isolated.server), undefined);
	});
});

test("leaves the parked window open if its Pi pane moves before settlement", async () => {
	await withServer("source", async (isolated, harness) => {
		const state = setupContext();
		runTmux(isolated.server, ["split-window", "-d", "-t", "source:work", "exec /bin/sleep 300"]);
		await harness.command.handler("", state.context);
		const parkedWindow = runTmux(isolated.server, ["display-message", "-t", isolated.pane, "-p", "#{window_id}"]);
		runTmux(isolated.server, ["new-session", "-d", "-s", "rescue", "-n", "base", "exec /bin/sleep 300"]);
		runTmux(isolated.server, ["move-pane", "-d", "-s", isolated.pane, "-t", "rescue:base"]);

		await harness.emit("agent_end", { messages: [assistant("stop")] }, state.context);
		state.setIdle(true);
		await harness.emit("agent_settled", {}, state.context);
		assert.equal(hasSession(isolated.server, "B"), true);
		assert.ok(bSession(isolated.server)?.windows.some(([, id]) => id === parkedWindow));
		assert.equal(runTmux(isolated.server, ["display-message", "-t", isolated.pane, "-p", "#{session_name}"]), "rescue");
		assert.match(state.notices.at(-1)?.message ?? "", /Pi pane or parked window moved/);
	});
});

test("removes only B's winlink if the parked window is later linked elsewhere", async () => {
	await withServer("source", async (isolated, harness) => {
		const state = setupContext();
		await harness.command.handler("", state.context);
		const windowId = runTmux(isolated.server, ["display-message", "-t", isolated.pane, "-p", "#{window_id}"]);
		runTmux(isolated.server, ["new-session", "-d", "-s", "rescue", "-n", "base", "exec /bin/sleep 300"]);
		runTmux(isolated.server, ["link-window", "-a", "-d", "-s", windowId, "-t", "rescue:base"]);

		await harness.emit("agent_end", { messages: [assistant("stop")] }, state.context);
		state.setIdle(true);
		await harness.emit("agent_settled", {}, state.context);
		await waitFor(() => !hasSession(isolated.server, "B"), "B winlink survived linked-window cleanup");
		assert.equal(runTmux(isolated.server, ["display-message", "-t", `rescue:${windowId}`, "-p", "#{window_id}"]), windowId);
	});
});

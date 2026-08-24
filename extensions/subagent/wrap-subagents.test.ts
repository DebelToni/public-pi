import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { runSingleAgent } from "./index.ts";
import {
	installSubagentWrapSupport,
	registerActiveSubagent,
	requestActiveSubagentsWrap,
	WRAP_SUBAGENT_MESSAGE,
} from "./wrap-subagents.ts";

function wait(milliseconds: number) {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

test("/wrap-subagents steers active children but never starts an idle child", async (t) => {
	const previousSubagent = process.env.PI_SUBAGENT;
	process.env.PI_SUBAGENT = "1";
	t.after(() => {
		if (previousSubagent === undefined) delete process.env.PI_SUBAGENT;
		else process.env.PI_SUBAGENT = previousSubagent;
	});

	const commands = new Map<string, any>();
	const handlers = new Map<string, any[]>();
	const sent: Array<{ message: string; options: unknown }> = [];
	const notices: Array<[string, string]> = [];
	let idle = false;
	let failNextDelivery = true;
	const pi = {
		registerCommand(name: string, command: any) { commands.set(name, command); },
		on(event: string, handler: any) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		sendUserMessage(message: string, options: unknown) {
			if (failNextDelivery) {
				failNextDelivery = false;
				throw new Error("transient delivery failure");
			}
			sent.push({ message, options });
		},
	} as unknown as ExtensionAPI;
	installSubagentWrapSupport(pi);

	const childContext = { isIdle: () => idle };
	for (const handler of handlers.get("session_start") ?? []) handler({}, childContext);
	const release = registerActiveSubagent(() => process.emit("SIGUSR2"));
	t.after(release);

	await commands.get("wrap-subagents").handler("", {
		ui: { notify: (message: string, level: string) => notices.push([message, level]) },
	});
	await wait(150);
	assert.deepEqual(sent, [{ message: WRAP_SUBAGENT_MESSAGE, options: { deliverAs: "steer" } }]);
	assert.deepEqual(notices[0], ["Asked 1 active subagent to wrap up.", "info"]);

	idle = true;
	await commands.get("wrap-subagents").handler("", {
		ui: { notify: (message: string, level: string) => notices.push([message, level]) },
	});
	assert.equal(sent.length, 1, "an idle child must ignore the signal instead of starting a new turn");

	release();
	await commands.get("wrap-subagents").handler("", {
		ui: { notify: (message: string, level: string) => notices.push([message, level]) },
	});
	assert.deepEqual(notices.at(-1), ["No active subagents to wrap up.", "info"]);
	for (const handler of handlers.get("session_shutdown") ?? []) handler({}, childContext);
});

test("runSingleAgent exposes a started child to the wrap signal", async (t) => {
	const root = mkdtempSync("/tmp/pi-wrap-spawn-");
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const child = join(root, "child.mjs");
	const agentStartedMarker = join(root, "agent-started");
	writeFileSync(child, `
import { writeFileSync } from "node:fs";
const agentStartedMarker = process.argv[2];
const message = {
  role: "assistant",
  content: [{ type: "text", text: ${JSON.stringify(WRAP_SUBAGENT_MESSAGE)} }],
  api: "fake",
  provider: "fake",
  model: "fake",
  usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } },
  stopReason: "stop",
  timestamp: Date.now()
};
process.on("SIGUSR2", () => {
  process.stdout.write(JSON.stringify({ type: "message_end", message }) + "\\n", () => process.exit(0));
});
setTimeout(() => {
  writeFileSync(agentStartedMarker, "");
  process.stdout.write(JSON.stringify({ type: "agent_start" }) + "\\n");
}, 200);
setTimeout(() => process.exit(2), 5000);
`);
	const agent = {
		name: "test-agent",
		description: "test",
		systemPrompt: "",
		source: "user" as const,
		filePath: child,
	};
	const running = runSingleAgent(
		root,
		[agent],
		agent.name,
		"wait for wrap",
		undefined,
		"none",
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		(results) => ({ mode: "single", agentScope: "user", projectAgentsDir: null, results }),
		{
			runsRoot: join(root, "runs"),
			invocation: (args) => ({ command: process.execPath, args: [child, agentStartedMarker, ...args] }),
		},
	);
	let dispatched = false;
	for (let attempt = 0; attempt < 100; attempt++) {
		const result = requestActiveSubagentsWrap();
		if (result.sent === 1) {
			dispatched = true;
			break;
		}
		await wait(10);
	}
	assert.equal(dispatched, true);
	assert.equal(existsSync(agentStartedMarker), false, "a startup wrap request must be retained before agent_start");
	const result = await running;
	assert.equal(result.exitCode, 0);
	assert.equal((result.messages.at(-1)?.content[0] as any).text, WRAP_SUBAGENT_MESSAGE);
});

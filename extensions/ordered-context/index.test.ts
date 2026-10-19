import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("reading MEMORY adds the current session ID to the tool result, not the file or startup context", async () => {
	const agentDir = mkdtempSync(join(tmpdir(), "ordered-context-session-id-"));
	const contextDir = join(agentDir, "CONTEXT");
	mkdirSync(contextDir);
	const memoryPath = join(contextDir, "4-MEMORY.md");
	writeFileSync(memoryPath, "# Memory\n\n- useful state");
	writeFileSync(join(contextDir, "3-USER.md"), "# User\n\n- user context");
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;

	try {
		const { default: orderedContext } = await import(`./index.ts?session-id=${Date.now()}`);
		const handlers = new Map<string, (...args: any[]) => any>();
		orderedContext({
			on(name: string, handler: (...args: any[]) => any) { handlers.set(name, handler); },
			registerCommand() {},
		} as any);
		const context = { cwd: agentDir, sessionManager: { getSessionId: () => "session-123" } };
		const prompt = await handlers.get("before_agent_start")?.({ systemPrompt: "base" }, context);
		assert.doesNotMatch(prompt.systemPrompt, /Your own session ID/);
		const read = { toolName: "read", input: { path: memoryPath }, content: [{ type: "text", text: "# Memory\n\n- useful state" }] };
		const result = await handlers.get("tool_result")?.(read, context);
		assert.deepEqual(result.content, [...read.content, { type: "text", text: "Your own session ID for input into memory if YOU in this session have the knowledge: session-123" }]);
		assert.equal(await handlers.get("tool_result")?.({ ...read, isError: true }, context), undefined);
		assert.equal(await handlers.get("tool_result")?.({ ...read, input: { path: join(contextDir, "3-USER.md") } }, context), undefined);
		assert.equal(readFileSync(memoryPath, "utf8"), "# Memory\n\n- useful state");
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(agentDir, { recursive: true, force: true });
	}
});

test("memory size reporting uses an 18 KiB budget and the existing 10% trim threshold", async () => {
	const agentDir = mkdtempSync(join(tmpdir(), "ordered-context-budget-"));
	const contextDir = join(agentDir, "CONTEXT");
	mkdirSync(contextDir);
	const memoryPath = join(contextDir, "4-MEMORY.md");
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;

	try {
		const { default: orderedContext } = await import(`./index.ts?budget=${Date.now()}`);
		const handlers = new Map<string, (...args: any[]) => any>();
		orderedContext({
			on(name: string, handler: (...args: any[]) => any) { handlers.set(name, handler); },
			registerCommand() {},
		} as any);
		const event = { toolName: "edit", input: { path: memoryPath }, content: [{ type: "text", text: "edited" }] };
		for (const sizeKiB of [13, 18, 19, 20]) {
			writeFileSync(memoryPath, "x ".repeat(sizeKiB * 512));
			const result = await handlers.get("tool_result")?.(event, { cwd: agentDir });
			assert.deepEqual(result.content[0], event.content[0]);
			const status = result.content[1].text;
			assert.ok(status.startsWith(`MEMORY.md: ${sizeKiB.toFixed(1)} KiB / 18 KiB.`), status);
			if (sizeKiB === 20) assert.match(status, /Trim ~1024 words\./);
			else assert.doesNotMatch(status, /Trim/);
		}
		assert.equal(await handlers.get("tool_result")?.({ ...event, isError: true }, { cwd: agentDir }), undefined);
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(agentDir, { recursive: true, force: true });
	}
});

test("missing CONTEXT directory is a clean no-op", async () => {
	const agentDir = mkdtempSync(join(tmpdir(), "ordered-context-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;

	try {
		const { default: orderedContext } = await import(`./index.ts?missing-context=${Date.now()}`);
		const handlers = new Map<string, (...args: any[]) => any>();
		let command: any;
		orderedContext({
			on(name: string, handler: (...args: any[]) => any) {
				handlers.set(name, handler);
			},
			registerCommand(name: string, definition: any) {
				if (name === "context-files") command = definition;
			},
		} as any);

		assert.equal(await handlers.get("before_agent_start")?.({ systemPrompt: "base" }), undefined);

		let notification: { message: string; level: string } | undefined;
		await command.handler("", {
			ui: {
				notify(message: string, level: string) {
					notification = { message, level };
				},
			},
		});
		assert.deepEqual(notification, {
			message: `No Markdown files in ${join(agentDir, "CONTEXT")}`,
			level: "warning",
		});
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(agentDir, { recursive: true, force: true });
	}
});

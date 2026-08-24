import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

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

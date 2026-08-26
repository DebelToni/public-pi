#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const root = process.env.PI_CODING_AGENT_ROOT;
if (!root) throw new Error("PI_CODING_AGENT_ROOT is required");
const sessionPath = join(root, "dist/core/agent-session.js");
const loaderPath = join(root, "dist/core/extensions/loader.js");
const typesPath = join(root, "dist/core/extensions/types.d.ts");
const { createExtensionRuntime, loadExtensionFromFactory } = await import(pathToFileURL(loaderPath).href);

const runtime = createExtensionRuntime();
let finish;
const coreRun = new Promise((resolve) => { finish = resolve; });
runtime.sendMessage = () => coreRun;
let exposedRun;
await loadExtensionFromFactory(
	(pi) => { exposedRun = pi.sendMessage({ customType: "awaitable-send-probe", content: "" }); },
	process.cwd(),
	{ on: () => () => {}, emit: () => {} },
	runtime,
);

assert.equal(exposedRun, coreRun, "the public ExtensionAPI wrapper discarded the core run promise");
let settled = false;
exposedRun.then(() => { settled = true; });
await Promise.resolve();
assert.equal(settled, false, "the public sendMessage promise settled before the core run");
finish();
await exposedRun;
assert.equal(settled, true);
assert.match(
	readFileSync(sessionPath, "utf8"),
	/Return the run promise so recovery can keep one-shot sessions alive\.[\s\S]*?sendMessage: \(message, options\) => this\.sendCustomMessage/,
);
assert.match(
	readFileSync(typesPath, "utf8"),
	/Send a custom message and resolve after any triggered agent run settles\.[\s\S]*?\): Promise<void>;/,
);
console.log("awaitable extension sendMessage wrapper verified");

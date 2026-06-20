import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const STATE_TYPE = "pi-engineering-principles-state";

const PRINCIPLES = `
1. Think Before Coding

Don't assume. Don't hide confusion. Surface tradeoffs.

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them; don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

2. Simplicity First

Minimum code that solves the problem. Nothing speculative.

- No features beyond what was asked.
- No abstractions for single-use code.
- No flexibility/configurability that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.
- Ask: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

3. Surgical Changes

Touch only what you must. Clean up only your own mess.

When editing existing code:
- Don't improve adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it; don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that your changes made unused.
- Don't remove pre-existing dead code unless asked.

Test: every changed line should trace directly to the user's request.

4. Goal-Driven Execution

Define success criteria. Loop until verified.

Transform tasks into verifiable goals:
- "Add validation" -> "Write tests for invalid inputs, then make them pass"
- "Fix the bug" -> "Write a test that reproduces it, then make it pass"
- "Refactor X" -> "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
1. [Step] -> verify: [check]
2. [Step] -> verify: [check]
3. [Step] -> verify: [check]

Strong success criteria let you loop independently. Weak criteria require clarification.

These guidelines are working if: fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.
`.trim();

let active = true;

function defaultActive() {
	try {
		const file = join(homedir(), ".pi", "agent", "settings.json");
		if (!existsSync(file)) return true;
		const settings = JSON.parse(readFileSync(file, "utf8"));
		const value = settings?.piCustom?.engineeringPrinciplesDefaultActive;
		return value === undefined ? true : !!value;
	} catch {
		return true;
	}
}

function persist(pi: ExtensionAPI) {
	pi.appendEntry(STATE_TYPE, { active });
}

function scrubOldPrinciplesMessages(ctx: ExtensionContext) {
	const sm: any = ctx.sessionManager;
	const entries: any[] | undefined = sm.fileEntries;
	if (!entries) return;
	let changed = false;
	for (const e of entries) {
		if (e.type !== "custom_message" || e.customType !== "principles") continue;
		e.type = "custom";
		e.data = { scrubbed: true, reason: "principles moved to before_agent_start system prompt" };
		delete e.content;
		delete e.display;
		delete e.details;
		changed = true;
	}
	if (!changed) return;
	const file = sm.getSessionFile?.();
	if (!file) return;
	writeFileSync(file, `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`, "utf8");
	sm.flushed = true;
}

function restore(ctx: ExtensionContext) {
	active = defaultActive();
	scrubOldPrinciplesMessages(ctx);
	for (const e of ctx.sessionManager.getBranch()) {
		if (e.type !== "custom" || e.customType !== STATE_TYPE) continue;
		active = !!(e.data as any)?.active;
	}
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => restore(ctx));

	pi.on("before_agent_start", async (event) => {
		if (!active) return;
		return {
			systemPrompt: `${event.systemPrompt}\n\n<system-reminder>\nEngineering execution principles are active for this session. Follow them when implementing or debugging:\n\n${PRINCIPLES}\n</system-reminder>`,
		};
	});

	pi.registerCommand("principles", {
		description: "Toggle engineering execution principles for this session. Usage: /principles, /principles off, /principles status",
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();
			if (arg === "off" || arg === "stop" || arg === "clear") {
				active = false;
				persist(pi);
				scrubOldPrinciplesMessages(ctx);
				ctx.ui.notify("Engineering principles off for this session", "info");
				return;
			}
			if (arg === "status") {
				ctx.ui.notify(active ? "Engineering principles active" : "Engineering principles inactive", "info");
				return;
			}
			active = true;
			persist(pi);
			scrubOldPrinciplesMessages(ctx);
			ctx.ui.notify("Engineering principles active", "info");
		},
	});
}

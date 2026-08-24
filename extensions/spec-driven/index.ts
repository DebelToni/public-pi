import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

const STATE_TYPE = "spec-driven-state";
const CONFIG_DIR = ".spec-driven";
const FEATURE_POINTER = join(CONFIG_DIR, "feature.json");

type Phase = "spec" | "plan" | "tasks" | "handoff";

type SpecDrivenState = {
	active: boolean;
	cwd?: string;
	featureDir?: string;
	phase: Phase;
};

const state: SpecDrivenState = { active: false, phase: "spec" };

type Scaffold = {
	cwd: string;
	featureDirAbs: string;
	featureDirRel: string;
	spec: string;
	plan: string;
	tasks: string;
	checklist: string;
	handoff: string;
	created: string[];
};

type ParsedArgs = {
	command: "start" | "new" | "init" | "import" | "status" | "off" | "handoff" | "help";
	text: string;
	dir?: string;
	sourceFile?: string;
};

function displayPath(cwd: string, path: string): string {
	const rel = relative(cwd, path);
	return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : path;
}

function slugify(input: string): string {
	const slug = input
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.split("-")
		.filter(Boolean)
		.slice(0, 5)
		.join("-");
	return slug || "feature";
}

function unquote(value: string): string {
	return value.replace(/^["']|["']$/g, "");
}

function extractValueFlag(rest: string, name: string): { value?: string; rest: string } {
	const pattern = new RegExp(`(?:^|\\s)--${name}(?:=|\\s+)("[^"]+"|'[^']+'|\\S+)`);
	const match = rest.match(pattern);
	if (!match) return { rest };
	return {
		value: unquote(match[1]),
		rest: (rest.slice(0, match.index) + rest.slice((match.index ?? 0) + match[0].length)).trim(),
	};
}

function consumeFirstArg(rest: string): { value?: string; rest: string } {
	const trimmed = rest.trim();
	if (!trimmed) return { rest: "" };
	const quote = trimmed[0];
	if (quote === "\"" || quote === "'") {
		const end = trimmed.indexOf(quote, 1);
		if (end > 0) return { value: trimmed.slice(1, end), rest: trimmed.slice(end + 1).trim() };
	}
	const match = trimmed.match(/^(\S+)(?:\s+([\s\S]*))?$/);
	return { value: match?.[1], rest: match?.[2]?.trim() ?? "" };
}

function parseArgs(raw: string): ParsedArgs {
	let rest = raw.trim();
	let command: ParsedArgs["command"] = "start";
	const first = rest.split(/\s+/, 1)[0]?.toLowerCase() ?? "";
	if (["new", "init", "from-session", "session", "import", "convert", "from-file", "from-md", "status", "off", "stop", "clear", "handoff", "help"].includes(first)) {
		command = first === "stop" || first === "clear"
			? "off"
			: first === "from-session" || first === "session"
				? "init"
				: first === "convert" || first === "from-file" || first === "from-md"
					? "import"
					: (first as ParsedArgs["command"]);
		rest = rest.slice(first.length).trim();
	}

	const dirFlag = extractValueFlag(rest, "dir");
	const dir = dirFlag.value;
	rest = dirFlag.rest;

	const fileFlag = extractValueFlag(rest, "file");
	let sourceFile = fileFlag.value;
	rest = fileFlag.rest;

	if (command === "import" && !sourceFile) {
		const consumed = consumeFirstArg(rest);
		sourceFile = consumed.value;
		rest = consumed.rest;
	}

	return { command, text: rest, dir, sourceFile };
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

async function ensureFile(path: string, content: string, created: string[]): Promise<void> {
	if (await pathExists(path)) return;
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, content, "utf8");
	created.push(path);
}

async function readJsonFile(path: string): Promise<any | undefined> {
	try {
		return JSON.parse(await readFile(path, "utf8"));
	} catch {
		return undefined;
	}
}

async function nextFeatureDirectory(cwd: string, idea: string): Promise<string> {
	const specsDir = join(cwd, "specs");
	await mkdir(specsDir, { recursive: true });
	let max = 0;
	try {
		for (const name of await readdir(specsDir)) {
			const match = name.match(/^(\d{3,})-/);
			if (match) max = Math.max(max, Number(match[1]));
		}
	} catch {
		// Keep default 0.
	}
	return join("specs", `${String(max + 1).padStart(3, "0")}-${slugify(idea)}`);
}

function specTemplate(now: string, input: string): string {
	return `# Feature Specification: TBD

**Status**: Draft
**Created**: ${now}
**Input**: ${input ? `User description: ${JSON.stringify(input)}` : "TBD"}

> Spec rule: this file defines **what** users need and **why**. Do not put implementation technology, APIs, frameworks, file paths, or code structure here.

## Clarifications Log

- TBD

## User Scenarios & Testing *(mandatory)*

### User Story 1 - TBD (Priority: P1)

TBD

**Why this priority**: TBD

**Independent Test**: TBD

**Acceptance Scenarios**:

1. **Given** TBD, **When** TBD, **Then** TBD

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: TBD

### Key Entities *(include if feature involves data)*

- TBD

## Edge Cases

- TBD

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: TBD

## Assumptions

- TBD

## Out of Scope

- TBD
`;
}

function planTemplate(now: string): string {
	return `# Implementation Plan: TBD

**Status**: Draft
**Created**: ${now}
**Spec**: ./spec.md

> Plan rule: this file translates the approved spec into technical choices. Keep rationale explicit. If a choice is uncertain, ask before locking it in.

## Summary

TBD

## Technical Context

**Language/Version**: TBD
**Primary Dependencies**: TBD
**Storage**: TBD
**Testing**: TBD
**Target Platform**: TBD
**Project Type**: TBD
**Performance Goals**: TBD
**Constraints**: TBD
**Scale/Scope**: TBD

## Architecture & Project Structure

TBD

## Data Model

TBD

## Interfaces / Contracts

TBD

## Research & Decisions

| Decision | Rationale | Alternatives Considered |
|----------|-----------|-------------------------|
| TBD | TBD | TBD |

## Validation Plan

TBD

## Risks, Tradeoffs, and Open Questions

- TBD

## Lifecycle Gates

- [ ] Spec approved by user
- [ ] Plan approved by user
- [ ] Tasks generated from approved spec and plan
- [ ] Handoff ready for implementation session
`;
}

function tasksTemplate(): string {
	return `# Tasks: TBD

**Input**: ./spec.md and ./plan.md

> Generate this only after both spec.md and plan.md are approved. Tasks must be concrete enough that a fresh implementation agent can execute them without another planning conversation.

## Format

Every task must use:

\`- [ ] T001 [P?] [US?] Description with exact file path\`

- **[P]** means safe to run in parallel because it touches different files and has no dependency on incomplete work.
- **[US1]**, **[US2]**, etc. map implementation work to user stories.
- Include tests first when the plan or spec calls for test-driven work.

## Phase 1: Setup

- [ ] T001 TBD

## Phase 2: Foundational

- [ ] T002 TBD

## Phase 3: User Story 1 - TBD (Priority: P1)

**Goal**: TBD
**Independent Test**: TBD

- [ ] T003 [US1] TBD

## Final Phase: Polish & Validation

- [ ] T004 Run final validation against spec.md, plan.md, and acceptance scenarios
`;
}

function checklistTemplate(now: string): string {
	return `# Specification Quality Checklist

**Purpose**: Unit tests for requirements writing before planning and implementation
**Created**: ${now}
**Feature**: ../spec.md

## Content Quality

- [ ] No implementation details leak into spec.md
- [ ] User value and business/user need are explicit
- [ ] All mandatory sections are completed
- [ ] Requirements are understandable without reading code

## Requirement Completeness

- [ ] No TBD placeholders remain in approved spec.md
- [ ] Requirements are testable and unambiguous
- [ ] Success criteria are measurable and technology-agnostic
- [ ] Acceptance scenarios cover primary flows
- [ ] Edge cases and failure modes are identified
- [ ] Scope boundaries and out-of-scope items are explicit
- [ ] Dependencies and assumptions are documented

## Planning Readiness

- [ ] High-impact ambiguity has been resolved with the user
- [ ] Non-functional requirements are specific enough to plan
- [ ] Data/entity concepts are named consistently
- [ ] Security/privacy implications are addressed when relevant
- [ ] The user has explicitly approved the spec before plan finalization
`;
}

function handoffTemplate(): string {
	return `# Implementation Handoff

**Status**: Not ready

## Source of Truth

- Spec: ./spec.md
- Plan: ./plan.md
- Tasks: ./tasks.md

## Implementation Agent Instructions

TBD after spec.md and plan.md are approved.

## Readiness Checklist

- [ ] spec.md approved
- [ ] plan.md approved
- [ ] tasks.md generated and reviewed
- [ ] Open questions resolved or explicitly deferred
- [ ] Validation commands known
`;
}

async function ensureScaffold(cwd: string, idea: string, dirArg: string | undefined, forceNew: boolean): Promise<Scaffold> {
	const created: string[] = [];
	await mkdir(join(cwd, CONFIG_DIR), { recursive: true });

	let featureDirRel = dirArg;
	if (!featureDirRel && !forceNew) {
		const pointer = await readJsonFile(join(cwd, FEATURE_POINTER));
		if (typeof pointer?.feature_directory === "string" && pointer.feature_directory.trim()) {
			featureDirRel = pointer.feature_directory.trim();
		}
	}
	if (!featureDirRel) featureDirRel = await nextFeatureDirectory(cwd, idea || "feature");

	const featureDirAbs = isAbsolute(featureDirRel) ? resolve(featureDirRel) : resolve(cwd, featureDirRel);
	featureDirRel = displayPath(cwd, featureDirAbs);

	await mkdir(featureDirAbs, { recursive: true });
	await mkdir(join(featureDirAbs, "checklists"), { recursive: true });
	const now = new Date().toISOString().slice(0, 10);

	await writeFile(
		join(cwd, FEATURE_POINTER),
		JSON.stringify({ feature_directory: featureDirRel, updated_at: new Date().toISOString() }, null, 2) + "\n",
		"utf8",
	);
	await ensureFile(join(cwd, CONFIG_DIR, "README.md"), "# Spec Driven Workspace\n\nThis folder stores the active feature pointer for the `/spec-driven` Pi extension.\n", created);
	await ensureFile(join(featureDirAbs, "spec.md"), specTemplate(now, idea), created);
	await ensureFile(join(featureDirAbs, "plan.md"), planTemplate(now), created);
	await ensureFile(join(featureDirAbs, "tasks.md"), tasksTemplate(), created);
	await ensureFile(join(featureDirAbs, "handoff.md"), handoffTemplate(), created);
	await ensureFile(join(featureDirAbs, "checklists", "requirements.md"), checklistTemplate(now), created);

	return {
		cwd,
		featureDirAbs,
		featureDirRel,
		spec: join(featureDirAbs, "spec.md"),
		plan: join(featureDirAbs, "plan.md"),
		tasks: join(featureDirAbs, "tasks.md"),
		checklist: join(featureDirAbs, "checklists", "requirements.md"),
		handoff: join(featureDirAbs, "handoff.md"),
		created,
	};
}

function restore(ctx: ExtensionContext): void {
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "custom" || entry.customType !== STATE_TYPE) continue;
		const data = entry.data as Partial<SpecDrivenState> | undefined;
		state.active = !!data?.active;
		state.cwd = typeof data?.cwd === "string" ? data.cwd : state.cwd;
		state.featureDir = typeof data?.featureDir === "string" ? data.featureDir : state.featureDir;
		state.phase = data?.phase ?? state.phase;
	}
}

function persist(pi: ExtensionAPI): void {
	pi.appendEntry(STATE_TYPE, { ...state });
}

function updateStatus(ctx: ExtensionContext): void {
	if (!state.active) {
		ctx.ui.setStatus("spec-driven", undefined);
		return;
	}
	const label = state.phase === "spec" ? "spec" : state.phase === "plan" ? "plan" : state.phase === "tasks" ? "tasks" : "handoff";
	ctx.ui.setStatus("spec-driven", ctx.ui.theme.fg("accent", `📐 ${label}`));
}

function planningSystemPrompt(cwd: string, featureDir: string): string {
	const spec = join(featureDir, "spec.md");
	const plan = join(featureDir, "plan.md");
	const tasks = join(featureDir, "tasks.md");
	const checklist = join(featureDir, "checklists", "requirements.md");
	const handoff = join(featureDir, "handoff.md");
	return `<system-reminder>
<pi-agent-state extension="spec-driven" active="true" phase="${state.phase}" />
SPEC-DRIVEN PLANNING MODE is active.

Working directory: ${cwd}
Feature directory: ${displayPath(cwd, featureDir)}
Artifacts:
- Spec: ${displayPath(cwd, spec)}
- Plan: ${displayPath(cwd, plan)}
- Tasks: ${displayPath(cwd, tasks)}
- Requirements checklist: ${displayPath(cwd, checklist)}
- Handoff: ${displayPath(cwd, handoff)}

Role:
- Be a demanding spec-driven product/architecture partner, not an implementation agent yet.
- Your main output is durable edits to spec.md and plan.md, then tasks.md and handoff.md only after approval.
- Do not modify application/source code while this mode is active unless the user explicitly exits planning or asks for a tiny inspection-only support file.

Lifecycle:
1. Discovery: inspect existing spec/plan and relevant repo docs, then interview the user.
2. Specification: maintain spec.md as WHAT/WHY only: users, user stories, acceptance scenarios, functional requirements, edge cases, success criteria, assumptions, out-of-scope.
3. Spec quality gate: use checklists/requirements.md as unit tests for English. Remove TBDs and unresolved critical ambiguity.
4. Explicit spec approval: before treating spec.md as final, ask the user to explicitly approve it.
5. Planning: maintain plan.md with technical context, architecture, data model, contracts/interfaces, validation plan, risks, and decisions with alternatives.
6. Explicit plan approval: before task generation, ask the user to explicitly approve plan.md.
7. Tasking: generate tasks.md from approved spec+plan with T### IDs, exact paths, dependency order, [P] parallel markers, user-story labels, and validation tasks.
8. Handoff: write handoff.md for a fresh implementation session and tell the user to run /spec-driven handoff.

Questioning policy:
- Take initiative when the user does not. Do not wait passively for perfect input.
- Ask relentless follow-up questions for vague answers that affect scope, UX, data, security/privacy, performance, architecture, cost, deployment, or validation.
- Do not accept words like "simple", "fast", "robust", "secure", "nice", "scale", or "later" without making them concrete or explicitly out-of-scope.
- Prefer one focused batch of up to 5 high-impact questions per turn. Continue drilling over later turns until the artifacts are testable.
- For each important open question, provide a recommended default with rationale, but require user confirmation when the choice changes product behavior or architecture.
- If the user answers vaguely, say what remains ambiguous and ask a narrower question.

Spec/plan separation:
- spec.md must stay technology-agnostic.
- plan.md is where language, framework, storage, APIs, tests, deployment, and architecture belong.
- Keep decisions traceable: every major plan decision should point back to user stories, FRs, SCs, constraints, or explicit user preference.

File discipline:
- Read the current artifacts before changing them.
- Preserve user-written content. Edit surgically.
- Do not overwrite approved sections without explaining the reason.
- Keep final chat responses short, but keep the files complete.
</system-reminder>`;
}

function contentToText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			const block = part as { type?: string; text?: string };
			if (block.type === "text" && typeof block.text === "string") return block.text;
			if (block.type === "image") return "[image]";
			return "";
		})
		.filter(Boolean)
		.join("\n");
}

function sessionTranscript(ctx: ExtensionContext, maxChars = 50_000): string {
	const blocks: string[] = [];
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "message") continue;
		const message = entry.message as { role?: string; content?: unknown };
		if (message.role !== "user" && message.role !== "assistant") continue;
		const text = contentToText(message.content).trim();
		if (!text) continue;
		blocks.push(`## ${message.role}\n${text}`);
	}
	const transcript = blocks.join("\n\n").trim();
	if (transcript.length <= maxChars) return transcript;
	return `[older transcript omitted; showing last ${maxChars} chars]\n` + transcript.slice(-maxChars);
}

function kickoffPrompt(scaffold: Scaffold, idea: string, existingSessionContext = ""): string {
	const createdList = scaffold.created.length
		? scaffold.created.map((p) => `- ${displayPath(scaffold.cwd, p)}`).join("\n")
		: "- No files created; continuing existing artifacts.";
	const sessionSection = existingSessionContext.trim()
		? `\nExisting session context to mine:\n${existingSessionContext.trim()}\n\nUse this transcript as raw evidence, not as an approved spec. Extract decisions, requirements, constraints, rejected options, and open questions. Ignore unrelated chatter. If relevance is unclear, ask.\n`
		: "";
	return `Enter SPEC-DRIVEN PLANNING MODE for this feature.

Initial user input:
${idea || "No detailed feature description was provided. Start by asking for the product intent."}
${sessionSection}
Feature directory: ${scaffold.featureDirRel}
Spec: ${displayPath(scaffold.cwd, scaffold.spec)}
Plan: ${displayPath(scaffold.cwd, scaffold.plan)}
Tasks: ${displayPath(scaffold.cwd, scaffold.tasks)}
Checklist: ${displayPath(scaffold.cwd, scaffold.checklist)}
Handoff: ${displayPath(scaffold.cwd, scaffold.handoff)}

Bootstrap result:
${createdList}

Start now:
1. Read the current artifacts and enough repo context to avoid asking questions already answered.
2. If the user's initial input is underspecified, ask the highest-impact questions first.
3. Update spec.md after concrete answers. Keep plan.md draft-only until the spec is approved.
4. Do not implement code in this session.`;
}

function clippedMarkdown(text: string, maxChars = 80_000): { text: string; truncated: boolean } {
	if (text.length <= maxChars) return { text, truncated: false };
	const headChars = 20_000;
	const tailChars = maxChars - headChars;
	return {
		text: `${text.slice(0, headChars)}\n\n[... middle omitted by /spec-driven import; use the read tool on the source path for full content ...]\n\n${text.slice(-tailChars)}`,
		truncated: true,
	};
}

function importPrompt(scaffold: Scaffold, sourcePath: string, sourceMarkdown: string, truncated: boolean, instruction: string): string {
	const note = instruction.trim() || "Convert this Markdown documentation into a spec-driven feature structure.";
	return `Enter SPEC-DRIVEN PLANNING MODE and import an existing Markdown source.

User import instruction:
${note}

Source Markdown path: ${displayPath(scaffold.cwd, sourcePath)}
Source content included below: ${truncated ? "TRUNCATED - read the file directly before finalizing" : "complete"}

Feature directory: ${scaffold.featureDirRel}
Spec: ${displayPath(scaffold.cwd, scaffold.spec)}
Plan: ${displayPath(scaffold.cwd, scaffold.plan)}
Tasks: ${displayPath(scaffold.cwd, scaffold.tasks)}
Checklist: ${displayPath(scaffold.cwd, scaffold.checklist)}
Handoff: ${displayPath(scaffold.cwd, scaffold.handoff)}

Bootstrap result:
${scaffold.created.length ? scaffold.created.map((p) => `- ${displayPath(scaffold.cwd, p)}`).join("\n") : "- No files created; continuing existing artifacts."}

Import rules:
1. Treat the source file as raw evidence, not as an approved spec.
2. Split mixed content correctly: product/user intent goes to spec.md; technical choices, architecture, stack, validation, and deployment go to plan.md.
3. If the source is plan-only, derive a draft spec and ask for missing user/value decisions.
4. If the source is spec-only, keep plan.md draft and ask for missing technical constraints.
5. Preserve useful decisions and rejected alternatives, but flag contradictions and stale assumptions.
6. Do not generate final tasks.md until spec.md and plan.md are approved by the user.
7. Ask relentless follow-up questions for vague or high-impact gaps.
8. Do not implement code in this session.

Source Markdown:
\`\`\`markdown
${sourceMarkdown}
\`\`\``;
}

function handoffPrompt(cwd: string, featureDir: string): string {
	return `You are a fresh implementation agent. Do not run the spec-driven planning mode unless explicitly asked.

Read these files first:
- ${displayPath(cwd, join(featureDir, "spec.md"))}
- ${displayPath(cwd, join(featureDir, "plan.md"))}
- ${displayPath(cwd, join(featureDir, "tasks.md"))}
- ${displayPath(cwd, join(featureDir, "handoff.md"))}

Then implement the feature task-by-task:
- Treat spec.md and plan.md as the source of truth.
- Mark completed tasks in tasks.md.
- Run validation from the plan/handoff.
- If you find a contradiction or missing critical decision, stop and ask instead of guessing.`;
}

function helpText(): string {
	return `Spec-driven commands:
/spec-driven <idea>                    Start or continue planning the active feature
/spec-driven init [note]               Mine the current session transcript into planning mode
/spec-driven import <file.md> [prompt] Convert Markdown docs/specs/plans into spec-driven files
/spec-driven import --file file.md     Same as above; add --dir to target a feature dir
/spec-driven new <idea>                Create a new specs/NNN-slug feature directory
/spec-driven --dir path                Use an explicit feature directory
/spec-driven status                    Show current feature/mode
/spec-driven off                       Disable spec-driven planning prompt in this session
/spec-driven handoff                   Start a clean implementation session with spec/plan/tasks context`;
}

export default function specDrivenExtension(pi: ExtensionAPI): void {
	pi.on("session_start", async (_event, ctx) => {
		restore(ctx);
		updateStatus(ctx);
	});

	pi.on("before_agent_start", async (event) => {
		if (!state.active || !state.cwd || !state.featureDir) return undefined;
		return { systemPrompt: `${event.systemPrompt}\n\n${planningSystemPrompt(state.cwd, state.featureDir)}` };
	});

	pi.registerCommand("spec-driven", {
		description: "Create spec-driven planning artifacts and enter deep spec/plan discussion mode",
		handler: async (args, ctx) => {
			const parsed = parseArgs(args);
			const cwd = ctx.cwd;

			if (parsed.command === "help") {
				ctx.ui.notify(helpText(), "info");
				return;
			}

			if (parsed.command === "status") {
				ctx.ui.notify(
					state.featureDir
						? `Spec-driven ${state.active ? "active" : "inactive"}; phase=${state.phase}; feature=${displayPath(state.cwd ?? cwd, state.featureDir)}`
						: "No spec-driven feature is active. Run /spec-driven <idea>.",
					"info",
				);
				return;
			}

			if (parsed.command === "off") {
				state.active = false;
				persist(pi);
				updateStatus(ctx);
				ctx.ui.notify("Spec-driven mode disabled for this session", "info");
				return;
			}

			if (parsed.command === "handoff") {
				const featureDir = state.featureDir ?? (await readJsonFile(join(cwd, FEATURE_POINTER)))?.feature_directory;
				if (typeof featureDir !== "string" || !featureDir.trim()) {
					ctx.ui.notify("No active feature. Run /spec-driven <idea> first.", "warning");
					return;
				}
				const featureDirAbs = isAbsolute(featureDir) ? resolve(featureDir) : resolve(cwd, featureDir);
				if (!existsSync(join(featureDirAbs, "spec.md")) || !existsSync(join(featureDirAbs, "plan.md"))) {
					ctx.ui.notify("Missing spec.md or plan.md in active feature directory", "warning");
					return;
				}
				const ok = !ctx.hasUI || (await ctx.ui.confirm("Start implementation session?", `New session will read ${displayPath(cwd, featureDirAbs)} and begin implementation.`));
				if (!ok) return;
				state.active = false;
				state.phase = "handoff";
				persist(pi);
				updateStatus(ctx);
				await ctx.newSession({
					parentSession: ctx.sessionManager.getSessionFile(),
					withSession: async (newCtx) => {
						await newCtx.sendUserMessage(handoffPrompt(cwd, featureDirAbs));
					},
				});
				return;
			}

			if (parsed.command === "import") {
				if (!parsed.sourceFile) {
					ctx.ui.notify("Usage: /spec-driven import <file.md> [conversion prompt]", "warning");
					return;
				}
				const sourceAbs = isAbsolute(parsed.sourceFile) ? resolve(parsed.sourceFile) : resolve(cwd, parsed.sourceFile);
				if (!existsSync(sourceAbs)) {
					ctx.ui.notify(`Source file not found: ${displayPath(cwd, sourceAbs)}`, "warning");
					return;
				}
				const source = clippedMarkdown(await readFile(sourceAbs, "utf8"));
				const scaffoldIdea = parsed.text || basename(sourceAbs).replace(/\.[^.]+$/, "");
				const scaffold = await ensureScaffold(cwd, scaffoldIdea, parsed.dir, !parsed.dir);
				state.active = true;
				state.cwd = cwd;
				state.featureDir = scaffold.featureDirAbs;
				state.phase = "spec";
				persist(pi);
				updateStatus(ctx);
				try {
					pi.setThinkingLevel("xhigh");
				} catch {
					// Some providers may not expose xhigh. The prompt still enforces depth.
				}
				ctx.ui.notify(`Spec-driven import: ${displayPath(cwd, sourceAbs)} → ${scaffold.featureDirRel}`, "info");
				pi.sendUserMessage(importPrompt(scaffold, sourceAbs, source.text, source.truncated, parsed.text));
				return;
			}

			const existingSessionContext = parsed.command === "init" ? sessionTranscript(ctx) : "";
			const scaffoldIdea = parsed.text || (existingSessionContext ? "session derived feature" : "");
			const scaffold = await ensureScaffold(cwd, scaffoldIdea, parsed.dir, parsed.command === "new");
			state.active = true;
			state.cwd = cwd;
			state.featureDir = scaffold.featureDirAbs;
			state.phase = "spec";
			persist(pi);
			updateStatus(ctx);
			try {
				pi.setThinkingLevel("xhigh");
			} catch {
				// Some providers may not expose xhigh. The prompt still enforces depth.
			}
			ctx.ui.notify(`Spec-driven mode: ${scaffold.featureDirRel}`, "info");
			pi.sendUserMessage(kickoffPrompt(scaffold, parsed.text, existingSessionContext));
		},
	});
}

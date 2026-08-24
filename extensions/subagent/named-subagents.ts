import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	getAgentDir,
	SessionManager,
	type ExtensionAPI,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	CAPABILITY_TOOLS,
	type AgentCapabilities,
	type AgentConfig,
	type ModelSize,
	discoverAgents,
	formatAgentList,
} from "./agents.js";
import type {
	ContextMode,
	ForkContext,
	ResumeHandle,
	SingleResult,
	SubagentDetails,
} from "./index.js";
import { parseForkTurns, selectForkMessages, writeResumableForkSession } from "./fork-context.js";
import { acquireContinuationLease } from "./continuation-store.js";

const NAMED_SUBAGENT_VERSION = 1;
const NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

export type NamedSubagentState = {
	version: typeof NAMED_SUBAGENT_VERSION;
	parentSessionId: string;
	name: string;
	description: string;
	template: string;
	size: ModelSize;
	capabilities: AgentCapabilities;
	tools: string[];
	instructions: string;
	cwd: string;
	history: string;
	contextMode: ContextMode;
	resume: ResumeHandle;
	pending?: SingleResult;
	createdAt: number;
	updatedAt: number;
};

function namedRoot(parentSessionId: string, root = path.join(getAgentDir(), "subagent-runs", "named")) {
	return path.join(root, createHash("sha256").update(parentSessionId).digest("hex"));
}

function statePath(parentSessionId: string, name: string, root?: string) {
	return path.join(namedRoot(parentSessionId, root), `${name}.json`);
}

function ensurePrivateDirectory(directory: string) {
	fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
	fs.chmodSync(directory, 0o700);
}

function fsyncDirectory(directory: string) {
	const descriptor = fs.openSync(directory, "r");
	try {
		fs.fsyncSync(descriptor);
	} finally {
		fs.closeSync(descriptor);
	}
}

function writeState(state: NamedSubagentState, root?: string) {
	const file = statePath(state.parentSessionId, state.name, root);
	const directory = path.dirname(file);
	ensurePrivateDirectory(directory);
	const temporary = path.join(directory, `.${state.name}.${randomUUID()}.tmp`);
	let descriptor: number | undefined;
	try {
		descriptor = fs.openSync(temporary, "wx", 0o600);
		fs.writeFileSync(descriptor, `${JSON.stringify(state)}\n`);
		fs.fsyncSync(descriptor);
		fs.closeSync(descriptor);
		descriptor = undefined;
		fs.renameSync(temporary, file);
		fs.chmodSync(file, 0o600);
		fsyncDirectory(directory);
	} finally {
		if (descriptor !== undefined) fs.closeSync(descriptor);
		fs.rmSync(temporary, { force: true });
	}
}

function isState(value: unknown): value is NamedSubagentState {
	if (!value || typeof value !== "object") return false;
	const state = value as Partial<NamedSubagentState>;
	return state.version === NAMED_SUBAGENT_VERSION
		&& typeof state.parentSessionId === "string"
		&& typeof state.name === "string"
		&& typeof state.instructions === "string"
		&& typeof state.cwd === "string"
		&& (state.size === "big" || state.size === "small")
		&& (state.capabilities === "general" || state.capabilities === "research")
		&& Array.isArray(state.tools)
		&& !!state.resume
		&& typeof state.resume.filePath === "string";
}

export function readNamedSubagent(parentSessionId: string, name: string, root?: string) {
	try {
		const parsed = JSON.parse(fs.readFileSync(statePath(parentSessionId, name, root), "utf8"));
		return isState(parsed) && parsed.parentSessionId === parentSessionId && parsed.name === name ? parsed : undefined;
	} catch {
		return undefined;
	}
}

export function listNamedSubagents(parentSessionId: string, root?: string) {
	let names: string[];
	try {
		names = fs.readdirSync(namedRoot(parentSessionId, root));
	} catch {
		return [];
	}
	return names
		.filter((name) => name.endsWith(".json"))
		.map((name) => readNamedSubagent(parentSessionId, name.slice(0, -5), root))
		.filter((state): state is NamedSubagentState => !!state);
}

function invocationSession(state: NamedSubagentState): ResumeHandle {
	const manager = SessionManager.open(state.resume.filePath);
	const baselineEntryId = manager.appendCustomEntry("subagent-run-boundary", {});
	return { ...state.resume, baselineEntryId };
}

function finalOutput(result: SingleResult) {
	for (let index = result.messages.length - 1; index >= 0; index--) {
		const message = result.messages[index];
		if (message.role !== "assistant") continue;
		return message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
	}
	return result.errorMessage || result.stderr || "(no output)";
}

function capabilitiesFor(agent: AgentConfig): AgentCapabilities {
	if (agent.capabilities) return agent.capabilities;
	return agent.tools?.some((tool) => tool === "exa_search" || tool === "write") ? "research" : "general";
}

function agentFromState(state: NamedSubagentState): AgentConfig {
	return {
		name: state.name,
		description: state.description,
		tools: state.tools,
		size: state.size,
		capabilities: state.capabilities,
		cwd: state.cwd,
		cwdBase: undefined,
		history: state.history,
		contextMode: state.contextMode,
		systemPrompt: state.instructions,
		source: "user",
		filePath: statePath(state.parentSessionId, state.name),
	};
}

function availableNames(states: NamedSubagentState[]) {
	return states.length ? states.map((state) => `${state.name} [${state.size}]`).join(", ") : "none";
}

function safeDescription(value: string) {
	return JSON.stringify(value);
}

function projectRoot(cwd: string) {
	let current = fs.realpathSync(cwd);
	while (true) {
		if (fs.existsSync(path.join(current, ".git"))) return current;
		const parent = path.dirname(current);
		if (parent === current) return fs.realpathSync(cwd);
		current = parent;
	}
}

function ensureSafeExportDirectory(root: string) {
	let current = root;
	for (const component of [".agents", "subagents"]) {
		current = path.join(current, component);
		if (fs.existsSync(current)) {
			const stat = fs.lstatSync(current);
			if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Unsafe export directory: ${current}`);
		} else {
			fs.mkdirSync(current, { mode: 0o755 });
		}
	}
	const resolved = fs.realpathSync(current);
	if (resolved !== path.join(root, ".agents", "subagents")) throw new Error("Export directory escapes the project root.");
	return resolved;
}

function writeExclusiveAtomic(destination: string, content: string) {
	const directory = path.dirname(destination);
	const temporary = path.join(directory, `.${path.basename(destination)}.${process.pid}.${randomUUID()}.tmp`);
	let descriptor: number | undefined;
	try {
		descriptor = fs.openSync(temporary, "wx", 0o644);
		fs.writeFileSync(descriptor, content, "utf8");
		fs.fsyncSync(descriptor);
		fs.closeSync(descriptor);
		descriptor = undefined;
		fs.linkSync(temporary, destination);
		fsyncDirectory(directory);
	} finally {
		if (descriptor !== undefined) fs.closeSync(descriptor);
		fs.rmSync(temporary, { force: true });
	}
}

function exportedCwd(projectRoot: string, cwd: string) {
	const canonicalCwd = fs.realpathSync(cwd);
	const relative = path.relative(projectRoot, canonicalCwd);
	if (relative === "") return ".";
	if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
		throw new Error(`Cannot export subagent cwd ${canonicalCwd} outside project ${projectRoot}.`);
	}
	return relative.split(path.sep).join("/");
}

function renderExport(state: NamedSubagentState, description: string, root: string) {
	const header = [
		"---",
		`name: ${state.name}`,
		`description: ${safeDescription(description)}`,
		`size: ${state.size}`,
		`capabilities: ${state.capabilities}`,
		`tools: ${state.tools.join(", ")}`,
		`cwd: ${JSON.stringify(exportedCwd(root, state.cwd))}`,
		`history: ${JSON.stringify(state.history)}`,
		`context: ${state.contextMode}`,
		"---",
		"",
	].join("\n");
	return `${header}${state.instructions}${state.instructions.endsWith("\n") ? "" : "\n"}`;
}

const SizeSchema = StringEnum(["big", "small"] as const, {
	description: "big = GPT-5.6 Sol/high; small = GPT-5.6 Luna/high",
});
const ContextSchema = StringEnum(["default", "none", "cwd-only"] as const);

type NamedSubagentDependencies = {
	runSingleAgent: (
		defaultCwd: string,
		agents: AgentConfig[],
		agentName: string,
		task: string,
		cwd: string | undefined,
		contextMode: ContextMode,
		modelOverride: string | undefined,
		forkContext: ForkContext | undefined,
		step: number | undefined,
		signal: AbortSignal | undefined,
		onUpdate: ((partial: any) => void) | undefined,
		makeDetails: (results: SingleResult[]) => SubagentDetails,
		options: { resumeFrom?: SingleResult; existingSession?: ResumeHandle; onCheckpoint?: (result: SingleResult) => void; retainTerminalSession?: boolean },
	) => Promise<SingleResult>;
	sizedModel: (size: ModelSize, provider?: string) => string;
};

export function registerNamedSubagentTools(
	pi: ExtensionAPI,
	dependencies: NamedSubagentDependencies,
	discoveryCwd = process.cwd(),
	includeProject = false,
	parentSessionId?: string,
) {
	const { runSingleAgent, sizedModel } = dependencies;
	const templates = formatAgentList(discoverAgents(discoveryCwd, includeProject ? "both" : "user").agents);
	const templateDescription = `${templates.text}${templates.remaining ? `; +${templates.remaining} more` : ""}`;
	const namedDescription = parentSessionId ? availableNames(listNamedSubagents(parentSessionId)) : "none yet";

	pi.registerTool({
		name: "create_subagent",
		label: "Create subagent",
		description: `Create a reusable named child thread for this parent session. Parent history is copied once; later invoke_subagent calls retain the child's own conversation. Available templates: ${templateDescription}. Trusted .agents/subagents templates are included after session startup.`,
		parameters: Type.Object({
			name: Type.String({ description: "Session-local kebab-case name" }),
			template: Type.Optional(Type.String({ description: "general, researcher, or an exported project template", default: "general" })),
			size: Type.Optional(SizeSchema),
			instructions: Type.Optional(Type.String({ description: "Full replacement for the template instruction body" })),
			cwd: Type.Optional(Type.String({ description: "Absolute path or path relative to the parent cwd" })),
			history: Type.Optional(Type.String({ description: 'Parent history copied at creation: "none", "all", or a positive number of recent turns', default: "none" })),
			context: Type.Optional(ContextSchema),
		}),
		async execute(toolCallId, params, _signal, _onUpdate, ctx) {
			if (!NAME_PATTERN.test(params.name)) throw new Error("Subagent name must be lowercase kebab-case (1-64 characters).");
			const parentSessionId = ctx.sessionManager.getSessionId();
			const releaseName = acquireContinuationLease(`named-create:${params.name}`, parentSessionId);
			try {
			if (readNamedSubagent(parentSessionId, params.name)) throw new Error(`Named subagent already exists: ${params.name}`);
			const projectTrusted = typeof ctx.isProjectTrusted !== "function" || ctx.isProjectTrusted();
			const scope = projectTrusted ? "both" : "user";
			const discovery = discoverAgents(ctx.cwd, scope);
			const templateName = params.template ?? "general";
			const template = discovery.agents.find((agent) => agent.name === templateName);
			if (!template) throw new Error(`Unknown template: ${templateName}. Available: ${discovery.agents.map((agent) => agent.name).join(", ") || "none"}`);
			if (template.source === "project") {
				if (!ctx.hasUI) return { content: [{ type: "text", text: "Canceled: project templates require interactive approval." }], details: { canceled: true } };
				const approved = await ctx.ui.confirm("Create from project subagent?", `Template: ${template.name}\nSource: ${template.filePath}`);
				if (!approved) return { content: [{ type: "text", text: "Canceled: project template not approved." }], details: { canceled: true } };
			}
			const history = params.history ?? template.history ?? "none";
			parseForkTurns(history);
			const messages = parseForkTurns(history).kind === "none"
				? []
				: selectForkMessages(
					(ctx.sessionManager as typeof ctx.sessionManager & { buildSessionContext(): { messages: any[] } }).buildSessionContext().messages,
					toolCallId,
					history,
					"create_subagent",
				) ?? [];
			const cwd = params.cwd
				? path.resolve(ctx.cwd, params.cwd)
				: template.cwd
					? path.resolve(template.cwdBase ?? ctx.cwd, template.cwd)
					: ctx.cwd;
			if (!fs.statSync(cwd).isDirectory()) throw new Error(`Subagent cwd is not a directory: ${cwd}`);
			const stateRoot = namedRoot(parentSessionId);
			const resume = await writeResumableForkSession(cwd, messages, ctx.sessionManager.getSessionFile(), path.join(stateRoot, "children"));
			const now = Date.now();
			const capability = capabilitiesFor(template);
			const state: NamedSubagentState = {
				version: NAMED_SUBAGENT_VERSION,
				parentSessionId,
				name: params.name,
				description: template.description,
				template: template.name,
				size: params.size ?? template.size ?? "small",
				capabilities: capability,
				tools: template.tools ?? CAPABILITY_TOOLS[capability],
				instructions: params.instructions ?? template.systemPrompt,
				cwd,
				history,
				contextMode: params.context ?? template.contextMode ?? "default",
				resume,
				createdAt: now,
				updatedAt: now,
			};
			try {
				writeState(state);
			} catch (error) {
				fs.rmSync(resume.dir, { recursive: true, force: true });
				throw error;
			}
			return {
				content: [{ type: "text", text: `Created ${state.name} [${state.size}] from ${state.template}; history=${state.history}, cwd=${state.cwd}.` }],
				details: { name: state.name, size: state.size, template: state.template, cwd: state.cwd, history: state.history, context: state.contextMode },
			};
			} finally {
				releaseName();
			}
		},
	});

	pi.registerTool({
		name: "invoke_subagent",
		label: "Invoke subagent",
		description: `Continue a reusable named child thread created in this parent session. Supply only its name and the next prompt; all configuration and its conversation are retained. Available named subagents: ${namedDescription}.`,
		parameters: Type.Object({
			name: Type.String({ description: "Previously created session-local subagent name" }),
			prompt: Type.String({ description: "Next prompt for the persistent child thread" }),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const parentSessionId = ctx.sessionManager.getSessionId();
			const state = readNamedSubagent(parentSessionId, params.name);
			if (!state) throw new Error(`Unknown named subagent: ${params.name}. Available: ${availableNames(listNamedSubagents(parentSessionId))}`);
			if (!fs.existsSync(state.resume.filePath)) throw new Error(`Saved child session is missing for ${params.name}.`);
			const release = acquireContinuationLease(`named:${params.name}`, parentSessionId);
			const agent = agentFromState(state);
			const details = (results: SingleResult[]) => ({ mode: "single" as const, agentScope: "user" as const, projectAgentsDir: null, results });
			const run = async (task: string, resumeFrom?: SingleResult) => {
				const existingSession = resumeFrom ? undefined : invocationSession(state);
				return runSingleAgent(
				ctx.cwd,
				[agent],
				agent.name,
				task,
				state.cwd,
				state.contextMode,
				sizedModel(state.size, ctx.model?.provider),
				undefined,
				undefined,
				signal,
				(partial) => {
					const current = partial.details?.results[0];
					if (current) {
						state.pending = current;
						state.updatedAt = Date.now();
						writeState(state);
					}
					onUpdate?.({ content: partial.content, details: { name: state.name, child: partial.details } });
				},
				details,
				resumeFrom
					? { resumeFrom, retainTerminalSession: true }
					: {
						existingSession,
						retainTerminalSession: true,
						onCheckpoint(result) {
							state.pending = result;
							state.updatedAt = Date.now();
							writeState(state);
						},
					},
				);
			};
			try {
				if (state.pending) {
					const resumed = await run(state.pending.task, state.pending);
					if (resumed.status !== "completed") {
						state.pending = resumed;
						state.updatedAt = Date.now();
						writeState(state);
						return { content: [{ type: "text", text: `Could not finish ${state.name}'s interrupted task: ${finalOutput(resumed)}` }], details: { name: state.name, result: resumed } };
					}
					state.pending = undefined;
					state.updatedAt = Date.now();
					writeState(state);
				}
				const result = await run(params.prompt);
				state.pending = result.status === "interrupted" || result.status === "pending" ? result : undefined;
				state.updatedAt = Date.now();
				writeState(state);
				return { content: [{ type: "text", text: finalOutput(result) }], details: { name: state.name, result } };
			} finally {
				release();
			}
		},
	});

	pi.registerTool({
		name: "export_subagent",
		label: "Export subagent",
		description: "Export a reusable session-local subagent definition to .agents/subagents/<name>.md for future trusted sessions in this project. Conversation and inherited history contents are never exported.",
		parameters: Type.Object({
			name: Type.String({ description: "Reusable subagent name" }),
			description: Type.String({ description: "Discovery description for future main agents" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const state = readNamedSubagent(ctx.sessionManager.getSessionId(), params.name);
			if (!state) throw new Error(`Unknown named subagent: ${params.name}.`);
			if (!params.description.trim()) throw new Error("Export description cannot be empty.");
			const root = projectRoot(ctx.cwd);
			const destination = path.join(root, ".agents", "subagents", `${state.name}.md`);
			const content = renderExport(state, params.description, root);
			await withFileMutationQueue(destination, async () => {
				ensureSafeExportDirectory(root);
				try {
					writeExclusiveAtomic(destination, content);
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`Refusing to overwrite existing export: ${destination}`);
					throw error;
				}
			});
			return { content: [{ type: "text", text: `Exported ${state.name} to ${destination}.` }], details: { path: destination, name: state.name } };
		},
	});
}

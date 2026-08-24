/**
 * Agent discovery and configuration.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";

export type AgentScope = "user" | "project" | "both";
export type ModelSize = "big" | "small";
export type AgentCapabilities = "general" | "research";
export type AgentContextMode = "default" | "none" | "cwd-only";

export const CAPABILITY_TOOLS: Record<AgentCapabilities, string[]> = {
	general: ["read", "grep", "find", "ls", "bash", "search_session"],
	research: ["read", "grep", "find", "ls", "bash", "edit", "write", "exa_search", "exa_answer", "search_session"],
};

export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	size?: ModelSize;
	capabilities?: AgentCapabilities;
	cwd?: string;
	cwdBase?: string;
	history?: string;
	contextMode?: AgentContextMode;
	systemPrompt: string;
	source: "user" | "project";
	filePath: string;
}

export interface AgentDiscoveryResult {
	agents: AgentConfig[];
	projectAgentsDir: string | null;
}

function modelSize(value: unknown): ModelSize | undefined {
	return value === "big" || value === "small" ? value : undefined;
}

function capabilities(value: unknown): AgentCapabilities | undefined {
	return value === "general" || value === "research" ? value : undefined;
}

function contextMode(value: unknown): AgentContextMode | undefined {
	return value === "default" || value === "none" || value === "cwd-only" ? value : undefined;
}

function optionalString(value: unknown) {
	if (typeof value !== "string" && typeof value !== "number") return undefined;
	return String(value).trim() || undefined;
}

function loadAgentsFromDir(dir: string, source: "user" | "project"): AgentConfig[] {
	const agents: AgentConfig[] = [];
	if (!fs.existsSync(dir)) return agents;

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return agents;
	}

	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = path.join(dir, entry.name);
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		const { frontmatter, body } = parseFrontmatter<Record<string, string>>(content);
		if (!frontmatter.name || !frontmatter.description) continue;

		const capability = capabilities(frontmatter.capabilities);
		const explicitTools = frontmatter.tools
			?.split(",")
			.map((tool: string) => tool.trim())
			.filter(Boolean);
		const tools = explicitTools?.length ? explicitTools : capability ? CAPABILITY_TOOLS[capability] : undefined;

		agents.push({
			name: frontmatter.name,
			description: frontmatter.description,
			tools,
			model: frontmatter.model,
			size: modelSize(frontmatter.size) ?? (frontmatter.model?.includes("luna") ? "small" : frontmatter.model?.includes("sol") ? "big" : undefined),
			capabilities: capability,
			cwd: optionalString(frontmatter.cwd),
			cwdBase: source === "project" ? path.dirname(path.dirname(dir)) : undefined,
			history: optionalString(frontmatter.history),
			contextMode: contextMode(frontmatter.context),
			systemPrompt: body,
			source,
			filePath,
		});
	}

	return agents;
}

function isDirectory(value: string): boolean {
	try {
		return fs.statSync(value).isDirectory();
	} catch {
		return false;
	}
}

function findNearestProjectAgentDirs(cwd: string): string[] {
	let currentDir = path.resolve(cwd);
	while (true) {
		const candidates = [
			path.join(currentDir, ".pi", "agents"),
			path.join(currentDir, ".agents", "subagents"),
		].filter(isDirectory);
		if (candidates.length) return candidates;
		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) return [];
		currentDir = parentDir;
	}
}

export function discoverAgents(cwd: string, scope: AgentScope): AgentDiscoveryResult {
	const userDir = path.join(getAgentDir(), "agents");
	const projectAgentDirs = findNearestProjectAgentDirs(cwd);
	const projectAgentsDir = projectAgentDirs.length ? projectAgentDirs.join(", ") : null;
	const userAgents = scope === "project" ? [] : loadAgentsFromDir(userDir, "user");
	const projectAgents = scope === "user"
		? []
		: projectAgentDirs.flatMap((directory) => loadAgentsFromDir(directory, "project"));
	const agentMap = new Map<string, AgentConfig>();

	if (scope === "both") {
		for (const agent of userAgents) agentMap.set(agent.name, agent);
		for (const agent of projectAgents) agentMap.set(agent.name, agent);
	} else {
		for (const agent of scope === "user" ? userAgents : projectAgents) agentMap.set(agent.name, agent);
	}

	return { agents: Array.from(agentMap.values()), projectAgentsDir };
}

export function formatAgentList(agents: AgentConfig[], maxItems = 8): { text: string; remaining: number } {
	if (agents.length === 0) return { text: "none", remaining: 0 };
	const listed = agents.slice(0, maxItems);
	return {
		text: listed.map((agent) => `${agent.name} [${agent.size ?? "legacy"}/${agent.source}]: ${agent.description}`).join("; "),
		remaining: agents.length - listed.length,
	};
}

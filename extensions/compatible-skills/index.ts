import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, realpathSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { homedir } from "node:os";

function ancestors(start: string) {
	const out: string[] = [];
	let cur = start;
	while (true) {
		out.push(cur);
		const parent = dirname(cur);
		if (parent === cur) break;
		cur = parent;
	}
	return out;
}

function real(path: string) {
	try { return realpathSync(path); } catch { return path; }
}

function hasSkillFile(dir: string) {
	try { return statSync(join(dir, "SKILL.md")).isFile(); } catch { return false; }
}

function skillName(skillDir: string) {
	const fallback = basename(skillDir);
	try {
		const text = readFileSync(join(skillDir, "SKILL.md"), "utf8");
		const match = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
		const name = match?.[1]?.match(/^name:\s*["']?([^"'\n]+)["']?\s*$/m)?.[1]?.trim();
		return name || fallback;
	} catch {
		return fallback;
	}
}

function collectSkillDirs(root: string) {
	const dirs: string[] = [];
	if (!existsSync(root)) return dirs;
	if (hasSkillFile(root)) return [root];
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		if (entry.name.startsWith(".")) continue;
		const full = join(root, entry.name);
		if (entry.isDirectory() || entry.isSymbolicLink()) {
			try {
				if (statSync(full).isDirectory() && hasSkillFile(full)) dirs.push(full);
			} catch {}
		}
	}
	return dirs;
}

function nativeSkillNames(cwd: string) {
	const names = new Set<string>();
	const nativeRoots = [join(homedir(), ".pi", "agent", "skills"), join(homedir(), ".agents", "skills")];
	for (const dir of ancestors(cwd)) {
		nativeRoots.push(join(dir, ".pi", "skills"), join(dir, ".agents", "skills"));
	}
	for (const root of nativeRoots) {
		for (const dir of collectSkillDirs(root)) names.add(skillName(dir));
	}
	return names;
}

const COMPAT_SKILL_DIRS = [".claude", ".opencode"];

function compatibleSkillPaths(cwd: string) {
	const seenRealPaths = new Set<string>();
	const seenNames = nativeSkillNames(cwd);
	const paths: string[] = [];
	// Load from highest parent first so nearer folders lose on duplicate names, matching Pi's first-wins behavior.
	for (const dir of ancestors(cwd).reverse()) {
		for (const configDir of COMPAT_SKILL_DIRS) {
			const root = join(dir, configDir, "skills");
			for (const skillDir of collectSkillDirs(root)) {
				const realPath = real(join(skillDir, "SKILL.md"));
				const name = skillName(skillDir);
				if (seenRealPaths.has(realPath) || seenNames.has(name)) continue;
				seenRealPaths.add(realPath);
				seenNames.add(name);
				paths.push(skillDir);
			}
		}
	}
	return paths;
}

export default function (pi: ExtensionAPI) {
	pi.on("resources_discover", async (event) => {
		const skillPaths = compatibleSkillPaths(event.cwd);
		return skillPaths.length ? { skillPaths } : undefined;
	});
}

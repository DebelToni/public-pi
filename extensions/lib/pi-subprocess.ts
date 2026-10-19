import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const FORCE_STATE = Symbol.for("pi-codex-ultra.force-model.v1");
export type SubagentParentContext = Pick<ExtensionContext, "model" | "modelRegistry" | "thinkingLevel">;

/** Ultra consumes its environment marker before mutable extensions load. */
export function isForcedPiSession() {
	return (globalThis as typeof globalThis & { [FORCE_STATE]?: { active: boolean } })[FORCE_STATE]?.active === true;
}

export function subagentModel(requested: string | undefined, parent?: SubagentParentContext): { model: string | undefined; provider?: string } {
	if (!isForcedPiSession()) return { model: requested };
	if (parent?.model?.provider !== "codex-pro") {
		throw new Error("Forced subagents require the parent's current personal codex-pro provider.");
	}
	const provider = parent.model.provider;
	if (!parent.modelRegistry.getProviderAuthStatus(provider).configured) {
		throw new Error("Personal provider authentication is unavailable for forced delegation.");
	}
	const parsed = requested?.trim().match(/^(.+?)(?::(off|minimal|low|medium|high|xhigh|max))?$/);
	const reference = parsed?.[1];
	const id = reference ? reference.slice(reference.indexOf("/") + 1) : parent.model.id;
	let model = parent.modelRegistry.find(provider, id);
	let selectedId = id;
	if (!model) {
		selectedId = parent.model.id;
		model = parent.modelRegistry.find(provider, selectedId);
	}
	if (!model || model.provider !== provider || model.id !== selectedId) {
		throw new Error("An exact personal model is unavailable for forced delegation.");
	}
	const thinking = parsed?.[2] ?? parent.thinkingLevel;
	return { provider, model: `${provider}/${model.id}${thinking ? `:${thinking}` : ""}` };
}

export type PiInvocationRuntime = {
	currentScript?: string;
	execPath: string;
	ultraReleaseRoot?: string;
};

function within(root: string, file: string) {
	const relative = path.relative(root, file);
	return !!relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export function getPiInvocation(
	args: string[],
	runtime: PiInvocationRuntime = {
		currentScript: process.argv[1],
		execPath: process.execPath,
		ultraReleaseRoot: process.env.PI_CODEX_ULTRA_RELEASE_ROOT,
	},
): { command: string; args: string[] } {
	let ultraLauncher: string | undefined;
	if (runtime.ultraReleaseRoot && runtime.currentScript) {
		try {
			const root = fs.realpathSync(runtime.ultraReleaseRoot);
			const script = fs.realpathSync(runtime.currentScript);
			const launcher = fs.realpathSync(path.join(root, "launcher", "launcher.mjs"));
			if (within(root, script) && within(root, launcher) && fs.statSync(script).isFile() && fs.statSync(launcher).isFile()) {
				ultraLauncher = launcher;
			}
		} catch { /* Missing or escaped release paths cannot authorize a forced launch. */ }
	}
	if (ultraLauncher) {
		return { command: runtime.execPath, args: [ultraLauncher, ...(isForcedPiSession() ? ["--force-model"] : []), ...args] };
	}
	if (isForcedPiSession()) throw new Error("Forced subagents require a verified Ultra launcher; stock Pi fallback is disabled.");

	const currentScript = runtime.currentScript;
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: runtime.execPath, args: [currentScript, ...args] };
	}
	const execName = path.basename(runtime.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) return { command: runtime.execPath, args };
	return { command: "pi", args };
}

/** Only deliberate Pi launches use this; ordinary shell children get no force marker. */
export function piChildEnvironment(base: NodeJS.ProcessEnv = process.env) {
	const env = { ...base };
	const heapOption = "--max-old-space-size=8192";
	if (!env.NODE_OPTIONS?.trimEnd().endsWith(heapOption)) {
		env.NODE_OPTIONS = `${env.NODE_OPTIONS ? `${env.NODE_OPTIONS.trimEnd()} ` : ""}${heapOption}`;
	}
	delete env.PI_CODEX_ULTRA_FORCE_MODEL;
	if (isForcedPiSession()) delete env.PI_CODEX_ULTRA_UPDATE_CHECKED;
	return env;
}

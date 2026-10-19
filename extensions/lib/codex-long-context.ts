import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

/** Resolve explicit Ultra Long aliases only at the raw HTTP boundary. */
export async function codexWireModelId(modelId: string): Promise<string> {
	if (!modelId.endsWith("-long")) return modelId;
	const releaseRoot = process.env.PI_CODEX_ULTRA_RELEASE_ROOT;
	const stateDir = releaseRoot ? dirname(dirname(releaseRoot)) : process.env.PI_CODEX_ULTRA_HOME
		|| join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "pi-codex-ultra");
	const roots = releaseRoot ? [releaseRoot, join(stateDir, "current")] : [join(stateDir, "current")];
	for (const root of roots) {
		let registryPath: string;
		try {
			registryPath = await realpath(join(root, "suite", "runtime", "long-context-models.mjs"));
		} catch (error) {
			if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) continue;
			throw error;
		}
		// Resolve current to its immutable release path before importing, so updates do not reuse an old module.
		const registry = await import(pathToFileURL(registryPath).href);
		return registry.getCodexLongContextModel(modelId)?.baseId ?? modelId;
	}
	return modelId;
}

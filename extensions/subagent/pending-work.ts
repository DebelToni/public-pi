import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { getAgentDir, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { readContinuationManifest, type ContinuationManifest } from "./continuation-store.js";

const RESUMABLE = new Set(["running", "pending", "interrupted"]);
const TERMINAL = new Set(["completed", "failed"]);
const MODES = new Set(["single", "parallel", "fan-in", "chain"]);
const NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

function resultStatus(value: any) {
	if (!value || typeof value !== "object") return undefined;
	if (typeof value.status === "string") return value.status;
	if (value.exitCode === -1) return "running";
	if (value.stopReason === "aborted") return "interrupted";
	if (value.exitCode === 0 && value.stopReason !== "error") return "completed";
	if (typeof value.exitCode === "number") return "failed";
	return undefined;
}

function resultIsRecoverable(value: any) {
	const status = resultStatus(value);
	return !!value && (RESUMABLE.has(status ?? "") || status === "failed" && value.resume && /(?:usage[ _-]?limit|rate[ _-]?limit|quota|too many requests|out of (?:credits|budget)|credit balance (?:is )?too low|insufficient (?:credits|balance)|available balance)/i.test(String(value.errorMessage ?? "")));
}

function resultIsTerminal(value: any) {
	const status = resultStatus(value);
	return !!status && TERMINAL.has(status) && !resultIsRecoverable(value);
}

function detailsHaveRecoverableWork(details: any) {
	return Array.isArray(details?.results) && details.results.some(resultIsRecoverable);
}

function detailsAreTerminal(details: any) {
	return MODES.has(details?.mode) && Array.isArray(details.results) && details.results.every(resultIsTerminal);
}

export function hasOutstandingNamedInvocations(branch: readonly SessionEntry[]) {
	const calls: string[] = [];
	const terminal = new Set<string>();
	const delivered = new Set<string>();
	for (const entry of branch) {
		if (entry.type === "message" && entry.message.role === "assistant"
			&& entry.message.stopReason !== "aborted" && entry.message.stopReason !== "error") {
			for (const part of entry.message.content) {
				if (part.type === "toolCall" && part.name === "invoke_subagent" && typeof part.id === "string"
					&& typeof part.arguments?.name === "string" && NAME_PATTERN.test(part.arguments.name)
					&& typeof part.arguments?.prompt === "string") calls.push(part.id);
			}
		} else if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "invoke_subagent") {
			if (resultIsTerminal((entry.message.details as any)?.result)) terminal.add(entry.message.toolCallId);
		} else if (entry.type === "custom_message" && entry.customType === "named-subagent-continuation-result") {
			const ids = (entry.details as any)?.toolCallIds;
			if (Array.isArray(ids)) for (const id of ids) if (typeof id === "string") delivered.add(id);
		}
	}
	return calls.some((id) => !terminal.has(id) && !delivered.has(id));
}

function namedStateHasPending(sessionId: string) {
	const root = join(getAgentDir(), "subagent-runs", "named", createHash("sha256").update(sessionId).digest("hex"));
	let names: string[];
	try { names = readdirSync(root); } catch { return false; }
	for (const name of names) {
		if (!name.endsWith(".json")) continue;
		try {
			const state = JSON.parse(readFileSync(join(root, name), "utf8"));
			if (state?.pending && !resultIsTerminal(state.pending)) return true;
			const receipt = state?.continuation;
			if (receipt && !resultIsTerminal(receipt.result)) return true;
		} catch {
			// Existing malformed named state must not be silently orphaned.
			return true;
		}
	}
	return false;
}

export type PendingWorkReason = "subagent-continuation" | "named-subagent-invocation" | "named-subagent-state";

/** Conservative, model-free guard for session replacement. False positives are safer than orphaning work. */
export function pendingSessionWork(
	branch: readonly SessionEntry[],
	owner: { sessionId: string; sessionFile?: string },
	testOverrides?: { manifests?: ContinuationManifest[]; namedStatePending?: boolean },
): PendingWorkReason | undefined {
	if (hasOutstandingNamedInvocations(branch)) return "named-subagent-invocation";
	if (testOverrides?.namedStatePending ?? namedStateHasPending(owner.sessionId)) return "named-subagent-state";

	const calls: string[] = [];
	const results = new Map<string, any>();
	const states = new Map<string, any>();
	const delivered = new Set<string>();
	for (const entry of branch) {
		if (entry.type === "message" && entry.message.role === "assistant"
			&& entry.message.stopReason !== "aborted" && entry.message.stopReason !== "error") {
			for (const part of entry.message.content) if (part.type === "toolCall" && part.name === "subagent" && typeof part.id === "string") calls.push(part.id);
		} else if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "subagent") {
			results.set(entry.message.toolCallId, entry.message.details);
		} else if (entry.type === "custom" && entry.customType === "subagent-continuation") {
			const state = entry.data as any;
			if (typeof state?.id === "string") states.set(state.id, state);
		} else if (entry.type === "custom_message" && entry.customType === "subagent-continuation-result") {
			const id = (entry.details as any)?.continuationId;
			if (typeof id === "string") delivered.add(id);
		}
	}
	const ownerFile = owner.sessionFile ? resolve(owner.sessionFile) : undefined;
	const overrideManifests = testOverrides?.manifests
		? new Map(testOverrides.manifests.map((manifest) => [manifest.parentToolCallId, manifest]))
		: undefined;
	for (let index = calls.length - 1; index >= 0; index--) {
		const id = calls[index];
		if (delivered.has(id) || states.get(id)?.status === "completed") continue;
		const result = results.get(id);
		if (results.has(id) && detailsAreTerminal(result)) continue;
		const manifest = overrideManifests?.get(id) ?? readContinuationManifest(id, undefined, owner.sessionId);
		const ownedManifest = manifest?.parentSessionId === owner.sessionId
			&& (!ownerFile || !manifest.parentSessionFile || resolve(manifest.parentSessionFile) === ownerFile)
			? manifest
			: undefined;
		if (ownedManifest || detailsHaveRecoverableWork(states.get(id)?.details)
			|| detailsHaveRecoverableWork(result) || !detailsAreTerminal(result)) return "subagent-continuation";
	}
	return undefined;
}

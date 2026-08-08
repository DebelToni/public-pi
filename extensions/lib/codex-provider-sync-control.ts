import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";

export const CODEX_PROVIDER_SYNC_CONTROL_CHANNEL = "codex-provider-sync:control";

export type CodexProviderSyncControl = {
	action: "arm" | "cancel";
	token: string;
	provider?: string;
	model?: string;
	accepted?: boolean;
};

export function armProviderSyncSuppression(pi: ExtensionAPI, provider: string, model: string) {
	const request: CodexProviderSyncControl = { action: "arm", token: randomUUID(), provider, model };
	pi.events.emit(CODEX_PROVIDER_SYNC_CONTROL_CHANNEL, request);
	return request.accepted ? request.token : undefined;
}

export function cancelProviderSyncSuppression(pi: ExtensionAPI, token: string) {
	pi.events.emit(CODEX_PROVIDER_SYNC_CONTROL_CHANNEL, { action: "cancel", token } satisfies CodexProviderSyncControl);
}

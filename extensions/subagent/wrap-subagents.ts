import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";

export const WRAP_SUBAGENT_MESSAGE =
	"Wrap up now: stop expanding scope, finish the current safe unit of work, verify what you can quickly, and return a concise result with any unfinished work clearly identified.";

const activeSubagents = new Map<symbol, () => boolean>();

export function registerActiveSubagent(sendWrapSignal: () => boolean) {
	const id = Symbol("active-subagent");
	activeSubagents.set(id, sendWrapSignal);
	let released = false;
	return () => {
		if (released) return;
		released = true;
		activeSubagents.delete(id);
	};
}

export function requestActiveSubagentsWrap() {
	let sent = 0;
	let failed = 0;
	for (const [id, sendWrapSignal] of activeSubagents) {
		try {
			if (sendWrapSignal()) sent++;
			else {
				activeSubagents.delete(id);
				failed++;
			}
		} catch {
			activeSubagents.delete(id);
			failed++;
		}
	}
	return { sent, failed };
}

export function installSubagentWrapSupport(pi: ExtensionAPI) {
	pi.registerCommand("wrap-subagents", {
		description: "Ask every currently running subagent to finish and return promptly",
		handler: async (_args: string, context: ExtensionCommandContext) => {
			const result = requestActiveSubagentsWrap();
			if (result.sent === 0) {
				context.ui.notify(
					result.failed ? `Could not reach ${result.failed} active subagent(s).` : "No active subagents to wrap up.",
					result.failed ? "warning" : "info",
				);
				return;
			}
			const failures = result.failed ? `; ${result.failed} could not be reached` : "";
			context.ui.notify(
				`Asked ${result.sent} active subagent${result.sent === 1 ? "" : "s"} to wrap up${failures}.`,
				result.failed ? "warning" : "info",
			);
		},
	});

	if (process.env.PI_SUBAGENT !== "1") return;

	let activeContext: ExtensionContext | undefined;
	let wrapPending = false;
	let retryTimer: NodeJS.Timeout | undefined;
	const tryWrap = () => {
		if (!wrapPending) return;
		if (!activeContext || activeContext.isIdle()) {
			wrapPending = false;
			return;
		}
		try {
			pi.sendUserMessage(WRAP_SUBAGENT_MESSAGE, { deliverAs: "steer" });
			wrapPending = false;
		} catch {
			if (retryTimer) return;
			retryTimer = setTimeout(() => {
				retryTimer = undefined;
				tryWrap();
			}, 100);
			retryTimer.unref();
		}
	};
	const wrapNow = () => {
		wrapPending = true;
		tryWrap();
	};

	pi.on("session_start", (_event, context) => {
		activeContext = context;
		process.removeListener("SIGUSR2", wrapNow);
		process.on("SIGUSR2", wrapNow);
	});

	pi.on("session_shutdown", () => {
		process.removeListener("SIGUSR2", wrapNow);
		if (retryTimer) clearTimeout(retryTimer);
		retryTimer = undefined;
		wrapPending = false;
		activeContext = undefined;
	});
}

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { unwatchFile, watchFile } from "node:fs";
import {
	queryCodexProviderUsage,
	requestCodexAccountSelection,
	requestCodexSeatChange,
	verifiedSeatActivationFailureMessage,
	verifiedSeatChangeMessage,
	type CodexUsageStatus,
} from "../codex-accounts/index.js";
import {
	CODEX_USAGE_LIMIT_SIGNAL_CHANNEL,
	getCodexUsageLimitCandidate,
	isCodexProvider,
	type CodexUsageLimitSignal,
} from "../codex-accounts/auto-recovery.js";
import { requestContinuation } from "./continuation-request.js";
import {
	AUTO_RECOVERY_CONFIG_PATH,
	AUTO_RECOVERY_PREFIX_KEY,
	MODEL_STATUS_PREFIX_CHANNEL,
	abandonRecovery,
	completeRecovery,
	joinRecovery,
	readAutoRecoveryEnabled,
	readCoordinatorStatus,
	readProviderSyncId,
	readRecoveryState,
	setAutoRecoveryEnabled,
	type RecoveryState,
} from "./recovery-state.js";

type RecoveryCandidate = {
	provider: string;
	model: string;
	requestSyncId?: string;
};

type DetectedRecoveryCandidate = RecoveryCandidate & {
	holdUntilSettled: boolean;
};

type PendingRecovery = {
	generation: number;
	context: ExtensionContext;
	sessionEpoch: number;
};

type AutoSubscriptionResult = { provider: string; modelId: string; syncId: string };

function parseUsageLimitSignal(value: unknown): CodexUsageLimitSignal | undefined {
	if (!value || typeof value !== "object") return undefined;
	const signal = value as Partial<CodexUsageLimitSignal>;
	if (
		typeof signal.provider !== "string" ||
		typeof signal.model !== "string" ||
		!isCodexProvider(signal.provider) ||
		!signal.context ||
		typeof signal.context !== "object" ||
		typeof signal.context.isIdle !== "function"
	) {
		return undefined;
	}
	return signal as CodexUsageLimitSignal;
}

const AUTO_RECOVERY_STATUS_KEY = "codex-auto-recovery";
const CODEX_QUOTA_EVENT_CHANNEL = "codex-quota-log:event:v1";
export const AUTO_RECOVERY_USAGE_THRESHOLD_PERCENT = 10;
const AUTO_RECOVERY_POLL_MS = 250;
const AUTO_RECOVERY_WAIT_TIMEOUT_MS = 20 * 60_000;

function recoveryStateText(state?: RecoveryState) {
	if (!state) return "idle";
	return `${state.status} (generation ${state.generation})`;
}

async function recordQuotaEvent(
	pi: ExtensionAPI,
	kind: "confirmed-exhaustion" | "provider-selected",
	provider: string,
) {
	const request: { version: 1; kind: typeof kind; provider: string; run?: Promise<void> } = {
		version: 1,
		kind,
		provider,
	};
	pi.events.emit(CODEX_QUOTA_EVENT_CHANNEL, request);
	try {
		await request.run;
	} catch {
		/* Quota history is optional and must never block account recovery. */
	}
}

function processIsAlive(pid: number) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return !!error && typeof error === "object" && "code" in error && error.code === "EPERM";
	}
}

type AutoRecoveryOperations = {
	readEnabled: typeof readAutoRecoveryEnabled;
	readState: typeof readRecoveryState;
	readSyncId: typeof readProviderSyncId;
	join: typeof joinRecovery;
	abandon: typeof abandonRecovery;
	complete: typeof completeRecovery;
	setEnabled: typeof setAutoRecoveryEnabled;
	readStatus: typeof readCoordinatorStatus;
	confirmFailedUsage(context: ExtensionContext, provider: string): Promise<CodexUsageStatus>;
	selectReplacement(
		pi: ExtensionAPI,
		context: ExtensionContext,
		model: string,
		guard: () => boolean,
	): Promise<AutoSubscriptionResult | undefined>;
	isProcessAlive: typeof processIsAlive;
};

async function requestRecoveryReplacement(
	pi: ExtensionAPI,
	context: ExtensionContext,
	model: string,
	guard: () => boolean,
): Promise<AutoSubscriptionResult | undefined> {
	context.ui.notify("Requesting a ChatGPT seat change from the private companion...", "info");
	const seat = await requestCodexSeatChange(pi, context, guard);
	if (seat.status !== "succeeded") {
		context.ui.notify(
			`ChatGPT seat recovery ${seat.status}: ${seat.message}`,
			seat.status === "failed" ? "error" : "warning",
		);
		return undefined;
	}
	context.ui.notify(verifiedSeatChangeMessage(seat), "info");
	const selection = await requestCodexAccountSelection(pi, context, model, guard, seat.accountLabel);
	if (selection.status !== "selected") {
		context.ui.notify(verifiedSeatActivationFailureMessage(seat, model, selection.message), "error");
		return undefined;
	}
	return { provider: selection.provider, modelId: selection.modelId, syncId: selection.syncId };
}

const DEFAULT_AUTO_RECOVERY_OPERATIONS: AutoRecoveryOperations = {
	readEnabled: readAutoRecoveryEnabled,
	readState: readRecoveryState,
	readSyncId: readProviderSyncId,
	join: joinRecovery,
	abandon: abandonRecovery,
	complete: completeRecovery,
	setEnabled: setAutoRecoveryEnabled,
	readStatus: readCoordinatorStatus,
	confirmFailedUsage: (context, provider) => queryCodexProviderUsage(context, provider),
	selectReplacement: (pi, context, model, guard) => requestRecoveryReplacement(pi, context, model, guard),
	isProcessAlive: processIsAlive,
};

export function installAutoRecovery(
	pi: ExtensionAPI,
	overrides: Partial<AutoRecoveryOperations> = {},
) {
	const operations = { ...DEFAULT_AUTO_RECOVERY_OPERATIONS, ...overrides };
	let enabled = operations.readEnabled();
	let activeContext: ExtensionContext | undefined;
	let requestCapture: RecoveryCandidate | undefined;
	let detectedCandidate: DetectedRecoveryCandidate | undefined;
	let pending: PendingRecovery | undefined;
	let pollTimer: NodeJS.Timeout | undefined;
	let prefixTimer: NodeJS.Timeout | undefined;
	let settledTimer: NodeJS.Timeout | undefined;
	let polling = false;
	let shuttingDown = false;
	let sessionEpoch = 0;
	let quotaFalsePositiveRetryUsed = false;
	const handledGenerations = new Set<number>();
	const continuationRuns = new Map<number, Promise<void>>();
	const coordinatorErrorGenerations = new Set<number>();
	const isCurrentSession = (value: PendingRecovery) => !shuttingDown && value.sessionEpoch === sessionEpoch;

	const setRecoveryStatus = (context: ExtensionContext, text?: string) => {
		try { context.ui.setStatus(AUTO_RECOVERY_STATUS_KEY, text); } catch {}
	};
	const notify = (context: ExtensionContext, message: string, level: "info" | "warning" | "error") => {
		try { context.ui.notify(message, level); } catch {}
	};
	const wait = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
	const renderPrefix = () => {
		if (!activeContext) return;
		pi.events.emit(MODEL_STATUS_PREFIX_CHANNEL, {
			key: AUTO_RECOVERY_PREFIX_KEY,
			value: enabled ? "~" : undefined,
			order: 100,
		});
	};
	const schedulePrefix = () => {
		if (prefixTimer) clearTimeout(prefixTimer);
		prefixTimer = setTimeout(() => {
			prefixTimer = undefined;
			renderPrefix();
		}, 50);
		prefixTimer.unref();
	};
	const stopWaiting = () => {
		if (pending) setRecoveryStatus(pending.context);
		pending = undefined;
		detectedCandidate = undefined;
	};
	const refreshEnabled = () => {
		const next = operations.readEnabled();
		if (next === enabled) return;
		enabled = next;
		if (!enabled) stopWaiting();
		renderPrefix();
	};
	const configChanged = () => refreshEnabled();

	const finishLeader = async (
		generation: number,
		result: "succeeded" | "failed",
		selection?: AutoSubscriptionResult,
		failureCode?: string,
	) => {
		try {
			const completion = await operations.complete(
				generation,
				result,
				selection ? { provider: selection.provider, model: selection.modelId, syncId: selection.syncId } : undefined,
				failureCode,
			);
			if (!completion.committed && pending?.generation === generation) {
				const context = pending.context;
				if (!completion.state) {
					pending = undefined;
					setRecoveryStatus(context);
				}
				notify(context, "Codex automatic recovery lost coordinator ownership; this session remains stopped.", "error");
			}
		} catch (error) {
			if (pending?.generation === generation) {
				const context = pending.context;
				pending = undefined;
				setRecoveryStatus(context);
				notify(
					context,
					`Codex recovery coordinator failed: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
			}
		}
	};

	const runLeader = async (candidate: RecoveryCandidate, localPending: PendingRecovery) => {
		const { generation, context } = localPending;
		const syncUnchanged = () =>
			!candidate.requestSyncId || operations.readSyncId(candidate.provider, candidate.model) === candidate.requestSyncId;
		const selectionAllowed = () => {
			const state = operations.readState();
			return pending === localPending &&
				isCurrentSession(localPending) &&
				context.isIdle() &&
				operations.readEnabled() &&
				syncUnchanged() &&
				state?.status === "switching" &&
				state.generation === generation &&
				state.leaderPid === process.pid &&
				typeof state.startedAt === "number" &&
				Date.now() - state.startedAt < AUTO_RECOVERY_WAIT_TIMEOUT_MS;
		};
		const fail = async (code: string, message?: string) => {
			if (message && isCurrentSession(localPending)) notify(context, message, "warning");
			await finishLeader(generation, "failed", undefined, code);
		};
		try {
			if (!isCurrentSession(localPending)) {
				await fail("session-ended");
				return;
			}
			if (!operations.readEnabled()) {
				await fail("disabled-before-switch");
				return;
			}
			if (!context.isIdle()) {
				await fail("session-became-active", "Codex automatic recovery stopped because this session became active.");
				return;
			}
			if (!syncUnchanged()) {
				await fail("provider-changed", "Codex automatic recovery stopped because the global provider changed.");
				return;
			}

			let failedUsage: CodexUsageStatus;
			try {
				failedUsage = await operations.confirmFailedUsage(context, candidate.provider);
			} catch (error) {
				if (!isCurrentSession(localPending)) await fail("session-ended");
				else {
					await fail(
						"quota-confirmation-failed",
						`Codex automatic recovery could not confirm subscription exhaustion: ${error instanceof Error ? error.message : String(error)}`,
					);
				}
				return;
			}
			if (!isCurrentSession(localPending)) {
				await fail("session-ended");
				return;
			}
			if (failedUsage.score < 0 || failedUsage.score >= AUTO_RECOVERY_USAGE_THRESHOLD_PERCENT) {
				await fail(
					"quota-not-exhausted",
					`Codex automatic recovery did not switch accounts because live usage reported ${failedUsage.label}; automatic rotation requires less than ${AUTO_RECOVERY_USAGE_THRESHOLD_PERCENT}% remaining.`,
				);
				return;
			}
			notify(
				context,
				`Confirmed an exact ChatGPT usage-limit error with ${failedUsage.label}; selecting a replacement account because less than ${AUTO_RECOVERY_USAGE_THRESHOLD_PERCENT}% remains…`,
				"warning",
			);
			await recordQuotaEvent(pi, "confirmed-exhaustion", candidate.provider);
			if (!syncUnchanged()) {
				await fail("provider-changed", "Codex automatic recovery stopped because the global provider changed.");
				return;
			}

			const selection = await operations.selectReplacement(pi, context, candidate.model, selectionAllowed);
			if (!selection) {
				if (!isCurrentSession(localPending)) await fail("session-ended");
				else if (!context.isIdle()) await fail("session-became-active", "Codex automatic recovery stopped because this session became active.");
				else if (!syncUnchanged()) await fail("provider-changed", "Codex automatic recovery stopped because the global provider changed.");
				else await fail("account-selection-failed");
				return;
			}
			await recordQuotaEvent(pi, "provider-selected", selection.provider);
			await finishLeader(generation, "succeeded", selection);
		} catch (error) {
			notify(context, `Codex automatic recovery failed: ${error instanceof Error ? error.message : String(error)}`, "error");
			await finishLeader(generation, "failed", undefined, "unexpected-error");
		}
	};

	const pollPending = async () => {
		if (polling || !pending || shuttingDown) return;
		polling = true;
		try {
			if (!isCurrentSession(pending)) {
				stopWaiting();
				return;
			}
			if (!operations.readEnabled()) {
				enabled = false;
				stopWaiting();
				renderPrefix();
				return;
			}
			const state = operations.readState();
			if (!state || state.generation < pending.generation) return;
			if (state.generation > pending.generation) pending = { ...pending, generation: state.generation };
			const localPending = pending;
			if (!localPending) return;
			if (state.status === "switching") {
				if (
					typeof state.startedAt === "number" &&
					Date.now() - state.startedAt >= AUTO_RECOVERY_WAIT_TIMEOUT_MS
				) {
					pending = undefined;
					setRecoveryStatus(localPending.context);
					try {
						await operations.abandon(state.generation);
					} catch (error) {
						notify(
							localPending.context,
							`Codex recovery coordinator timeout failed: ${error instanceof Error ? error.message : String(error)}`,
							"error",
						);
					}
					return;
				}
				if (state.leaderPid && !operations.isProcessAlive(state.leaderPid)) {
					try {
						await operations.abandon(state.generation);
					} catch (error) {
						if (!coordinatorErrorGenerations.has(state.generation)) {
							coordinatorErrorGenerations.add(state.generation);
							notify(
								localPending.context,
								`Codex recovery coordinator failed: ${error instanceof Error ? error.message : String(error)}`,
								"error",
							);
						}
					}
					return;
				}
				setRecoveryStatus(localPending.context, "waiting for global Codex account recovery…");
				return;
			}
			if (state.status === "failed" || !state.selectedProvider || !state.selectedModel || !state.selectedSyncId) {
				pending = undefined;
				setRecoveryStatus(localPending.context);
				if (handledGenerations.has(state.generation)) return;
				handledGenerations.add(state.generation);
				if (state.failureCode === "quota-not-exhausted") {
					if (!quotaFalsePositiveRetryUsed && isCurrentSession(localPending) && localPending.context.isIdle()) {
						quotaFalsePositiveRetryUsed = true;
						notify(localPending.context, "The usage-limit response was not confirmed by live quota; retrying once on the same account…", "info");
						try {
							const run = requestContinuation(pi, localPending.context, { target: "main" }).catch((error) => {
								notify(localPending.context, `The same-account retry failed: ${error instanceof Error ? error.message : String(error)}`, "error");
							});
							continuationRuns.set(state.generation, run);
							void run.finally(() => {
								if (continuationRuns.get(state.generation) === run) continuationRuns.delete(state.generation);
							});
						} catch (error) {
							notify(localPending.context, `The same-account retry failed: ${error instanceof Error ? error.message : String(error)}`, "error");
						}
					} else {
						notify(localPending.context, "The usage-limit response was not confirmed by live quota; the account was left unchanged. Retry the prompt manually if needed.", "warning");
					}
					return;
				}
				notify(localPending.context, "Codex automatic account recovery failed; this session remains stopped for manual intervention.", "warning");
				return;
			}
			if (operations.readSyncId(state.selectedProvider, state.selectedModel) !== state.selectedSyncId) {
				pending = undefined;
				setRecoveryStatus(localPending.context);
				handledGenerations.add(state.generation);
				notify(localPending.context, "The recovered Codex selection was superseded; this session remains stopped.", "warning");
				return;
			}
			if (
				localPending.context.model?.provider !== state.selectedProvider ||
				localPending.context.model?.id !== state.selectedModel
			) {
				setRecoveryStatus(localPending.context, "account selected; waiting for global provider sync…");
				return;
			}
			if (!localPending.context.isIdle()) {
				setRecoveryStatus(localPending.context, "account selected; waiting for session to settle…");
				return;
			}

			pending = undefined;
			setRecoveryStatus(localPending.context);
			if (handledGenerations.has(state.generation)) return;
			handledGenerations.add(state.generation);
			notify(localPending.context, "Codex account recovered globally; continuing this session…", "info");
			try {
				const run = requestContinuation(pi, localPending.context, { target: "main" }).catch((error) => {
					notify(
						localPending.context,
						`Codex account recovered, but /continue failed: ${error instanceof Error ? error.message : String(error)}`,
						"error",
					);
				});
				continuationRuns.set(state.generation, run);
				void run.finally(() => {
					if (continuationRuns.get(state.generation) === run) continuationRuns.delete(state.generation);
				});
			} catch (error) {
				notify(
					localPending.context,
					`Codex account recovered, but /continue failed: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
			}
		} finally {
			polling = false;
		}
	};

	const beginRecovery = async (
		candidate: RecoveryCandidate,
		context: ExtensionContext,
		recoverySessionEpoch: number,
		waitForCompletion = false,
	) => {
		if (shuttingDown || recoverySessionEpoch !== sessionEpoch || !operations.readEnabled()) return;
		try {
			const joined = await operations.join(candidate.provider, candidate.model, candidate.requestSyncId);
			const state = joined.state;
			if (joined.action === "disabled" || !state || handledGenerations.has(state.generation)) return;
			if (shuttingDown || recoverySessionEpoch !== sessionEpoch) {
				if (joined.action === "leader") await finishLeader(state.generation, "failed", undefined, "session-ended");
				return;
			}
			if (pending && pending.generation >= state.generation) return;
			const localPending = { generation: state.generation, context, sessionEpoch: recoverySessionEpoch };
			pending = localPending;
			setRecoveryStatus(context, "waiting for global Codex account recovery…");
			if (joined.action === "leader") {
				notify(context, "Codex reported a subscription usage-limit error; verifying live quota before recovery…", "warning");
				void runLeader(candidate, localPending).finally(() => void pollPending());
			} else if (state.status === "switching") {
				notify(context, "Joined global Codex quota verification; waiting…", "warning");
			}
			void pollPending();
			if (waitForCompletion) {
				const waitDeadline = Date.now() + AUTO_RECOVERY_WAIT_TIMEOUT_MS;
				while (isCurrentSession(localPending) && pending && pending.generation >= state.generation) {
					if (Date.now() >= waitDeadline) {
						pending = undefined;
						try {
							await operations.abandon(state.generation);
						} catch {}
						setRecoveryStatus(context);
						notify(
							context,
							"Codex automatic recovery timed out; this session remains stopped for manual intervention.",
							"warning",
						);
						break;
					}
					await pollPending();
					if (pending) await wait(50);
				}
				const continuation = [...continuationRuns.entries()]
					.filter(([generation]) => generation >= state.generation)
					.sort(([left], [right]) => left - right)[0]?.[1];
				if (continuation) await continuation;
			}
		} catch (error) {
			notify(context, `Codex recovery coordinator failed: ${error instanceof Error ? error.message : String(error)}`, "error");
		}
	};

	const runDetectedRecovery = async (
		context: ExtensionContext,
		recoverySessionEpoch: number,
		waitForCompletion = false,
	) => {
		if (!context.isIdle()) return;
		const candidate = detectedCandidate;
		if (!candidate || pending || !enabled || shuttingDown || recoverySessionEpoch !== sessionEpoch) return;
		detectedCandidate = undefined;
		await beginRecovery(candidate, context, recoverySessionEpoch, waitForCompletion);
	};

	const scheduleDetectedRecovery = (context: ExtensionContext, recoverySessionEpoch: number) => {
		if (settledTimer) clearTimeout(settledTimer);
		settledTimer = setTimeout(() => {
			settledTimer = undefined;
			void runDetectedRecovery(context, recoverySessionEpoch);
		}, 0);
	};

	const recordDetectedCandidate = (
		candidate: Pick<RecoveryCandidate, "provider" | "model">,
		context: ExtensionContext,
		requestSyncId?: string,
		holdUntilSettled = false,
	) => {
		if (!enabled || shuttingDown || pending) return;
		if (detectedCandidate?.holdUntilSettled && !holdUntilSettled) return;
		detectedCandidate = {
			...candidate,
			requestSyncId: requestSyncId ?? operations.readSyncId(candidate.provider, candidate.model),
			holdUntilSettled,
		};
		if (context.mode !== "json" && context.mode !== "print") {
			scheduleDetectedRecovery(context, sessionEpoch);
		}
	};

	const unsubscribeUsageLimitSignals = pi.events.on(CODEX_USAGE_LIMIT_SIGNAL_CHANNEL, (value) => {
		const signal = parseUsageLimitSignal(value);
		if (!signal) return;
		recordDetectedCandidate(signal, signal.context, undefined, true);
	});

	pi.on("session_start", (_event, context) => {
		sessionEpoch++;
		quotaFalsePositiveRetryUsed = false;
		shuttingDown = false;
		activeContext = context;
		enabled = operations.readEnabled();
		unwatchFile(AUTO_RECOVERY_CONFIG_PATH, configChanged);
		watchFile(AUTO_RECOVERY_CONFIG_PATH, { persistent: false, interval: AUTO_RECOVERY_POLL_MS }, configChanged);
		renderPrefix();
		if (enabled) schedulePrefix();
		if (pollTimer) clearInterval(pollTimer);
		pollTimer = setInterval(() => void pollPending(), AUTO_RECOVERY_POLL_MS);
		pollTimer.unref();
	});

	pi.on("before_provider_request", (_event, context) => {
		const model = context.model;
		requestCapture = model && isCodexProvider(model.provider)
			? { provider: model.provider, model: model.id, requestSyncId: operations.readSyncId(model.provider, model.id) }
			: undefined;
	});

	pi.on("message_end", (event, context) => {
		if (event.message.role !== "assistant") return;
		const capture = requestCapture;
		requestCapture = undefined;
		const candidate = getCodexUsageLimitCandidate(event.message);
		if (!enabled) {
			detectedCandidate = undefined;
			return;
		}
		if (!candidate) {
			if (event.message.stopReason !== "error") quotaFalsePositiveRetryUsed = false;
			if (!detectedCandidate?.holdUntilSettled) detectedCandidate = undefined;
			return;
		}
		recordDetectedCandidate(
			candidate,
			context,
			capture?.provider === candidate.provider && capture.model === candidate.model
				? capture.requestSyncId
				: undefined,
		);
	});

	pi.on("agent_settled", async (_event, context) => {
		if (!detectedCandidate) return;
		if (context.mode === "json" || context.mode === "print") {
			if (settledTimer) clearTimeout(settledTimer);
			settledTimer = undefined;
			await runDetectedRecovery(context, sessionEpoch, true);
			return;
		}
		scheduleDetectedRecovery(context, sessionEpoch);
	});

	pi.on("session_shutdown", () => {
		unsubscribeUsageLimitSignals();
		sessionEpoch++;
		shuttingDown = true;
		unwatchFile(AUTO_RECOVERY_CONFIG_PATH, configChanged);
		if (pollTimer) clearInterval(pollTimer);
		if (prefixTimer) clearTimeout(prefixTimer);
		if (settledTimer) clearTimeout(settledTimer);
		pollTimer = undefined;
		prefixTimer = undefined;
		settledTimer = undefined;
		stopWaiting();
		pi.events.emit(MODEL_STATUS_PREFIX_CHANNEL, { key: AUTO_RECOVERY_PREFIX_KEY, value: undefined, order: 100 });
		activeContext = undefined;
		requestCapture = undefined;
	});

	pi.registerCommand("codex-auto-recovery", {
		description: "Enable, disable, or inspect global automatic Codex account recovery",
		handler: async (args, context) => {
			const action = args.trim().toLowerCase() || "status";
			if (action === "on" || action === "off") {
				const next = action === "on";
				await operations.setEnabled(next);
				enabled = next;
				if (!enabled) stopWaiting();
				renderPrefix();
				if (enabled) schedulePrefix();
				context.ui.notify(
					`Codex automatic account recovery ${enabled ? "enabled" : "disabled"} globally.`,
					enabled ? "info" : "warning",
				);
				return;
			}
			if (action !== "status") {
				context.ui.notify("Usage: /codex-auto-recovery on|off|status", "warning");
				return;
			}
			const status = await operations.readStatus();
			context.ui.notify(
				`Codex automatic account recovery is ${status.config.enabled ? "on" : "off"}; ${recoveryStateText(status.state)}.`,
				"info",
			);
		},
	});
}

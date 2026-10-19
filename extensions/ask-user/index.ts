import { randomUUID } from "node:crypto";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { OverlayHandle, TUI } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import {
	ASK_USER_STATE_ENTRY,
	answerSummary,
	cloneQuestionnaireState,
	commitAnswer,
	addClarification,
	isReadyForReview,
	visibleQuestions,
	isQuestionnaireState,
	markCancelled,
	markCompleted,
	markWaiting,
	mergeQuestionnaire,
	questionnaireStateFromSnapshot,
	type QuestionnaireState,
} from "./state.js";
import { type PanelEvent, QuestionnairePanel } from "./ui.js";

const STATUS_KEY = "ask-user";
const SHORTCUT = "alt+q";

const OptionSchema = Type.Object({
	value: Type.String({ description: "Stable value returned to you" }),
	label: Type.String({ description: "Short option label shown to the user" }),
	description: Type.Optional(Type.String({ description: "One concise line of useful context" })),
});

const ConditionSchema = Type.Object({
	question_id: Type.String({ description: "ID of an earlier question" }),
	operator: Type.Optional(StringEnum(["equals", "includes", "not_equals", "not_includes"] as const)),
	value: Type.String({ description: "Answer value to test" }),
});

const QuestionSchema = Type.Object({
	id: Type.String({ description: "Stable unique question ID. Reuse it only to revise that question." }),
	prompt: Type.String({ description: "Question shown to the user" }),
	label: Type.Optional(Type.String({ description: "Short navigation and answer-summary label" })),
	kind: Type.Optional(StringEnum(["single", "multi", "text"] as const, { description: "Defaults to single" })),
	options: Type.Optional(Type.Array(OptionSchema, { maxItems: 20, description: "Required for single and multi questions" })),
	allow_other: Type.Optional(Type.Boolean({ description: "Offer a free-written answer for choice questions. Defaults to true." })),
	show_if: Type.Optional(Type.Array(ConditionSchema, {
		maxItems: 10,
		description: "All conditions must match. This defines conditional graph follow-ups.",
	})),
});

export const AskUserParameters = Type.Object({
	questionnaire_id: Type.Optional(Type.String({
		description: "ID returned by an earlier ask_user call. Omit on the first call when no questionnaire is active.",
	})),
	title: Type.Optional(Type.String({ description: "Optional task-specific subtitle. The UI title remains Questionnaire." })),
	message: Type.Optional(Type.String({
		description: "If a clarification is pending, this automatically answers the latest one and remains scoped to its question. Otherwise this is concise general context for the questionnaire round.",
	})),
	questions: Type.Optional(Type.Array(QuestionSchema, {
		maxItems: 50,
		description: "Questions to add or update by ID. Omit when only changing message/final state.",
	})),
	remove_question_ids: Type.Optional(Type.Array(Type.String(), {
		maxItems: 50,
		description: "Questions to remove. Their answers and dependent answers are invalidated.",
	})),
	final: Type.Optional(Type.Boolean({
		description: "Set true only when no more model-authored questions are needed. The user can then submit final answers.",
	})),
});

export type AskUserInput = Static<typeof AskUserParameters>;

type AskUserResultStatus = "needs_more_questions" | "needs_clarification" | "completed" | "cancelled" | "unavailable";

export interface AskUserDetails {
	status: AskUserResultStatus;
	questionnaireId?: string;
	state?: QuestionnaireState;
	answers?: ReturnType<typeof answerSummary>;
	clarification?: string;
	clarificationQuestionId?: string;
}

function inputUpdate(params: AskUserInput) {
	return {
		questionnaireId: params.questionnaire_id,
		title: params.title,
		message: params.message,
		questions: params.questions?.map((question) => ({
			id: question.id,
			prompt: question.prompt,
			label: question.label,
			kind: question.kind,
			options: question.options,
			allowOther: question.allow_other,
			showIf: question.show_if?.map((condition) => ({
				questionId: condition.question_id,
				operator: condition.operator,
				value: condition.value,
			})),
		})),
		removeQuestionIds: params.remove_question_ids,
		final: params.final,
	};
}

function textResult(text: string, details: AskUserDetails) {
	return { content: [{ type: "text" as const, text }], details };
}

function summaryLines(state: QuestionnaireState) {
	return answerSummary(state).map((answer) => {
		const values = answer.values.map((value, index) => {
			const label = answer.labels[index] ?? value;
			const stableValue = JSON.stringify(value);
			return label === value ? stableValue : `${stableValue} (${label})`;
		});
		return `- ${answer.id}: ${values.join(", ")}`;
	});
}

function modelResult(state: QuestionnaireState, event: PanelEvent) {
	const answers = answerSummary(state);
	const lines = [`Questionnaire ${state.id}.`, ...summaryLines(state)];
	if (event.kind === "lifecycle") {
		return textResult(`${lines[0]} Interaction interrupted by ${event.reason.replaceAll("_", " ")}; saved branch state was not changed.`, {
			status: "cancelled",
			questionnaireId: state.id,
			state: cloneQuestionnaireState(state),
			answers,
		});
	}
	if (event.kind === "cancel") {
		return textResult(`${lines[0]} User aborted the questionnaire.`, {
			status: "cancelled",
			questionnaireId: state.id,
			state: cloneQuestionnaireState(state),
			answers,
		});
	}
	if (event.kind === "clarification") {
		const exchange = [...state.clarifications].reverse().find((item) => item.response === undefined)
			?? state.clarifications.at(-1);
		const clarification = exchange?.question ?? "";
		const clarificationQuestionId = exchange?.questionId;
		const request = clarificationQuestionId
			? `User clarification request for question ${JSON.stringify(clarificationQuestionId)}: ${clarification}`
			: `User clarification request: ${clarification}`;
		return textResult([
			...lines,
			request,
			"Use normal tools or research if useful, then call ask_user again with message answering it and any new or updated questions. The extension binds the message to this pending clarification automatically, and the questionnaire panel remains visible.",
		].join("\n"), {
			status: "needs_clarification",
			questionnaireId: state.id,
			state: cloneQuestionnaireState(state),
			answers,
			clarification,
			clarificationQuestionId,
		});
	}
	if (state.final) {
		return textResult([...lines, "User submitted the final questionnaire."].join("\n"), {
			status: "completed",
			questionnaireId: state.id,
			state: cloneQuestionnaireState(state),
			answers,
		});
	}
	return textResult([
		...lines,
		"The user completed the currently reachable questions. Decide whether more information is needed, use normal tools or research if useful, then call ask_user again with future questions. If no more questions are needed, call ask_user with final=true so the user can review and submit. The questionnaire panel remains visible.",
	].join("\n"), {
		status: "needs_more_questions",
		questionnaireId: state.id,
		state: cloneQuestionnaireState(state),
		answers,
	});
}

function restoredState(entries: readonly any[]) {
	let latest: QuestionnaireState | undefined;
	for (const entry of entries) {
		if (entry?.type === "custom" && entry.customType === ASK_USER_STATE_ENTRY) {
			const candidate = questionnaireStateFromSnapshot(entry.data);
			if (!candidate) throw new Error("Malformed ask-user-state on the active branch");
			latest = candidate;
		}
		if (entry?.type === "message" && entry.message?.role === "toolResult" && entry.message.toolName === "ask_user") {
			const candidate = entry.message.details?.state;
			if (candidate !== undefined) {
				if (!isQuestionnaireState(candidate)) throw new Error("Malformed ask_user tool state on the active branch");
				latest = cloneQuestionnaireState(candidate);
			}
		}
	}
	return latest;
}

export default function askUserExtension(pi: ExtensionAPI) {
	let state: QuestionnaireState | undefined;
	let panel: QuestionnairePanel | undefined;
	let handle: OverlayHandle | undefined;
	let tui: TUI | undefined;
	let theme: Theme | undefined;
	let sessionId: string | undefined;
	let opening: Promise<void> | undefined;
	let runtimeActive = false;
	let bindingGeneration = 0;
	let activeWaiter: { state: QuestionnaireState; settle: (event: PanelEvent) => void } | undefined;

	const persist = (next: QuestionnaireState) => {
		if (!runtimeActive || state !== next) return;
		pi.appendEntry(ASK_USER_STATE_ENTRY, { state: cloneQuestionnaireState(next) });
	};

	const closePanel = () => {
		handle?.hide();
		handle = undefined;
		panel = undefined;
		tui = undefined;
		theme = undefined;
	};

	const invalidatePanel = () => {
		bindingGeneration++;
		opening = undefined;
		closePanel();
	};

	const captureTui = async (ctx: ExtensionContext) => {
		let capturedTui: TUI | undefined;
		let capturedTheme: Theme | undefined;
		await ctx.ui.custom<void>((currentTui, currentTheme, _keybindings, done) => {
			capturedTui = currentTui;
			capturedTheme = currentTheme;
			done();
			return { render: () => [], invalidate() {} };
		});
		if (!capturedTui || !capturedTheme) throw new Error("Could not access the interactive TUI");
		return { tui: capturedTui, theme: capturedTheme };
	};

	const toggleMountedPanel = () => {
		if (!handle) return;
		if (handle.isFocused()) handle.unfocus();
		else handle.focus();
	};

	const makePassive = () => {
		if (!panel || !handle) return;
		const mountedPanel = panel;
		const mountedHandle = handle;
		const generation = bindingGeneration;
		mountedPanel.setPassive(() => {
			if (runtimeActive && generation === bindingGeneration && panel === mountedPanel && handle === mountedHandle) mountedHandle.unfocus();
		});
		mountedHandle.unfocus();
	};

	const ensurePanel = async (ctx: ExtensionContext, interactive: boolean) => {
		if (!state) throw new Error("No active questionnaire");
		if (!runtimeActive) throw new Error("Questionnaire runtime is not active");
		if (ctx.mode !== "tui") throw new Error("The full Questionnaire UI requires interactive TUI mode");
		if (sessionId && sessionId !== ctx.sessionManager.getSessionId()) throw new Error("Questionnaire session binding changed");
		sessionId = ctx.sessionManager.getSessionId();
		if (!panel || !handle) {
			if (!opening) {
				const generation = bindingGeneration;
				const openingTask = (async () => {
					const captured = await captureTui(ctx);
					if (!runtimeActive || generation !== bindingGeneration) throw new Error("Questionnaire session changed while opening");
					tui = captured.tui;
					theme = captured.theme;
					const mountedPanel = new QuestionnairePanel(state!, tui, theme, (next) => {
						if (runtimeActive && generation === bindingGeneration && panel === mountedPanel) persist(next);
					});
					const mountedHandle = tui.showOverlay(mountedPanel, {
						width: "100%",
						maxHeight: "100%",
						row: 0,
						col: 0,
						margin: 0,
						nonCapturing: true,
					});
					panel = mountedPanel;
					handle = mountedHandle;
					mountedPanel.setFocusToggle(() => {
						if (!runtimeActive || generation !== bindingGeneration || panel !== mountedPanel || handle !== mountedHandle) return;
						if (mountedHandle.isFocused()) mountedHandle.unfocus();
						else mountedHandle.focus();
					});
				})();
				opening = openingTask;
				void openingTask.then(
					() => { if (opening === openingTask) opening = undefined; },
					() => { if (opening === openingTask) opening = undefined; },
				);
			}
			await opening;
		}
		if (interactive) handle!.focus();
		else makePassive();
	};

	const waitForEvent = (ctx: ExtensionContext, callState: QuestionnaireState, signal?: AbortSignal) => {
		if (activeWaiter) throw new Error("Another Questionnaire interaction is already active");
		return new Promise<PanelEvent>((resolve, reject) => {
			let settled = false;
			const cleanup = () => {
				signal?.removeEventListener("abort", onAbort);
				if (activeWaiter?.settle === finish) activeWaiter = undefined;
			};
			const finish = (event: PanelEvent) => {
				if (settled) return;
				settled = true;
				cleanup();
				resolve(event);
			};
			const onAbort = () => finish({ kind: "cancel" });
			activeWaiter = { state: callState, settle: finish };
			signal?.addEventListener("abort", onAbort, { once: true });
			if (signal?.aborted) {
				onAbort();
				return;
			}
			void ensurePanel(ctx, false).then(() => {
				if (settled) return;
				panel!.setState(callState);
				panel!.setInteraction(finish);
				handle!.focus();
			}, (error) => {
				if (settled) return;
				settled = true;
				cleanup();
				reject(error);
			});
		});
	};

	const togglePanel = async (ctx: ExtensionContext) => {
		if (!state || state.phase === "completed" || state.phase === "cancelled") {
			ctx.ui.notify("No active questionnaire.", "info");
			return;
		}
		if (panel && handle) {
			toggleMountedPanel();
			return;
		}
		await ensurePanel(ctx, false);
		handle!.focus();
	};

	const settleForLifecycle = (reason: "session_shutdown" | "session_tree") => {
		activeWaiter?.settle({ kind: "lifecycle", reason });
		activeWaiter = undefined;
	};

	const bindBranch = (ctx: ExtensionContext, reason: "startup" | "reload" | "new" | "resume" | "fork" | "tree") => {
		if (reason === "tree") settleForLifecycle("session_tree");
		runtimeActive = false;
		invalidatePanel();
		sessionId = ctx.sessionManager.getSessionId();
		try {
			state = restoredState(ctx.sessionManager.getBranch());
		} catch (error) {
			state = undefined;
			ctx.ui.notify(`Questionnaire state was not restored: ${error instanceof Error ? error.message : String(error)}`, "error");
		}
		runtimeActive = true;
		const active = state && state.phase !== "completed" && state.phase !== "cancelled";
		ctx.ui.setStatus(STATUS_KEY, active ? `Questionnaire · ${SHORTCUT}` : undefined);
		if (active && ctx.mode === "tui") {
			void ensurePanel(ctx, false).catch((error) => {
				if (runtimeActive) ctx.ui.notify(`Could not restore Questionnaire panel: ${error instanceof Error ? error.message : String(error)}`, "warning");
			});
		}
		return active;
	};

	pi.registerTool({
		name: "ask_user",
		label: "Questionnaire",
		description: "Open or update the persistent Questionnaire UI. Supports single choice, multiple choice, free text, conditional follow-ups, answer revision, and user clarification requests. The user cannot skip active questions. After a needs_more_questions or needs_clarification result, use normal tools/research and call ask_user again; do not create a helper model. Set final=true only when the user can submit.",
		promptSnippet: "Ask the user structured questions in the persistent Questionnaire panel",
		promptGuidelines: [
			"Use ask_user when user decisions or missing requirements materially affect the work.",
			"After ask_user returns needs_more_questions or needs_clarification, the main agent may use normal tools and research, then must call ask_user again to update the same panel; never delegate questionnaire generation to a separate helper model.",
		],
		parameters: AskUserParameters,
		executionMode: "sequential",
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (ctx.mode !== "tui") {
				return textResult("ask_user is unavailable: the full Questionnaire UI requires interactive TUI mode.", { status: "unavailable" });
			}
			if (signal?.aborted) return textResult("ask_user was cancelled before opening.", { status: "cancelled" });
			try {
				if (!runtimeActive) throw new Error("Questionnaire runtime is not active");
				if (state?.phase === "completed" || state?.phase === "cancelled") {
					if (params.questionnaire_id === state.id) throw new Error(`Questionnaire ${state.id} is already ${state.phase}`);
					state = undefined;
				}
				const callState = mergeQuestionnaire(state, inputUpdate(params), () => randomUUID().slice(0, 8));
				state = callState;
				persist(callState);
				ctx.ui.setStatus(STATUS_KEY, `Questionnaire · ${SHORTCUT}`);
				const event = await waitForEvent(ctx, callState, signal);
				if (event.kind === "lifecycle" || !runtimeActive || state !== callState) return modelResult(callState, event.kind === "lifecycle" ? event : { kind: "lifecycle", reason: "session_tree" });
				if (event.kind === "cancel") {
					markCancelled(callState);
					persist(callState);
					invalidatePanel();
					ctx.ui.setStatus(STATUS_KEY, undefined);
					return modelResult(callState, event);
				}
				if (event.kind === "clarification") {
					markWaiting(callState);
					persist(callState);
					panel?.setState(callState);
					makePassive();
					return modelResult(callState, event);
				}
				if (callState.final) {
					markCompleted(callState);
					persist(callState);
					const result = modelResult(callState, event);
					invalidatePanel();
					ctx.ui.setStatus(STATUS_KEY, undefined);
					return result;
				}
				markWaiting(callState);
				persist(callState);
				panel?.setState(callState);
				makePassive();
				return modelResult(callState, event);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				throw new Error(`ask_user: ${message}`);
			}
		},
		renderCall(args, currentTheme, context) {
			const component = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
			const count = args.questions?.length ?? 0;
			component.setText(`${currentTheme.fg("toolTitle", currentTheme.bold("Questionnaire"))}${currentTheme.fg("muted", count ? ` · ${count} question${count === 1 ? "" : "s"}` : " · update")}`);
			return component;
		},
		renderResult(result, _options, currentTheme, context) {
			const component = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
			const details = result.details as AskUserDetails | undefined;
			const icon = details?.status === "completed" ? currentTheme.fg("success", "✓")
				: details?.status === "cancelled" || details?.status === "unavailable" ? currentTheme.fg("warning", "○")
				: currentTheme.fg("accent", "●");
			const count = details?.answers?.length ?? 0;
			component.setText(`${icon} ${currentTheme.fg("accent", details?.status?.replaceAll("_", " ") ?? "finished")}${currentTheme.fg("muted", ` · ${count} answer${count === 1 ? "" : "s"}`)}`);
			return component;
		},
	});

	// Keep web answers on the same validation, branch persistence and waiter path.
	pi.events?.on?.("pi-web:questionnaire", (request: any) => {
		if (!runtimeActive || !state || ["completed", "cancelled"].includes(state.phase)) return;
		if (request.action && request.action !== "read") {
			if (!activeWaiter || state.phase !== "answering") throw new Error("Questionnaire is waiting for the agent");
			if (request.id !== state.id || request.revision !== state.revision) throw new Error("Questionnaire changed. Refresh and try again.");
			if (request.action === "answer") {
				if (!Array.isArray(request.values) || request.values.some((v: unknown) => typeof v !== "string")) throw new Error("Invalid answer");
				commitAnswer(state, request.questionId, request.values, { custom: request.custom === true });
				persist(state);
				panel?.setState(state);
			} else if (request.action === "clarify") {
				addClarification(state, request.questionId, request.text);
				persist(state);
				activeWaiter.settle({ kind: "clarification" });
			} else if (request.action === "submit") {
				if (!isReadyForReview(state)) throw new Error("Answer every active question first");
				activeWaiter.settle({ kind: "continue" });
			} else throw new Error("Unknown questionnaire action");
		}
		request.result = { ...cloneQuestionnaireState(state), visibleQuestions: visibleQuestions(state), ready: isReadyForReview(state), interactive: !!activeWaiter };
	});

	pi.registerCommand("questionnaire", {
		description: "Focus or dismiss the active Questionnaire panel",
		handler: async (_args, ctx) => togglePanel(ctx),
	});
	pi.registerShortcut(SHORTCUT, {
		description: "Focus or dismiss the active Questionnaire panel",
		handler: async (ctx) => togglePanel(ctx),
	});

	pi.on("session_start", (event, ctx) => {
		const active = bindBranch(ctx, event.reason);
		if (active && event.reason !== "startup") {
			ctx.ui.notify("Questionnaire restored. The main agent must call ask_user again to resume an interrupted interaction.", "info");
		}
	});

	pi.on("session_tree", (_event, ctx) => {
		bindBranch(ctx, "tree");
	});

	pi.on("session_shutdown", () => {
		settleForLifecycle("session_shutdown");
		runtimeActive = false;
		invalidatePanel();
	});
}

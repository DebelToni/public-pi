import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { unlinkSync, writeFileSync } from "node:fs";

const STATUS_KEY = "close-on-done";
const PARKING_SESSION_NAME = "B";
const TOKEN_OPTION = "@pi_close_on_done_token";
const RUNTIME_STATE_KEY = "__piCloseOnDoneRuntimeStateV1" as const;

type ParkedWindow = {
	paneId: string;
	windowId: string;
	parkingSessionId: string;
	parkingSessionName: string;
	token: string;
};

type WindowLocation = {
	windowId: string;
	sessionId: string;
	sessionName: string;
	linkedSessions: number;
};

type RuntimeState = {
	parked?: ParkedWindow;
	finalResponseCompleted: boolean;
};

function tmux(args: string[]) {
	return execFileSync("tmux", args, {
		encoding: "utf8",
		env: process.env,
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
}

function parseLocation(value: string): WindowLocation {
	const [windowId, sessionId, sessionName, rawLinkedSessions] = value.split("|");
	const linkedSessions = Number(rawLinkedSessions);
	if (
		!/^@\d+$/.test(windowId ?? "") ||
		!/^\$\d+$/.test(sessionId ?? "") ||
		!sessionName || sessionName.includes("|") ||
		!Number.isInteger(linkedSessions)
	) {
		throw new Error("tmux returned invalid window metadata");
	}
	return { windowId, sessionId, sessionName, linkedSessions };
}

function locationFormat() {
	return "#{window_id}|#{session_id}|#{session_name}|#{window_linked_sessions}";
}

function locatePaneWindow(pane: string) {
	return parseLocation(tmux(["display-message", "-t", pane, "-p", locationFormat()]));
}

function indexedWinlinkTarget(sessionId: string, windowIndex: number) {
	return `${sessionId}:${windowIndex}`;
}

function locateSession(name: string) {
	try {
		const value = tmux(["display-message", "-t", `${name}:`, "-p", "#{session_id}|#{session_name}"]);
		const [sessionId, sessionName] = value.split("|");
		if (!/^\$\d+$/.test(sessionId ?? "") || sessionName !== name) return undefined;
		return { sessionId, sessionName };
	} catch {
		return undefined;
	}
}

function windowIndicesInSession(sessionId: string, windowId: string) {
	return tmux(["list-windows", "-t", sessionId, "-F", "#{window_id}|#{window_index}"])
		.split("\n")
		.filter(Boolean)
		.map((line) => line.split("|"))
		.filter(([candidate]) => candidate === windowId)
		.map(([, rawIndex]) => Number(rawIndex))
		.filter(Number.isInteger);
}

function releasePlaceholder(path: string) {
	try { writeFileSync(path, "", { mode: 0o600 }); } catch {}
	const cleanup = setTimeout(() => { try { unlinkSync(path); } catch {} }, 5000);
	cleanup.unref();
}

function createParkingSession(placeholderReleasePath: string) {
	const created = tmux([
		"new-session", "-d", "-s", PARKING_SESSION_NAME, "-n", "waiting", "-P", "-F", "#{session_id}|#{session_name}",
		`exec /bin/sh -c 'tmux set-option -p -t "$TMUX_PANE" remain-on-exit off; i=0; while [ ! -e ${placeholderReleasePath} ] && [ "$i" -lt 600 ]; do i=$((i + 1)); /bin/sleep 0.05; done; /bin/rm -f ${placeholderReleasePath}'`,
	]);
	const [sessionId, sessionName] = created.split("|");
	if (!/^\$\d+$/.test(sessionId ?? "") || sessionName !== PARKING_SESSION_NAME) {
		throw new Error("tmux returned invalid B-session metadata");
	}
	return { sessionId, sessionName };
}

function ensureParkingSession(placeholderReleasePath: string) {
	const existing = locateSession(PARKING_SESSION_NAME);
	if (existing) return { ...existing, created: false };
	try {
		return { ...createParkingSession(placeholderReleasePath), created: true };
	} catch (error) {
		const raced = locateSession(PARKING_SESSION_NAME);
		if (raced) return { ...raced, created: false };
		throw error;
	}
}

function parkCurrentWindow(pane: string): ParkedWindow {
	const source = locatePaneWindow(pane);
	if (source.linkedSessions !== 1) throw new Error("the current window is linked into more than one tmux session");
	const token = randomUUID();
	const placeholderReleasePath = `/tmp/pi-close-on-done-${process.pid}-${token}.release`;

	try {
		tmux(["set-window-option", "-q", "-t", source.windowId, TOKEN_OPTION, token]);
		let parking = source.sessionName === PARKING_SESSION_NAME
			? { sessionId: source.sessionId, sessionName: source.sessionName, created: false }
			: ensureParkingSession(placeholderReleasePath);

		if (source.sessionId !== parking.sessionId) {
			const movedMarker = `PI_CLOSE_ON_DONE_NOT_MOVED_${token}`;
			const result = tmux([
				"if-shell", "-F", "-t", pane,
				`#{&&:#{==:#{window_id},${source.windowId}},#{==:#{window_linked_sessions},1}}`,
				`move-window -a -d -s ${source.windowId} -t ${parking.sessionId}:`,
				`display-message -p ${movedMarker}`,
			]);
			if (result === movedMarker) throw new Error("the current tmux window changed or became linked during parking");
		}

		const paneLocation = locatePaneWindow(pane);
		const indices = windowIndicesInSession(parking.sessionId, source.windowId);
		if (
			paneLocation.windowId !== source.windowId ||
			paneLocation.sessionId !== parking.sessionId ||
			indices.length !== 1
		) {
			throw new Error("tmux did not park the current window in session B");
		}
		releasePlaceholder(placeholderReleasePath);
		return {
			paneId: pane,
			windowId: source.windowId,
			parkingSessionId: parking.sessionId,
			parkingSessionName: PARKING_SESSION_NAME,
			token,
		};
	} catch (error) {
		releasePlaceholder(placeholderReleasePath);
		try { tmux(["set-window-option", "-q", "-u", "-t", source.windowId, TOKEN_OPTION]); } catch {}
		// A failed post-move verification is uncertain. Never move or kill the Pi window again here.
		throw error;
	}
}

function closeParkedWindow(parked: ParkedWindow) {
	let indices: number[];
	try {
		indices = windowIndicesInSession(parked.parkingSessionId, parked.windowId);
	} catch {
		return "moved" as const;
	}
	if (indices.length !== 1) return "moved" as const;
	const target = indexedWinlinkTarget(parked.parkingSessionId, indices[0]!);
	const movedMarker = `PI_CLOSE_ON_DONE_MOVED_${parked.token}`;
	const paneInWindow = `#{m:*|${parked.paneId}|*,#{P:|#{pane_id}|}}`;
	const condition = `#{&&:#{==:#{window_id},${parked.windowId}},#{&&:#{==:#{${TOKEN_OPTION}},${parked.token}},${paneInWindow}}}`;
	const result = tmux([
		"if-shell", "-F", "-t", target, condition,
		`set-window-option -q -u -t ${parked.windowId} ${TOKEN_OPTION} ; unlink-window -k -t ${target}`,
		`display-message -p ${movedMarker}`,
	]);
	if (result === movedMarker) return "moved" as const;
	return "closed" as const;
}

function errorText(error: unknown) {
	if (error && typeof error === "object" && "stderr" in error) {
		const stderr = String((error as { stderr?: unknown }).stderr ?? "").trim();
		if (stderr) return stderr;
	}
	return error instanceof Error ? error.message : String(error);
}

function finalAssistantCompleted(messages: readonly unknown[]) {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index] as { role?: unknown; stopReason?: unknown } | undefined;
		if (message?.role === "assistant") return message.stopReason === "stop";
	}
	return false;
}

function runtimeState() {
	const root = globalThis as typeof globalThis & { [RUNTIME_STATE_KEY]?: RuntimeState };
	return root[RUNTIME_STATE_KEY] ??= { finalResponseCompleted: false };
}

export default function closeOnDone(pi: ExtensionAPI) {
	const state = runtimeState();

	pi.on("session_start", (_event, ctx) => {
		if (state.parked) ctx.ui.setStatus(STATUS_KEY, "closes after final response");
	});
	pi.on("agent_start", () => { state.finalResponseCompleted = false; });
	pi.on("agent_end", (event) => { state.finalResponseCompleted = finalAssistantCompleted(event.messages); });
	pi.on("agent_settled", (_event, ctx) => {
		if (!state.parked || !state.finalResponseCompleted || !ctx.isIdle()) return;
		const closing = state.parked;
		try {
			const result = closeParkedWindow(closing);
			state.parked = undefined;
			ctx.ui.setStatus(STATUS_KEY, undefined);
			if (result === "moved") ctx.ui.notify("The Pi pane or parked window moved, so /close-on-done left the window open.", "warning");
		} catch (error) {
			ctx.ui.setStatus(STATUS_KEY, "close failed");
			ctx.ui.notify(`Could not close the parked tmux window: ${errorText(error)}`, "error");
		}
	});

	pi.registerCommand("close-on-done", {
		description: "Move this tmux window to session B and close it after the active agent run finishes successfully",
		handler: async (args, ctx) => {
			if (args.trim()) { ctx.ui.notify("Usage: /close-on-done", "error"); return; }
			if (ctx.mode !== "tui" || !process.env.TMUX || !process.env.TMUX_PANE) {
				ctx.ui.notify("/close-on-done only works in Pi's interactive TUI inside tmux.", "error");
				return;
			}
			if (ctx.isIdle()) {
				ctx.ui.notify("Send the final task first, then run /close-on-done while the agent is working.", "warning");
				return;
			}
			if (state.parked) {
				ctx.ui.notify(`This window is already parked in tmux session ${state.parked.parkingSessionName}.`, "info");
				return;
			}
			try {
				state.parked = parkCurrentWindow(process.env.TMUX_PANE);
				ctx.ui.setStatus(STATUS_KEY, "closes after final response");
				ctx.ui.notify("Parked in tmux session B.", "info");
			} catch (error) {
				ctx.ui.notify(`Could not park this tmux window: ${errorText(error)}`, "error");
			}
		},
	});
}

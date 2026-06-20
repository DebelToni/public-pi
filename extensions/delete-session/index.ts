import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, unlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";

function currentTmuxWindow(): string | undefined {
	if (!process.env.TMUX) return undefined;
	const pane = process.env.TMUX_PANE;
	try {
		return execFileSync("tmux", ["display-message", ...(pane ? ["-t", pane] : []), "-p", "#{window_id}"], { encoding: "utf8" }).trim() || undefined;
	} catch {
		return undefined;
	}
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("delete", {
		description: "Delete the current Pi session file and close its tmux window",
		handler: async (_args, ctx) => {
			const sessionFile = ctx.sessionManager.getSessionFile();
			if (sessionFile && existsSync(sessionFile)) {
				unlinkSync(sessionFile);
			}

			const window = currentTmuxWindow();
			if (window) {
				execFileSync("tmux", ["kill-window", "-t", window], { stdio: "ignore" });
				return;
			}

			ctx.ui.notify(sessionFile ? "Deleted current session." : "No session file to delete.", "info");
			ctx.shutdown();
		},
	});
}

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	discardPreparedMove,
	prepareSessionMove,
	removeSourceIfUnchanged,
	replacementMatches,
	resolveTargetCwd,
} from "./move-session.js";

function errorText(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("move-session", {
		description: "Move the current session to another cwd or repair misplaced storage",
		handler: async (args, ctx) => {
			let targetCwd: string;
			try {
				targetCwd = resolveTargetCwd(args, ctx.sessionManager.getCwd());
			} catch (error) {
				ctx.ui.notify(errorText(error), "error");
				return;
			}

			await ctx.waitForIdle();

			let move;
			try {
				move = prepareSessionMove(ctx.sessionManager, targetCwd);
			} catch (error) {
				ctx.ui.notify(`Session move failed: ${errorText(error)}`, "error");
				return;
			}

			const result = await ctx.switchSession(move.destinationPath, {
				withSession: async (freshCtx) => {
					const replacementVerified = replacementMatches(move, freshCtx.sessionManager);
					const sourceRemoved = replacementVerified && removeSourceIfUnchanged(move);
					freshCtx.ui.notify(
						sourceRemoved
							? move.sourceCwd === move.targetCwd
								? `Session storage repaired for ${move.targetCwd}.`
								: `Session moved to ${move.targetCwd}.`
							: `Session now uses ${move.targetCwd}, but the old JSONL was kept because the replacement could not be verified, the source changed, or it could not be removed.`,
						sourceRemoved ? "info" : "warning",
					);
				},
			});

			if (result.cancelled) {
				const removed = discardPreparedMove(move);
				ctx.ui.notify(
					removed ? "Session move canceled." : `Session move canceled; remove the unused copy manually: ${move.destinationPath}`,
					removed ? "info" : "warning",
				);
			}
		},
	});
}

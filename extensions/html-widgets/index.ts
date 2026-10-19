import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Markdown } from "@earendil-works/pi-tui";
import { installHtmlWidgetFold } from "./native-fold.mjs";

export default function htmlWidgets(pi: ExtensionAPI) {
	// History can render before session_start. No session state or resources are needed.
	let cleanup = installHtmlWidgetFold(Markdown.prototype);
	pi.on("session_start", (_event, ctx) => {
		cleanup ??= installHtmlWidgetFold(Markdown.prototype);
		if (!cleanup && ctx.mode === "tui") {
			ctx.ui.notify("HTML widget folding unavailable: unsupported Markdown.renderToken seam.", "warning");
		}
	});
	pi.on("session_shutdown", () => {
		cleanup?.();
		cleanup = undefined;
	});
}

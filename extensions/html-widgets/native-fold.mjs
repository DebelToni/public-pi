import { truncateToWidth } from "@earendil-works/pi-tui";
import { widgetTokenInfo } from "./widget-format.mjs";

const PATCH = Symbol.for("pi.html-widgets.renderToken.v1");

/** Private TUI seam: renderToken(token, width, nextTokenType, styleContext). */
export function installHtmlWidgetFold(prototype) {
	if (typeof prototype.renderToken !== "function") return undefined;
	let state = Object.hasOwn(prototype, PATCH) ? prototype[PATCH] : undefined;
	if (!state) {
		const previous = prototype.renderToken;
		state = { enabled: false, owner: undefined, depth: new WeakMap() };
		state.wrapper = function (token, width, nextTokenType, styleContext) {
			const depth = state.depth.get(this) ?? 0;
			const info = state.enabled && depth === 0 ? widgetTokenInfo(token) : undefined;
			if (info && typeof this.theme?.codeBlockBorder === "function") {
				const line = truncateToWidth(`[HTML widget · ${info.title}]`, Math.max(0, width));
				return [this.theme.codeBlockBorder(line)];
			}
			state.depth.set(this, depth + 1);
			try {
				return previous.call(this, token, width, nextTokenType, styleContext);
			} finally {
				if (depth) state.depth.set(this, depth);
				else state.depth.delete(this);
			}
		};
		state.previous = previous;
		prototype.renderToken = state.wrapper;
		prototype[PATCH] = state;
	}
	const owner = Symbol();
	state.owner = owner;
	state.enabled = true;
	return () => {
		if (state.owner !== owner) return;
		state.enabled = false;
		if (prototype.renderToken === state.wrapper) {
			prototype.renderToken = state.previous;
			delete prototype[PATCH];
		}
		// A later wrapper owns the seam now. Leave our layer inert inside its chain.
	};
}

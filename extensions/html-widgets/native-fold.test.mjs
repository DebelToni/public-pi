import assert from "node:assert/strict";
import test from "node:test";
import { Markdown, visibleWidth } from "@earendil-works/pi-tui";
import { installHtmlWidgetFold } from "./native-fold.mjs";
import installExtension from "./index.ts";
import { marked, theme } from "./test-helpers.mjs";

const prototype = Markdown.prototype;
const render = (text, width = 80, style = theme) => new Markdown(text, 0, 0, style).render(width);
const text = "```html-widget Test\n<script>globalThis.didExecute = true</script>\n```";
const token = marked.lexer(text)[0];

test("only eligible top-level code folds and ordinary rendering delegates unchanged", () => {
	const inert = [
		"# Heading\n\nText **bold** and `code`.",
		"```html\n<div>ordinary</div>\n```",
		"```html-widgetish\nx\n```",
		"```html\\-widget\nx\n```",
		"```html-widget\nx\n``",
		"> ```html-widget\n> quoted\n> ```",
		"- ```html-widget\n  listed\n  ```",
		"- outer\n  - ```html-widget\n    listed\n    ```",
		"> - ```html-widget\n>   listed quote\n>   ```",
		"    ```html-widget\n    indent\n    ```",
		"````markdown\n```html-widget Example\nx\n```\n````",
	];
	const before = inert.map(source => render(source));
	const inline = prototype.renderInlineTokens;
	const cleanup = installHtmlWidgetFold(prototype);
	try {
		assert.deepEqual(render(text), ["[HTML widget · Test]".padEnd(80)]);
		assert.equal(globalThis.didExecute, undefined);
		assert.strictEqual(prototype.renderInlineTokens, inline);
		assert.deepEqual(inert.map(source => render(source)), before);
		const source = "Before\n\n" + text + "\n\n~~~html-widget Second\ny\n~~~\n\nAfter";
		const output = render(source).join("\n");
		assert.match(output, /Before/);
		assert.match(output, /After/);
		assert.equal(output.match(/\[HTML widget · /g).length, 2);
		assert.doesNotMatch(output, /<script>|\n  y/);
	} finally { cleanup(); }
});

test("single-line width safety, Unicode, controls, and resize", () => {
	const cleanup = installHtmlWidgetFold(prototype);
	const title = "你好 é 👩‍💻 " + "😀".repeat(140) + "\x1b[31m\u202e";
	const widget = marked.lexer(`~~~html-widget ${title}\nx\n~~~`)[0];
	const component = new Markdown(`~~~html-widget ${title}\nx\n~~~`, 0, 0, theme);
	try {
		for (let width = 0; width <= 140; width++) {
			const direct = component.renderToken(widget, width, "paragraph", { applyText: value => value });
			assert.equal(direct.length, 1);
			assert.ok(visibleWidth(direct[0]) <= width, `${width}: ${direct[0]}`);
			assert.doesNotMatch(direct[0], /[\r\n\u202e]/);
			if (width) for (const line of component.render(width)) assert.ok(visibleWidth(line) <= width);
		}
		assert.equal(component.render(100).length, 1);
		assert.equal(component.render(8).length, 1);
		assert.equal(component.render(100).length, 1);
	} finally { cleanup(); }
});

test("theme is evaluated while rendering, not stored in patch state", () => {
	let color = 36;
	const style = { ...theme, codeBlockBorder: value => `\x1b[${color}m${value}\x1b[0m` };
	const component = new Markdown(text, 0, 0, style);
	const cleanup = installHtmlWidgetFold(prototype);
	try {
		assert.match(component.render(80)[0], /\x1b\[36m/);
		color = 33;
		component.invalidate();
		assert.match(component.render(80)[0], /\x1b\[33m/);
	} finally { cleanup(); }
});

test("streaming and setText fold only after a valid closer", () => {
	const source = "````html-widget Streaming\n<div>body</div>\n````";
	const component = new Markdown("", 0, 0, theme);
	const cleanup = installHtmlWidgetFold(prototype);
	try {
		for (let end = 0; end < source.length; end++) {
			component.setText(source.slice(0, end));
			assert.doesNotMatch(component.render(80).join("\n"), /\[HTML widget/);
		}
		component.setText(source);
		assert.match(component.render(80).join("\n"), /\[HTML widget · Streaming\]/);
		component.setText(source + "bad");
		assert.doesNotMatch(component.render(80).join("\n"), /\[HTML widget/);
	} finally { cleanup(); }
});

test("delegation preserves this and all four arguments, including after exceptions", () => {
	const calls = [];
	const fake = { renderToken(...args) { calls.push([this, args]); if (args[0].type === "throw") throw new Error("expected"); return ["original"]; } };
	const context = Object.create(fake);
	context.theme = theme;
	const cleanup = installHtmlWidgetFold(fake);
	const ordinary = { type: "paragraph" }, style = {};
	try {
		assert.deepEqual(context.renderToken(ordinary, 12, "space", style), ["original"]);
		assert.deepEqual(calls[0], [context, [ordinary, 12, "space", style]]);
		assert.throws(() => context.renderToken({ type: "throw" }, 12), /expected/);
		assert.deepEqual(context.renderToken(token, 80), ["[HTML widget · Test]"]);
		assert.equal(calls.length, 2);
	} finally { cleanup(); }
});

test("factory-time history patch, idempotent shutdown, and same-runtime session restart", () => {
	const original = prototype.renderToken, inline = prototype.renderInlineTokens;
	const handlers = new Map();
	const pi = { on(name, handler) { handlers.set(name, handler); } };
	installExtension(pi);
	assert.match(render(text)[0], /\[HTML widget/); // No session_start has fired.
	handlers.get("session_start")({}, { mode: "tui", ui: { notify() { assert.fail("unexpected warning"); } } });
	assert.deepEqual([...handlers.keys()].sort(), ["session_shutdown", "session_start"]);
	handlers.get("session_shutdown")();
	handlers.get("session_shutdown")();
	assert.strictEqual(prototype.renderToken, original);
	assert.strictEqual(prototype.renderInlineTokens, inline);
	handlers.get("session_start")({}, { mode: "rpc" });
	assert.match(render(text)[0], /\[HTML widget/);
	handlers.get("session_shutdown")();
	assert.strictEqual(prototype.renderToken, original);
});

test("hot reload installs once and stale cleanup cannot disable a new owner", async () => {
	const original = prototype.renderToken;
	const oldCleanup = installHtmlWidgetFold(prototype);
	const wrapper = prototype.renderToken;
	const fresh = await import("./native-fold.mjs?reload-test");
	const cleanup = fresh.installHtmlWidgetFold(prototype);
	assert.strictEqual(prototype.renderToken, wrapper);
	oldCleanup();
	assert.match(render(text)[0], /\[HTML widget/);
	cleanup();
	cleanup();
	assert.strictEqual(prototype.renderToken, original);
});

test("later wrappers survive shutdown and repeated reloads without accumulating layers", async () => {
	const original = prototype.renderToken;
	let cleanup = installHtmlWidgetFold(prototype);
	const ourWrapper = prototype.renderToken;
	let calls = 0;
	const laterWrapper = function (...args) { calls++; return ourWrapper.apply(this, args); };
	prototype.renderToken = laterWrapper;
	try {
		for (let reload = 0; reload < 12; reload++) {
			cleanup();
			assert.strictEqual(prototype.renderToken, laterWrapper);
			assert.doesNotMatch(render(text).join("\n"), /\[HTML widget/);
			const fresh = await import(`./native-fold.mjs?later-reload=${reload}`);
			cleanup = fresh.installHtmlWidgetFold(prototype);
			assert.strictEqual(prototype.renderToken, laterWrapper);
			const before = calls;
			assert.match(render(text)[0], /\[HTML widget/);
			assert.equal(calls - before, 1);
		}
	} finally { cleanup(); prototype.renderToken = ourWrapper; }
	// Once the later owner removes its wrapper, cleanup can restore the original seam.
	cleanup();
	assert.strictEqual(prototype.renderToken, original);
});

test("frozen tokens and source message data are not modified", () => {
	const frozen = Object.freeze({ ...token });
	const message = Object.freeze({ role: "assistant", content: Object.freeze([{ type: "text", text }]) });
	const before = JSON.stringify(message), tokenBefore = JSON.stringify(frozen);
	const cleanup = installHtmlWidgetFold(prototype);
	try {
		const component = new Markdown(message.content[0].text, 0, 0, theme);
		assert.deepEqual(component.renderToken(frozen, 80), ["[HTML widget · Test]"]);
		assert.equal(JSON.stringify(message), before);
		assert.equal(JSON.stringify(frozen), tokenBefore);
	} finally { cleanup(); }
});

test("unsupported seam stays untouched and warns only in TUI mode", () => {
	for (const value of [undefined, null, 1]) {
		const fake = { renderToken: value };
		assert.equal(installHtmlWidgetFold(fake), undefined);
		assert.strictEqual(fake.renderToken, value);
	}
	const fake = { renderToken() { return ["unchanged"]; } };
	const cleanup = installHtmlWidgetFold(fake);
	assert.deepEqual(fake.renderToken(token, 80), ["unchanged"]); // Missing private theme seam.
	cleanup();
	const original = prototype.renderToken;
	prototype.renderToken = undefined;
	const handlers = new Map(), warnings = [];
	try {
		installExtension({ on(name, fn) { handlers.set(name, fn); } });
		handlers.get("session_start")({}, { mode: "rpc" });
		handlers.get("session_start")({}, { mode: "json" });
		handlers.get("session_start")({}, { mode: "tui", ui: { notify: (...args) => warnings.push(args) } });
		assert.equal(warnings.length, 1);
		assert.match(warnings[0][0], /unsupported Markdown.renderToken seam/);
		assert.equal(warnings[0][1], "warning");
		handlers.get("session_shutdown")();
	} finally { prototype.renderToken = original; }
});

// The display seam receives Pi's preprocessed tokens, not original source. It never executes.
test("Pi tab preprocessing is display-only; the original-source parser remains authoritative", async () => {
	const source = "\t```html-widget\n\tbody\n\t```";
	const { splitHtmlWidgets } = await import("./widget-format.mjs");
	assert.deepEqual(splitHtmlWidgets(source, marked.lexer), [{ type: "markdown", text: source }]);
	const cleanup = installHtmlWidgetFold(prototype);
	try { assert.match(render(source)[0], /\[HTML widget/); }
	finally { cleanup(); }
});

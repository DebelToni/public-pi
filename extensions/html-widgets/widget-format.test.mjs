import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { marked } from "./test-helpers.mjs";
import { widgetInfo, widgetTokenInfo, splitHtmlWidgets } from "./widget-format.mjs";

const split = text => splitHtmlWidgets(text, marked.lexer);
const widgets = text => split(text).filter(part => part.type === "widget");
const inert = text => assert.deepEqual(split(text), text ? [{ type: "markdown", text }] : []);

test("exact intentional language and plain title contract", () => {
	for (const lang of [undefined, null, 1, "", "html", "HTML-WIDGET", "html-widgetish", "html-widget:Title", "html-widget\nTitle"]) {
		assert.equal(widgetInfo(lang), undefined, String(lang));
	}
	for (const lang of ["html-widget", " html-widget ", "html-widget \t"]) {
		assert.deepEqual(widgetInfo(lang), { title: "Interactive HTML" });
	}
	assert.deepEqual(widgetInfo("html-widget Hello <b>world</b> & *you*"), { title: "Hello <b>world</b> & *you*" });
	assert.deepEqual(widgetInfo("html-widget A\0B\nC\tD\x1bE\x7fF\x9bG\u202eH\u2066I"), { title: "ABCDEFGHI" });
	assert.equal(widgetInfo("html-widget " + "😀".repeat(130)).title, "😀".repeat(120));
	assert.equal(widgetInfo("html-widget \0\x1b").title, "Interactive HTML");
});

test("the literal info string controls intent and keeps title backslashes plain", () => {
	inert("```html\\-widget\nx\n```");
	assert.equal(widgets("```html-widget A\\*B &amp;\nx\n```")[0].title, "A\\*B &amp;");
});

test("multiple widgets, zero-based indices, untouched Markdown and token.text bodies", () => {
	const before = "# Before\n\nRaw &amp; **prose**.\n\n";
	const between = "\n\n```html\n<p>inert</p>\n```\n\n";
	const after = "\n\nEnd.\n";
	const one = "```html-widget One\n<!doctype html>\n<script>globalThis.neverRun = true</script>\n```";
	const two = "~~~html-widget\n<div>&amp; \\ \t</div>\n~~~";
	assert.deepEqual(split(before + one + between + two + after), [
		{ type: "markdown", text: before },
		{ type: "widget", title: "One", source: marked.lexer(one)[0].text, index: 0 },
		{ type: "markdown", text: between },
		{ type: "widget", title: "Interactive HTML", source: marked.lexer(two)[0].text, index: 1 },
		{ type: "markdown", text: after },
	]);
	assert.equal(globalThis.neverRun, undefined);
});

test("CRLF and lone CR prose survive Marked normalization", () => {
	const text = "[ref]: /x\r\n\r\nα\r\n\r\n```html-widget T\r\n<div>\r\nline\r\n</div>\r\n```\r\n\rTail\r";
	assert.deepEqual(split(text), [
		{ type: "markdown", text: "[ref]: /x\r\n\r\nα\r\n\r\n" },
		{ type: "widget", title: "T", source: "<div>\nline\n</div>", index: 0 },
		{ type: "markdown", text: "\r\n\rTail\r" },
	]);
});

test("ordinary HTML, empty text, definitions and adjacent prose stay inert and merged", () => {
	for (const text of ["", "hi\n\nthere", "```html\n<script>x()</script>\n```", "<div>hi</div>", "[x]: /foo\n\n[x]", "`html-widget`", "    html-widget\n    <h1>hi</h1>"]) inert(text);
});

test("nested fences and documentation outer fences cannot create widgets", () => {
	for (const text of [
		"> ```html-widget Title\n> <div>quoted</div>\n> ```",
		"- ```html-widget Title\n  <div>listed</div>\n  ```",
		"1. item\n\n   ```html-widget\n   <div>ordered</div>\n   ```",
		"- outer\n  - ```html-widget\n    nested\n    ```",
		"    ```html-widget\n    indented\n    ```",
		"\t```html-widget\n\tindented\n\t```",
		"````markdown\n```html-widget Example\n<div>docs</div>\n```\n````",
		"~~~~text\n~~~html-widget Example\n<div>docs</div>\n~~~\n~~~~",
		"<!--\n```html-widget\nnot a fence\n```\n-->",
	]) inert(text);
});

test("only complete fences with matching character and adequate length qualify", () => {
	for (const char of ["`", "~"]) {
		for (let size = 3; size <= 7; size++) {
			for (let closeSize = 0; closeSize <= 8; closeSize++) {
				for (let indent = 0; indent <= 4; indent++) {
					const text = `${char.repeat(size)}html-widget Title\n<div>body</div>\n${" ".repeat(indent)}${char.repeat(closeSize)}`;
					assert.equal(widgets(text).length, closeSize >= size && indent <= 3 ? 1 : 0, text);
				}
			}
		}
	}
	for (const close of ["~~~", "``` bad", "```html-widget", "``", "    ```"]) inert("```html-widget\nx\n" + close);
	assert.equal(widgets("   ```html-widget\n   body\n   ```\n")[0].source, "body");
	assert.equal(widgets("```html-widget\n```")[0].source, "");
	assert.equal(widgets("~~~html-widget\n~~~  \t\n").length, 1);
});

test("every streaming prefix stays inert until the closing fence completes", () => {
	const text = "Before\n\n````html-widget Streaming\n<script>never()</script>\n````";
	for (let end = 0; end < text.length; end++) inert(text.slice(0, end));
	assert.equal(widgets(text).length, 1);
	inert(text + "not-a-closing-fence");
	const first = "```html-widget First\nx\n```\n\n";
	assert.deepEqual(widgets(first + "~~~html-widget Second\ny\n~~"), [{ type: "widget", source: "x", title: "First", index: 0 }]);
});

test("ordinary raw transforms are irrelevant; invalid declared widgets fail loudly", () => {
	let supplied;
	assert.deepEqual(splitHtmlWidgets("prose", text => { supplied = text; return [{ type: "paragraph", raw: text }]; }), [{ type: "markdown", text: "prose" }]);
	assert.equal(supplied, "prose");
	assert.deepEqual(splitHtmlWidgets("text", () => [{ type: "paragraph", raw: "transformed" }]), [{ type: "markdown", text: "text" }]);
	const declared = marked.lexer("```html-widget\nx\n```");
	assert.throws(() => splitHtmlWidgets("text", () => declared), /root widget/);
	assert.equal(widgetTokenInfo({ type: "code", lang: "html-widget", raw: "body", text: "body" }), undefined);
});

test("format module has no dependency imports", async () => {
	const source = await readFile(new URL("./widget-format.mjs", import.meta.url), "utf8");
	assert.doesNotMatch(source, /\bimport\s*(?:[({*]|["'])/);
});

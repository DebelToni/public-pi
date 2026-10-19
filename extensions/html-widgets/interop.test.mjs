import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Markdown, setCapabilities, visibleWidth } from "@earendil-works/pi-tui";
import installImages from "../inline-images/index.ts";
import { installHtmlWidgetFold } from "./native-fold.mjs";
import { theme } from "./test-helpers.mjs";

for (const order of ["images-first", "widgets-first"]) {
	test(`actual inline-images seam interoperates: ${order}`, () => {
		const root = mkdtempSync(join(homedir(), "tmp", "pi-widget-image-test-"));
		const path = join(root, "one.png");
		writeFileSync(path, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"));
		const handlers = new Map();
		const pi = {
			on(name, fn) { handlers.set(name, fn); },
			registerShortcut() {}, registerCommand() {},
			events: { on() { return () => {}; } },
		};
		const prototype = Markdown.prototype;
		const originalToken = prototype.renderToken;
		let cleanup;
		try {
			setCapabilities({ images: null, trueColor: true, hyperlinks: false });
			if (order === "widgets-first") cleanup = installHtmlWidgetFold(prototype);
			installImages(pi);
			const inline = prototype.renderInlineTokens;
			if (order === "images-first") cleanup = installHtmlWidgetFold(prototype);
			handlers.get("session_start")({}, { cwd: root, sessionManager: { getSessionId: () => order, getBranch: () => [] } });
			const source = `Before ![diagram](${path}) After\n\n` + "```html-widget Chart\n<script>never()</script>\n```";
			const component = new Markdown(source, 0, 0, theme);
			for (const width of [80, 24, 80]) {
				const lines = component.render(width);
				const joined = lines.join("\n");
				assert.match(joined, /IMAGE 00/);
				assert.match(joined, /\[HTML widget · Chart\]/);
				assert.doesNotMatch(joined, /<script>|one\.png/);
				for (const line of lines) assert.ok(visibleWidth(line) <= width);
			}
			cleanup();
			assert.strictEqual(prototype.renderToken, originalToken);
			assert.strictEqual(prototype.renderInlineTokens, inline);
			assert.match(new Markdown(`![diagram](${path})`, 0, 0, theme).render(80).join(""), /IMAGE 00/);
			cleanup = installHtmlWidgetFold(prototype);
			assert.strictEqual(prototype.renderInlineTokens, inline);
		} finally {
			cleanup?.();
			handlers.get("session_shutdown")?.();
			rmSync(root, { recursive: true, force: true });
		}
	});
}

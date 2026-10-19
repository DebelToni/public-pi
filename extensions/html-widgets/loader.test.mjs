import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Markdown } from "@earendil-works/pi-tui";
import { theme } from "./test-helpers.mjs";

// Offline loading only. No Pi session, agent, reload command, credentials, or model call.
test("the installed Pi jiti loader patches the actual host Markdown class at factory time", async () => {
	const host = import.meta.resolve("@earendil-works/pi-coding-agent");
	const { loadExtensions } = await import(new URL("./core/extensions/loader.js", host));
	const original = Markdown.prototype.renderToken;
	const inline = Markdown.prototype.renderInlineTokens;
	const entry = fileURLToPath(new URL("./index.ts", import.meta.url));
	const result = await loadExtensions([entry], process.cwd());
	assert.deepEqual(result.errors, []);
	assert.equal(result.extensions.length, 1);
	const extension = result.extensions[0];
	try {
		assert.notStrictEqual(Markdown.prototype.renderToken, original);
		assert.strictEqual(Markdown.prototype.renderInlineTokens, inline);
		assert.equal(extension.tools.size, 0);
		assert.equal(extension.commands.size, 0);
		assert.equal(extension.messageRenderers.size, 0);
		assert.equal(extension.markdownTransformer, undefined);
		const source = "```html-widget Offline\n<script>throw new Error('never run')</script>\n```";
		assert.match(new Markdown(source, 0, 0, theme).render(80)[0], /\[HTML widget · Offline\]/);
	} finally {
		for (const handler of extension.handlers.get("session_shutdown") ?? []) await handler({}, {});
	}
	assert.strictEqual(Markdown.prototype.renderToken, original);
	assert.strictEqual(Markdown.prototype.renderInlineTokens, inline);
});

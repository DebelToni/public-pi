import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { stripVTControlCharacters as stripAnsi } from "node:util";
import { Container, Markdown, setCapabilities, visibleWidth } from "@earendil-works/pi-tui";
import { getMarkdownTheme, initTheme, InteractiveMode, buildSessionContext, createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import installImages from "./index.ts";
import { attachmentReferences, installUserAttachmentRendering, restoreUserAttachmentRendering } from "./attachments.ts";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const GIF = "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
function root(t: any) {
	const directory = mkdtempSync(join(homedir(), "tmp/pi-uploaded-image-test-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	return directory;
}
function host() {
	const history: string[] = [], value: any = Object.create(InteractiveMode.prototype);
	value.chatContainer = new Container(); value.outputPad = 1;
	value.getMarkdownThemeWithSettings = () => getMarkdownTheme();
	value.getMarkdownTransformers = () => [];
	value.editor = { addToHistory: (text: string) => history.push(text) };
	return { value, history };
}

test("native attachments become private stable local Markdown references without changing payloads", t => {
	const directory = join(root(t), "cache with spaces (images)");
	const message = { role: "user", content: [{ type: "text", text: "inspect" }, { type: "image", mimeType: "image/png", data: PNG }, { type: "image", mimeType: "image/gif", data: GIF }] };
	const before = structuredClone(message), references = attachmentReferences(message, directory);
	const paths = [...references.matchAll(/\]\(<(.+)>\)/g)].map(match => match[1]);
	assert.equal(paths.length, 2); assert.notEqual(paths[0], paths[1]);
	assert.deepEqual(readFileSync(paths[0]), Buffer.from(PNG, "base64"));
	assert.deepEqual(readFileSync(paths[1]), Buffer.from(GIF, "base64"));
	assert.equal(statSync(directory).mode & 0o777, 0o700);
	for (const path of paths) assert.equal(statSync(path).mode & 0o777, 0o600);
	const times = paths.map(path => statSync(path).mtimeMs);
	assert.equal(attachmentReferences(message, directory), references);
	assert.deepEqual(paths.map(path => statSync(path).mtimeMs), times);
	assert.deepEqual(message, before); assert.equal(readdirSync(directory).length, 2);
	assert.equal(attachmentReferences({ role: "assistant", content: message.content }, directory), "");
	assert.equal(attachmentReferences({ role: "user", content: "plain" }, directory), "");
	rmSync(paths[0]);assert.equal(attachmentReferences(message, directory), references);
	assert.deepEqual(readFileSync(paths[0]), Buffer.from(PNG, "base64"));
});

test("cache failure and unsupported content produce a display marker, not a renderer failure", t => {
	const directory = root(t), blocked = join(directory, "not-a-directory");writeFileSync(blocked, "blocked");
	assert.equal(attachmentReferences({ role: "user", content: [{ type: "image", mimeType: "image/png", data: PNG }] }, blocked), "[Uploaded image 1 unavailable]");
	assert.equal(attachmentReferences({ role: "user", content: [{ type: "image", mimeType: "image/svg+xml", data: PNG }] }, directory), "[Uploaded image 1 unavailable]");
	assert.equal(attachmentReferences({ role: "user", content: [{ type: "image", mimeType: "image/png", data: "bad!" }] }, directory), "[Uploaded image 1 unavailable]");
	assert.deepEqual(readdirSync(directory), ["not-a-directory"]);
	assert.equal(installUserAttachmentRendering({}, directory), false);
});

test("real Pi user renderer places indexed attachments below text, preserves history and reuses Option+I", async t => {
	const directory = root(t), cache = join(directory, "attachments"), oldPane = process.env.TMUX_PANE;
	process.env.TMUX_PANE = "%999997";
	t.after(() => { if (oldPane === undefined) delete process.env.TMUX_PANE; else process.env.TMUX_PANE = oldPane; });
	initTheme("dark", false);setCapabilities({ images: null, trueColor: true, hyperlinks: false });
	let start: any, shortcut: any, command: any;
	const manifests: any[] = [];
	installImages({
		on(name: string, handler: any) { if (name === "session_start") start = handler; },
		registerShortcut(key: string, options: any) { assert.equal(key, "alt+i"); shortcut = options; },
		registerCommand(name: string, options: any) { assert.equal(name, "image"); command = options; },
		async exec(program: string, args: string[]) {
			assert.equal(program, "tmux");
			if (args[0] === "list-clients") return { code: 0, stdout: "/dev/owned-client\t%999997\n", stderr: "" };
			assert.equal(args[0], "display-popup");manifests.push(JSON.parse(readFileSync(args.at(-1)!, "utf8")));
			return { code: 0, stdout: "", stderr: "" };
		},
	} as any);
	start({}, { cwd: directory, sessionManager: { getSessionId: () => "uploaded-image-fixture" } });
	assert.equal(installUserAttachmentRendering(InteractiveMode.prototype, cache), true);
	const wrapped = (InteractiveMode.prototype as any).addMessageToChat;
	installUserAttachmentRendering(InteractiveMode.prototype, cache);
	assert.equal((InteractiveMode.prototype as any).addMessageToChat, wrapped);
	const message = { role: "user", content: [{ type: "text", text: "Look at these\n\n```\nan unclosed fence" }, { type: "image", mimeType: "image/png", data: PNG }, { type: "image", mimeType: "image/gif", data: GIF }], timestamp: 1 };
	const before = structuredClone(message), live = host();
	live.value.addMessageToChat(message, { populateHistory: true });
	const rendered = stripAnsi(live.value.chatContainer.render(80).join("\n"));
	assert.ok(rendered.indexOf("IMAGE 00") > rendered.indexOf("Look at these"));
	assert.match(rendered, /\[IMAGE 00 - Uploaded image 1\]/);assert.match(rendered, /\[IMAGE 01 - Uploaded image 2\]/);
	assert.deepEqual(live.history, [message.content[0].text]);assert.deepEqual(message, before);
	assert.equal(live.value.getUserMessageText(message), message.content[0].text);
	for (const line of live.value.chatContainer.render(20)) assert.ok(visibleWidth(line) <= 20);
	const ui = { notify: () => assert.fail("viewer should find the uploaded images") };
	await shortcut.handler({ mode: "tui", ui });await command.handler("00", { mode: "tui", ui });
	assert.deepEqual(manifests.map(manifest => manifest.selected), ["01", "00"]);
	assert.equal(manifests[0].images.length, 2);
	assert.deepEqual(readFileSync(manifests[0].images[0].path), Buffer.from(PNG, "base64"));
	assert.deepEqual(readFileSync(manifests[0].images[1].path), Buffer.from(GIF, "base64"));
	// Rebuilding a resumed transcript generates the same references, no duplicate IDs.
	const resumed = host();resumed.value.addMessageToChat(structuredClone(message), { populateHistory: true });
	assert.equal(stripAnsi(resumed.value.chatContainer.render(80).join("\n")), rendered);
	assert.deepEqual(resumed.history, live.history);assert.equal(readdirSync(cache).length, 2);
	const imageOnly = host();imageOnly.value.addMessageToChat({ role: "user", content: [message.content[1]], timestamp: 2 }, { populateHistory: true });
	assert.match(stripAnsi(imageOnly.value.chatContainer.render(80).join("\n")), /IMAGE 00/);assert.deepEqual(imageOnly.history, []);
});

test("SDK jiti startup and owned reload use the rendering hook without adding model or transcript text", async t => {
	const directory = root(t), settingsManager = SettingsManager.inMemory({});
	const resourceLoader = new DefaultResourceLoader({ cwd: directory, agentDir: directory, settingsManager,
		additionalExtensionPaths: [new URL("./index.ts", import.meta.url).pathname], noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
	await resourceLoader.reload();assert.deepEqual(resourceLoader.getExtensions().errors, []);
	const manager = SessionManager.inMemory(directory);
	const { session } = await createAgentSession({ cwd: directory, agentDir: directory, settingsManager, resourceLoader, sessionManager: manager, noTools: "all" });
	t.after(() => session.dispose());await session.bindExtensions({ mode: "print" });
	const message: any = { role: "user", content: [{ type: "text", text: "Phone upload" }, { type: "image", mimeType: "image/png", data: PNG }], timestamp: 1 };
	manager.appendMessage(message);
	const entries = structuredClone(manager.getEntries()), context = structuredClone(buildSessionContext(manager.getEntries(), manager.getLeafId()));
	const wrapped = (InteractiveMode.prototype as any).addMessageToChat;
	await session.reload();assert.notEqual((InteractiveMode.prototype as any).addMessageToChat, wrapped);
	installUserAttachmentRendering(InteractiveMode.prototype, join(directory, "cache"));
	const rendered = host();rendered.value.addMessageToChat(message, { populateHistory: true });
	assert.match(stripAnsi(rendered.value.chatContainer.render(80).join("\n")), /\[IMAGE 00 - Uploaded image 1\]/);
	assert.deepEqual(manager.getEntries(), entries);
	assert.deepEqual(buildSessionContext(manager.getEntries(), manager.getLeafId()), context);
	assert.deepEqual(context.messages[0], message);assert.deepEqual(rendered.history, ["Phone upload"]);
});

test("shutdown restores the original renderer without overwriting a later wrapper", t => {
	const directory = root(t), original = () => "original";
	const prototype: any = { addMessageToChat: original, getUserMessageText() {}, getMarkdownThemeWithSettings() {} };
	installUserAttachmentRendering(prototype, directory);
	assert.notEqual(prototype.addMessageToChat, original);
	restoreUserAttachmentRendering(prototype);assert.equal(prototype.addMessageToChat, original);
	restoreUserAttachmentRendering(prototype);
	installUserAttachmentRendering(prototype, directory);
	const ours = prototype.addMessageToChat, later = function (this: any, message: any, options: any) { return ours.call(this, message, options); };
	prototype.addMessageToChat = later;restoreUserAttachmentRendering(prototype);
	assert.equal(prototype.addMessageToChat, later);
	assert.equal(prototype.addMessageToChat({ role: "user", content: [{ type: "image", mimeType: "image/png", data: PNG }] }), "original");
	assert.deepEqual(readdirSync(directory), []);
});


test("plain path plus attached bytes produces one label, indexes its original path and preserves recall on resume", t => {
	const cwd = root(t), path = join(cwd, "camera photo.JPG"), cache = join(cwd, "cache");
	writeFileSync(path, Buffer.from(PNG, "base64"));
	let start: any, shutdown: any;
	installImages({ on(name: string, handler: any) { if (name === "session_start") start = handler; if (name === "session_shutdown") shutdown = handler; }, registerShortcut() {}, registerCommand() {} } as any);
	t.after(() => shutdown());
	start({}, { cwd, sessionManager: { getSessionId: () => "plain-path-owned" } });
	installUserAttachmentRendering(InteractiveMode.prototype, cache, () => cwd);
	initTheme("dark", false);setCapabilities({ images: null, trueColor: true, hyperlinks: false });
	const text = 'Inspect "./camera photo.JPG"\r\n  ';
	const message = { role: "user", content: [{ type: "text", text }, { type: "image", data: PNG, mimeType: "image/png" }, { type: "image", data: PNG, mimeType: "image/png" }], timestamp: 1 };
	const before = structuredClone(message), live = host();
	live.value.addMessageToChat(message, { populateHistory: true });
	const rendered = stripAnsi(live.value.chatContainer.render(80).join("\n"));
	assert.equal((rendered.match(/IMAGE 00/g) ?? []).length, 1);
	assert.deepEqual(live.history, [text]);assert.deepEqual(message, before);
	assert.deepEqual((Markdown.prototype as any).__piImageLabelsV2.registry.list().map((image: any) => image.path), [path]);
	const resumed = host();resumed.value.addMessageToChat(structuredClone(message), { populateHistory: true });
	assert.equal(stripAnsi(resumed.value.chatContainer.render(80).join("\n")), rendered);
	assert.deepEqual(resumed.history, [text]);
	// Original paths can disappear; the real native block still supplies a viewer image.
	rmSync(path);start({}, { cwd, sessionManager: { getSessionId: () => "missing-path-resume-owned" } });
	const missing = host();missing.value.addMessageToChat(message, { populateHistory: true });
	assert.match(stripAnsi(missing.value.chatContainer.render(80).join("\n")), /IMAGE 00 - Uploaded image 1/);
	const cached = (Markdown.prototype as any).__piImageLabelsV2.registry.list()[0].path;
	assert.deepEqual(readFileSync(cached), Buffer.from(PNG, "base64"));
	assert.deepEqual(message, before);
});

test("legacy Markdown, fenced paths, path-only history and duplicate files all remain indexed", t => {
	const cwd = root(t), path = join(cwd, "one.png"), other = join(cwd, "two.png"), cache = join(cwd, "cache");
	writeFileSync(path, Buffer.from(PNG, "base64"));writeFileSync(other, Buffer.from(PNG, "base64"));
	let start: any, shutdown: any;
	installImages({ on(name: string, handler: any) { if (name === "session_start") start = handler; if (name === "session_shutdown") shutdown = handler; }, registerShortcut() {}, registerCommand() {} } as any);
	t.after(() => shutdown());
	initTheme("dark", false);setCapabilities({ images: null, trueColor: true, hyperlinks: false });
	for (const [index, text] of [
		'Legacy ![diagram](<./one.png>)', 'Closed `code` then ![diagram](<./one.png>)', 'Look ./one.png ./two.png',
		'```\n![diagram](<./one.png>)', '~~~\n./one.png', '`![diagram](<./one.png>)`', '    ![diagram](<./one.png>)',
	].entries()) {
		start({}, { cwd, sessionManager: { getSessionId: () => `path-render-owned-${index}` } });
		installUserAttachmentRendering(InteractiveMode.prototype, cache, () => cwd);
		const message = { role: "user", content: [{ type: "text", text }, { type: "image", data: PNG, mimeType: "image/png" }], timestamp: 1 };
		const fixture = host();fixture.value.addMessageToChat(message, { populateHistory: true });
		const rendered = stripAnsi(fixture.value.chatContainer.render(80).join("\n"));
		assert.equal((rendered.match(/IMAGE /g) ?? []).length, 1, text);
		assert.deepEqual((Markdown.prototype as any).__piImageLabelsV2.registry.list().map((image: any) => image.path), [path]);
		assert.deepEqual(fixture.history, [text]);
	}
	const stringMessage = { role: "user", content: "Inspect ./one.png", timestamp: 1 };
	const fixture = host();fixture.value.addMessageToChat(stringMessage, { populateHistory: true });
	assert.match(stripAnsi(fixture.value.chatContainer.render(80).join("\n")), /IMAGE 00/);
	assert.deepEqual(fixture.history, [stringMessage.content]);
});

test("nested blockquote/list fences get a fallback label while visible Markdown keeps exactly its inline label", t => {
	const cwd = root(t), path = join(cwd, "nested.png"), cache = join(cwd, "cache");
	writeFileSync(path, Buffer.from(PNG, "base64"));
	let start: any, shutdown: any;
	installImages({ on(name: string, handler: any) { if (name === "session_start") start = handler; if (name === "session_shutdown") shutdown = handler; }, registerShortcut() {}, registerCommand() {} } as any);
	t.after(() => shutdown());
	initTheme("dark", false);setCapabilities({ images: null, trueColor: true, hyperlinks: false });
	const camera = '![camera](<./nested.png>)';
	for (const [index, text] of [
		`> \`\`\`\n> ${camera}\n> \`\`\``,
		`- Item\n\n  \`\`\`\n  ${camera}\n  \`\`\``,
		`1. \`\`\`\n   ${camera}\n   \`\`\``,
		`> - ~~~\n>   ${camera}\n>   ~~~`,
		`> > \`\`\`\n> > ${camera}\n> > \`\`\``,
		`> ${camera}`, `- ${camera}`, `1. ${camera}`, `**${camera}**`, `> Closed \`code\` then ${camera}`,
	].entries()) {
		start({}, { cwd, sessionManager: { getSessionId: () => `nested-render-owned-${index}` } });
		installUserAttachmentRendering(InteractiveMode.prototype, cache, () => cwd);
		const message = { role: "user", content: [{ type: "text", text }, { type: "image", data: PNG, mimeType: "image/png" }], timestamp: index };
		const before = structuredClone(message), fixture = host();fixture.value.addMessageToChat(message, { populateHistory: true });
		const rendered = stripAnsi(fixture.value.chatContainer.render(80).join("\n"));
		assert.equal((rendered.match(/IMAGE /g) ?? []).length, 1, text);
		assert.deepEqual((Markdown.prototype as any).__piImageLabelsV2.registry.list().map((image: any) => image.path), [path], text);
		assert.deepEqual(fixture.history, [text]);assert.deepEqual(message, before);
	}
});

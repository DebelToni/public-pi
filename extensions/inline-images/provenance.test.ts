import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { stripVTControlCharacters as stripAnsi } from "node:util";
import { buildSessionContext, createAgentSession, DefaultResourceLoader, formatDimensionNote, getMarkdownTheme, initTheme, InteractiveMode, resizeImage, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, setCapabilities } from "@earendil-works/pi-tui";
import { attachmentReferences } from "./attachments.ts";
import { type ImageSource, transformImageInput } from "./input.ts";
import { ImageProvenance, PROVENANCE_TYPE } from "./provenance.ts";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const model: any = { provider: "owned-test", id: "no-inference", input: ["text", "image"], reasoning: false, inputLimits: { images: { resize: { maxWidth: 64, maxHeight: 64 } } } };
const image = (data: string, mimeType = "image/png") => ({ type: "image" as const, data, mimeType });
function fixture(t: any) {
	const cwd = mkdtempSync(join(homedir(), "tmp/pi-image-provenance-"));t.after(() => rmSync(cwd, { recursive: true, force: true }));
	const photon = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"))("@silvia-odwyer/photon-node");
	const pixel = photon.PhotonImage.new_from_byteslice(Buffer.from(PNG, "base64"));
	const camera = photon.resize(pixel, 800, 600, photon.SamplingFilter.Nearest);
	const bytes = Buffer.from(camera.get_bytes());camera.free();pixel.free();
	const path = join(cwd, "camera.png");writeFileSync(path, bytes);
	return { cwd, path, raw: image(bytes.toString("base64")), cache: join(cwd, "cache") };
}
function host() {
	const value: any = Object.create(InteractiveMode.prototype), history: string[] = [];
	value.chatContainer = new Container();value.outputPad = 1;value.getMarkdownThemeWithSettings = () => getMarkdownTheme();value.getMarkdownTransformers = () => [];
	value.editor = { addToHistory: (text: string) => history.push(text) };
	return { value, history };
}

async function prepare(tracker: ImageProvenance, cwd: string, incoming: any[] = [], text = "Inspect ./camera.png") {
	let sources: ImageSource[] = [];
	const result: any = await transformImageInput({ type: "input", text, source: "extension", images: incoming }, cwd, found => { sources = found; });
	await tracker.prepare(text, result.images, sources, model);
	const normalized = await Promise.all(result.images.map(async (part: any) => (await resizeImage(Buffer.from(part.data, "base64"), part.mimeType, model.inputLimits.images.resize))!));
	const hints = normalized.map(formatDimensionNote).filter(Boolean);
	const message = { role: "user", timestamp: 123, content: [{ type: "text", text: text + (hints.length ? `\n\n${hints.join("\n")}` : "") }, ...normalized.map((part: any) => image(part.data, part.mimeType))] };
	return { result, message, sources };
}

test("proven normalized path gets one label/cache ID on live and resumed rendering without payload edits", async t => {
	const { cwd, path, cache } = fixture(t), tracker = new ImageProvenance();
	const { message } = await prepare(tracker, cwd), before = structuredClone(message);
	const record = tracker.capture(message)!;assert.equal(record.sources[0].imageIndex, 0);
	const references = attachmentReferences(message, cache, cwd, tracker.forMessage(message));
	assert.equal((references.match(/!\[/g) ?? []).length, 1);assert.ok(references.includes(path));
	const resumed = new ImageProvenance();resumed.load(JSON.parse(JSON.stringify([{ type: "custom", customType: PROVENANCE_TYPE, data: record }])));
	assert.equal(attachmentReferences(structuredClone(message), cache, cwd, resumed.forMessage(message)), references);
	assert.deepEqual(message, before);
	assert.deepEqual(resumed.forMessage({ role: "user", content: [{ type: "image", mimeType: "image/png", data: null }] }), [], "malformed legacy blocks keep renderer fallback");
	assert.deepEqual(resumed.forMessage({ ...message, timestamp: 124 }), [], "same content in another message has no inherited provenance");
	rmSync(path);
	const fallback = attachmentReferences(message, cache, cwd, resumed.forMessage(message));
	assert.equal((fallback.match(/!\[/g) ?? []).length, 1);assert.ok(!fallback.includes(path));assert.equal(readdirSync(cache).length, 1);
});

test("derived slot matching never swallows unrelated native blocks even with identical normalized bytes", async t => {
	const { cwd, raw, cache } = fixture(t), tracker = new ImageProvenance();
	const normalized = (await resizeImage(Buffer.from(raw.data, "base64"), raw.mimeType, model.inputLimits.images.resize))!;
	const unrelated = image(normalized.data, normalized.mimeType);
	const { result, message } = await prepare(tracker, cwd, [unrelated]);
	assert.equal(result.images.length, 2);assert.strictEqual(result.images[0], unrelated);
	assert.equal(message.content[1].data, message.content[2].data);
	tracker.capture(message);
	const references = attachmentReferences(message, cache, cwd, tracker.forMessage(message));
	assert.equal((references.match(/!\[/g) ?? []).length, 2);assert.match(references, /Uploaded image 1/);assert.doesNotMatch(references, /Uploaded image 2/);
});

test("raw/resize-disabled provenance and stale-file/model-profile mismatch stay exact and conservative", async t => {
	const { cwd, path, raw, cache } = fixture(t), tracker = new ImageProvenance();
	await prepare(tracker, cwd);
	const message = { role: "user", timestamp: 123, content: [{ type: "text", text: "Inspect ./camera.png" }, raw] };
	tracker.capture(message);assert.equal(attachmentReferences(message, cache, cwd, tracker.forMessage(message)).split("\n\n").length, 1);
	const second = new ImageProvenance();await prepare(second, cwd);
	const otherProfile = (await resizeImage(Buffer.from(raw.data, "base64"), raw.mimeType, { maxWidth: 32, maxHeight: 32 }))!;
	const mismatch = { role: "user", timestamp: 125, content: [{ type: "text", text: `Inspect ./camera.png\n\n${formatDimensionNote(otherProfile)}` }, image(otherProfile.data, otherProfile.mimeType)] };
	assert.equal(second.capture(mismatch), undefined);
	assert.equal(attachmentReferences(mismatch, cache, cwd).split("\n\n").length, 2);
	writeFileSync(path, Buffer.concat([readFileSync(path), Buffer.from("changed")]));
	assert.equal(attachmentReferences(message, cache, cwd, tracker.forMessage(message)).split("\n\n").length, 2, "changed source does not hide the historical native image");
});

test("SDK normalization, persisted noncontext provenance and owned reload produce one original registry ID", async t => {
	const { cwd, path, raw } = fixture(t), settingsManager = SettingsManager.inMemory({});
	const resourceLoader = new DefaultResourceLoader({ cwd, agentDir: cwd, settingsManager, additionalExtensionPaths: [new URL("./index.ts", import.meta.url).pathname], noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
	await resourceLoader.reload();assert.deepEqual(resourceLoader.getExtensions().errors, []);
	const manager = SessionManager.inMemory(cwd);
	const { session } = await createAgentSession({ cwd, agentDir: cwd, settingsManager, resourceLoader, sessionManager: manager, noTools: "all" });
	t.after(() => session.dispose());await session.bindExtensions({ mode: "print" });
	const owned: any = session;owned.agent.state.model = model;owned._modelRuntime.hasConfiguredAuth = () => true;owned._modelRuntime.streamSimple = () => assert.fail("No inference");
	let user: any;
	owned._runAgentPrompt = async (messages: any[]) => {
		user = messages.find(message => message.role === "user");
		await session.extensionRunner.emit({ type: "message_start", message: user });
		manager.appendMessage(user);
	};
	await session.prompt("Inspect ./camera.png");
	const normalized = (await resizeImage(Buffer.from(raw.data, "base64"), raw.mimeType, model.inputLimits.images.resize))!;
	assert.deepEqual(user.content, [{ type: "text", text: `Inspect ./camera.png\n\n${formatDimensionNote(normalized)}` }, image(normalized.data, normalized.mimeType)]);
	assert.equal(manager.getBranch().filter((entry: any) => entry.customType === PROVENANCE_TYPE).length, 1);
	const context = structuredClone(buildSessionContext(manager.getEntries(), manager.getLeafId()));
	assert.deepEqual(context.messages, [user]);
	initTheme("dark", false);setCapabilities({ images: null, trueColor: true, hyperlinks: false });
	const live = host();live.value.addMessageToChat(user, { populateHistory: true });
	assert.equal((stripAnsi(live.value.chatContainer.render(80).join("\n")).match(/IMAGE /g) ?? []).length, 1);
	assert.deepEqual((Markdown.prototype as any).__piImageLabelsV2.registry.list().map((part: any) => part.path), [path]);
	const before = structuredClone(user);await session.reload();
	const resumed = host();resumed.value.addMessageToChat(structuredClone(user), { populateHistory: true });
	assert.equal((stripAnsi(resumed.value.chatContainer.render(80).join("\n")).match(/IMAGE /g) ?? []).length, 1);
	assert.deepEqual(resumed.history, live.history);assert.deepEqual(user, before);
	assert.deepEqual(buildSessionContext(manager.getEntries(), manager.getLeafId()), context);
});

for (const absolute of [true, false]) test(`real TUI reload rebuild hydrates ${absolute ? "absolute" : "relative"} provenance before session_start, not after the baked chat components`, async t => {
	const { cwd, path } = fixture(t), tracker = new ImageProvenance();
	const { message } = await prepare(tracker, cwd, [], absolute ? `Inspect ${path}` : "Inspect ./camera.png"), record = tracker.capture(message)!;
	const manager = SessionManager.inMemory(cwd);manager.appendCustomEntry(PROVENANCE_TYPE, record);manager.appendMessage(message);
	let starts = 0, rebuilds = 0, beforeStart = "";
	const settingsManager = SettingsManager.inMemory({ showCacheMissNotices: false });
	const resourceLoader = new DefaultResourceLoader({ cwd, agentDir: cwd, settingsManager, additionalExtensionPaths: [new URL("./index.ts", import.meta.url).pathname], extensionFactories: [pi => {
		pi.on("session_start", () => { starts++;if (starts === 2) { assert.equal(rebuilds, 1);assert.equal((beforeStart.match(/IMAGE /g) ?? []).length, 1); } });
	}], noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
	await resourceLoader.reload();assert.deepEqual(resourceLoader.getExtensions().errors, []);
	const { session } = await createAgentSession({ cwd, agentDir: cwd, settingsManager, resourceLoader, sessionManager: manager, noTools: "all" });
	const errors: any[] = [];
	t.after(() => session.dispose());await session.bindExtensions({ mode: "tui", uiContext: { notify() {} } as any, onError: error => errors.push(error) });
	(session as any)._modelRuntime.streamSimple = () => assert.fail("No inference");
	initTheme("dark", false);setCapabilities({ images: null, trueColor: true, hyperlinks: false });
	const rendering = host(), tui = rendering.value;tui.runtimeHost = { session };tui.pendingTools = new Map();
	tui.editorContainer = new Container();tui.keybindings = { reload() {} };tui.themeController = { applyFromSettings() {} };
	tui.ui = { setFocus() {}, requestRender() {} };
	for (const name of ["resetExtensionUI", "applyRuntimeSettings", "setupAutocompleteProvider", "setupExtensionShortcuts", "showLoadedResources", "showStatus"]) tui[name] = () => {};
	tui.maybeSaveImplicitProjectTrustAfterReload = () => false;tui.showError = (text: string) => assert.fail(text);
	// Keep the actual TUI handler, SDK beforeSessionStart ordering and chat rebuild.
	// UI controls and project-trust saving are inert; no live TUI or keys run.
	tui.rebuildChatFromMessages = () => {
		assert.equal(starts, 1, "SDK has not emitted reload session_start yet");
		(InteractiveMode.prototype as any).rebuildChatFromMessages.call(tui);
		rebuilds++;beforeStart = stripAnsi(tui.chatContainer.render(80).join("\n"));
	};
	tui.addMessageToChat(message, { populateHistory: true });
	const history = [...rendering.history];
	const context = structuredClone(buildSessionContext(manager.getEntries(), manager.getLeafId())), entries = structuredClone(manager.getEntries());
	await (InteractiveMode.prototype as any).handleReloadCommand.call(tui);
	assert.deepEqual(errors, []);
	assert.equal(starts, 2);assert.equal(rebuilds, 1);assert.equal((beforeStart.match(/IMAGE /g) ?? []).length, 1);
	const afterStart = stripAnsi(tui.chatContainer.render(80).join("\n"));assert.equal(afterStart, beforeStart);
	assert.deepEqual((Markdown.prototype as any).__piImageLabelsV2.registry.list().map((part: any) => part.path), [path]);
	assert.deepEqual(buildSessionContext(manager.getEntries(), manager.getLeafId()), context);assert.deepEqual(manager.getEntries(), entries);assert.deepEqual(rendering.history, history);
});

test("lazy persisted hydration during rendering preserves pending queued provenance", async t => {
	const { cwd } = fixture(t), older = new ImageProvenance(), queued = new ImageProvenance();
	const { message } = await prepare(older, cwd), record = older.capture(message)!;
	const next = await prepare(queued, cwd);next.message.timestamp++;
	const branch = [{ type: "custom", customType: PROVENANCE_TYPE, data: record }];
	assert.deepEqual(queued.forMessage(message, () => branch), record.sources);
	assert.deepEqual(queued.forMessage(message, () => branch), record.sources);
	assert.ok(queued.capture(next.message), "renders must not clear prepared steering/follow-up input");
});

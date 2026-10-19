import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import installImages from "./index.ts";
import { IMAGE_LIMITS, loadReferencedImage, resolveLocalImagePath, transformImageInput } from "./input.ts";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const GIF = "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
const native = (data = PNG, mimeType = "image/png") => ({ type: "image" as const, data, mimeType });
const input = (text: string, extra = {}) => ({ type: "input" as const, source: "interactive" as const, text, ...extra });
function root(t: any) {
	const path = mkdtempSync(join(homedir(), "tmp/pi-shared-native-test-"));
	t.after(() => rmSync(path, { recursive: true, force: true }));
	return path;
}

test("absolute, tilde, relative, quoted and Markdown paths attach content with byte-exact input", async t => {
	const cwd = root(t), path = join(cwd, "camera photo.JPG");
	writeFileSync(path, Buffer.from(PNG, "base64"));
	const refs = [path, `~/` + relative(homedir(), path), "./camera photo.JPG", "../" + cwd.split("/").at(-1) + "/camera photo.JPG"];
	for (const [index, ref] of refs.entries()) {
		const text = index === 0 ? `Inspect ![camera](<${ref}>)\r\n  ` : `Inspect "${ref}"\r\n  `;
		const event = input(text), before = structuredClone(event);
		const result: any = await transformImageInput(event, cwd);
		assert.deepEqual(result, { action: "transform", text, images: [native()] });
		assert.deepEqual(event, before);
	}
	assert.equal(resolveLocalImagePath("~/images/a.jpg", cwd), join(homedir(), "images/a.jpg"));
	assert.equal((await loadReferencedImage(path, cwd)).mimeType, "image/png", "content sniffing wins over .JPG spelling");
});

test("interactive, rpc, extension and streaming sources retain existing native blocks and dedup bytes/files", async t => {
	const cwd = root(t), a = join(cwd, "a.png"), b = join(cwd, "b.png"), c = join(cwd, "c.gif");
	writeFileSync(a, Buffer.from(PNG, "base64"));writeFileSync(b, readFileSync(a));writeFileSync(c, Buffer.from(GIF, "base64"));
	symlinkSync(a, join(cwd, "alias.png"));
	const original = native();
	for (const source of ["interactive", "rpc", "extension"] as const) for (const streamingBehavior of [undefined, "steer", "followUp"] as const) {
		const text = "Look ./a.png ./b.png ./alias.png ./c.gif ./a.png", images = [original, structuredClone(original)];
		const event = input(text, { source, streamingBehavior, images }), before = structuredClone(event);
		const result: any = await transformImageInput(event, cwd);
		assert.equal(result.text, text);assert.equal(result.images.length, 2);
		assert.strictEqual(result.images[0], original);
		assert.deepEqual(result.images[1], native(GIF, "image/gif"));
		assert.deepEqual(event, before);
	}
	assert.deepEqual(await transformImageInput(input("No paths", { images: [original] }), cwd), { action: "continue" });
	const result: any = await transformImageInput(input("Only native", { images: [original, original] }), cwd);
	assert.equal(result.images.length, 1);assert.strictEqual(result.images[0], original);
});

test("URLs and prose do not cause file reads or transforms", async t => {
	const cwd = root(t);
	for (const text of ["https://host/a(b)/x.jpg", "data:image/png;base64,aaa/a.png", "a.png is prose", "![remote](https://host/a.png)"]) {
		assert.deepEqual(await transformImageInput(input(text), cwd), { action: "continue" });
	}
});

test("missing, nonregular, empty, unsupported and undecodable references reject clearly", async t => {
	const cwd = root(t);
	mkdirSync(join(cwd, "directory.png"));
	writeFileSync(join(cwd, "empty.png"), "");writeFileSync(join(cwd, "fake.jpg"), "not an image");
	writeFileSync(join(cwd, "camera.HEIC"), Buffer.from("000000006674797068656963", "hex"));
	writeFileSync(join(cwd, "broken.png"), Buffer.from(PNG, "base64").subarray(0, 33));
	execFileSync("mkfifo", [join(cwd, "fifo.png")]);
	for (const [ref, reason] of [
		["missing.png", /missing.png.*ENOENT/], ["directory.png", /regular file/], ["fifo.png", /regular file/],
		["empty.png", /empty/], ["fake.jpg", /Unsupported image content/], ["camera.HEIC", /upload camera formats through X/], ["broken.png", /could not be decoded/],
	] as const) await assert.rejects(transformImageInput(input(`./${ref}`), cwd), reason);
	await assert.rejects(transformImageInput(input("native mismatch", { images: [native(PNG, "image/jpeg")] }), cwd), /MIME type/);
	await assert.rejects(transformImageInput(input("native invalid", { images: [native("bad!")] }), cwd), /base64/);
});

test("count, file, total decoded-byte and pixel bounds fail before submission", async t => {
	const cwd = root(t);
	await assert.rejects(transformImageInput(input(Array.from({ length: 21 }, (_, i) => `./${i}.png`).join(" ")), cwd), /At most 20/);
	await assert.rejects(transformImageInput(input("native count", { images: Array(21).fill(native()) }), cwd), /At most 20/);
	const large = join(cwd, "large.png");writeFileSync(large, Buffer.from(PNG, "base64"));truncateSync(large, IMAGE_LIMITS.fileBytes + 1);
	await assert.rejects(transformImageInput(input("./large.png"), cwd), /20 MiB/);
	const hugePixels = Buffer.from(PNG, "base64");hugePixels.writeUInt32BE(16385, 16);writeFileSync(join(cwd, "huge.png"), hugePixels);
	await assert.rejects(transformImageInput(input("./huge.png"), cwd), /pixel limits/);
	const count = Array.from({ length: 21 }, (_, i) => native(Buffer.concat([Buffer.from(PNG, "base64"), Buffer.from([i])]).toString("base64")));
	writeFileSync(join(cwd, "last.png"), Buffer.from(count[20].data, "base64"));
	await assert.rejects(transformImageInput(input("./last.png", { images: count.slice(0, 20) }), cwd), /20 images/);
	// PNG trailing bytes are tolerated by Pi's decoder; distinct padding makes unique large images.
	for (let i = 0; i < 3; i++) {
		const bytes = Buffer.alloc(18 * 1024 * 1024, i);Buffer.from(PNG, "base64").copy(bytes);
		writeFileSync(join(cwd, `total-${i}.png`), bytes);
	}
	await assert.rejects(transformImageInput(input("./total-0.png ./total-1.png ./total-2.png"), cwd), /50 MiB total/);
});

test("registered input hook consumes invalid input instead of Pi's fail-open exception behavior", async t => {
	const cwd = root(t), handlers = new Map<string, any>(), notifications: any[] = [];
	installImages({ on(name: string, fn: any) { handlers.set(name, fn); }, registerShortcut() {}, registerCommand() {} } as any);
	t.after(() => handlers.get("session_shutdown")());
	const event = input("./missing.png", { source: "extension", streamingBehavior: "followUp" }), before = structuredClone(event);
	const result = await handlers.get("input")(event, { cwd, ui: { notify: (...args: any[]) => notifications.push(args) } });
	assert.deepEqual(result, { action: "handled" });assert.deepEqual(event, before);
	assert.match(notifications[0][0], /Image submission rejected.*missing.png/);assert.equal(notifications[0][1], "error");
});

test("SDK jiti input, extension sendUserMessage, native normalization and streaming queues without inference", async t => {
	const cwd = root(t), settingsManager = SettingsManager.inMemory({});
	writeFileSync(join(cwd, "a.png"), Buffer.from(PNG, "base64"));
	const resourceLoader = new DefaultResourceLoader({ cwd, agentDir: cwd, settingsManager, additionalExtensionPaths: [new URL("./index.ts", import.meta.url).pathname], noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
	await resourceLoader.reload();assert.deepEqual(resourceLoader.getExtensions().errors, []);
	const manager = SessionManager.inMemory(cwd);
	const { session } = await createAgentSession({ cwd, agentDir: cwd, settingsManager, resourceLoader, sessionManager: manager, noTools: "all" });
	t.after(() => session.dispose());
	const notifications: string[] = [];
	await session.bindExtensions({ mode: "print", uiContext: { notify: (message: string) => notifications.push(message) } as any });
	const owned: any = session;
	// Keep the real SDK prompt path through normalization, but intercept the inference boundary.
	owned.agent.state.model = { provider: "owned-test", id: "no-inference", input: ["text", "image"], reasoning: false };
	owned._modelRuntime.hasConfiguredAuth = () => true;
	owned._modelRuntime.streamSimple = () => assert.fail("No inference allowed");
	const messages: any[] = [], queued: any[] = [];
	owned._runAgentPrompt = async (payload: any[]) => messages.push(payload);
	await session.prompt("Inspect ./a.png\r\n ", { images: [native()] });
	assert.equal(messages.length, 1);
	const user = messages[0].find((message: any) => message.role === "user");
	assert.deepEqual(user.content, [{ type: "text", text: "Inspect ./a.png\r\n " }, native()]);
	await session.sendUserMessage("Extension ./a.png");
	assert.deepEqual(messages[1].find((message: any) => message.role === "user").content, [{ type: "text", text: "Extension ./a.png" }, native()]);
	owned._isAgentRunActive = true;
	owned.agent.steer = (message: any) => queued.push(["steer", message]);
	owned.agent.followUp = (message: any) => queued.push(["followUp", message]);
	await session.prompt("Steer ./a.png", { streamingBehavior: "steer" });
	await session.sendUserMessage("Follow ./a.png", { deliverAs: "followUp" });
	assert.deepEqual(queued.map(([behavior, message]) => [behavior, message.content]), [
		["steer", [{ type: "text", text: "Steer ./a.png" }, native()]],
		["followUp", [{ type: "text", text: "Follow ./a.png" }, native()]],
	]);
	await assert.rejects(session.prompt("No delivery ./a.png"), /Specify streamingBehavior/);
	await session.sendUserMessage("Invalid ./missing.png", { deliverAs: "followUp" });
	assert.equal(queued.length, 2);assert.match(notifications.at(-1)!, /rejected.*missing.png/);
	owned._isAgentRunActive = false;
});


test("JPEG and WebP are sniffed, decoded and attached as real native raster images", async t => {
	const cwd = root(t);
	const jpeg = "/9j/4AAQSkZJRgABAgAAAQABAAD/wAARCAABAAEDAREAAhEBAxEB/9sAQwAGBAUGBQQGBgUGBwcGCAoQCgoJCQoUDg8MEBcUGBgXFBYWGh0lHxobIxwWFiAsICMmJykqKRkfLTAtKDAlKCko/9sAQwEHBwcKCAoTCgoTKBoWGigoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgo/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD5UoA//9k=";
	const webp = "UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEAAUAmJaQAA3AA/v89WAAAAA==";
	writeFileSync(join(cwd, "camera.JPEG"), Buffer.from(jpeg, "base64"));
	writeFileSync(join(cwd, "camera.WEBP"), Buffer.from(webp, "base64"));
	const result: any = await transformImageInput(input("Inspect ./camera.JPEG ./camera.WEBP"), cwd);
	assert.deepEqual(result.images, [native(jpeg, "image/jpeg"), native(webp, "image/webp")]);
});

test("headless invalid submissions emit an explicit diagnostic while remaining handled", async t => {
	const cwd = root(t), handlers = new Map<string, any>(), diagnostics: string[] = [];
	t.mock.method(console, "error", (message: string) => diagnostics.push(message));
	installImages({ on(name: string, fn: any) { handlers.set(name, fn); }, registerShortcut() {}, registerCommand() {} } as any);
	t.after(() => handlers.get("session_shutdown")());
	const result = await handlers.get("input")(input("./missing.png"), { cwd, hasUI: false, ui: { notify() {} } });
	assert.deepEqual(result, { action: "handled" });assert.match(diagnostics[0], /rejected.*missing.png/);
});

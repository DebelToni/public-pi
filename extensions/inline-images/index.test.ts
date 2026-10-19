import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Markdown, setCapabilities } from "@earendil-works/pi-tui";
import installImages, { findViewingClient, formatImageLabel, imageIdAt, ImageRegistry, popupArguments, resolveLocalImagePath } from "./index.ts";

const PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
	"base64",
);

test("local paths are allowed; remote images are not registered", () => {
	assert.equal(resolveLocalImagePath("assets/a.png", "/tmp/project"), "/tmp/project/assets/a.png");
	assert.equal(resolveLocalImagePath("https://example.com/a.png", "/tmp/project"), undefined);
	assert.equal(resolveLocalImagePath("data:image/png;base64,abc", "/tmp/project"), undefined);
});

test("two base-36 characters provide exactly 1296 IDs", () => {
	assert.equal(imageIdAt(0), "00");
	assert.equal(imageIdAt(10), "0a");
	assert.equal(imageIdAt(36), "10");
	assert.equal(imageIdAt(1295), "zz");
	assert.equal(imageIdAt(1296), undefined);
});

test("IDs reuse paths and reset on a new conversation", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-image-ids-"));
	writeFileSync(join(root, "one.png"), PNG);
	writeFileSync(join(root, "two.png"), PNG);
	try {
		const registry = new ImageRegistry();
		registry.setSession("first");
		assert.equal(registry.register("one.png", root, "first image"), "00");
		assert.equal(registry.register("two.png", root, "second image"), "01");
		assert.equal(registry.register("one.png", root), "00");
		assert.deepEqual(registry.list().map(({ id, description }) => [id, description]),
			[["00", "first image"], ["01", "second image"]]);
		assert.equal(registry.register("missing.png", root), undefined);
		assert.equal(registry.register("https://example.org/file.png", root), undefined);
		assert.equal(registry.get("01"), join(root, "two.png"));
		registry.setSession("first");
		assert.equal(registry.get("01"), join(root, "two.png"));
		registry.setSession("second");
		assert.equal(registry.get("01"), undefined);
		assert.equal(registry.register("two.png", root), "00");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("fullscreen popup targets the viewing client and passes a manifest path safely", () => {
	assert.equal(formatImageLabel("0a", "hello\n[world]", "/tmp/file.png"), "[IMAGE 0a - hello world]");
	assert.equal(findViewingClient("/dev/ttys0\t%14\n/dev/ttys1\t%186\n", "%186"), "/dev/ttys1");
	assert.equal(findViewingClient("/dev/ttys0\t%14\n", "%186"), undefined);
	const args = popupArguments("/tmp/images with 'quotes'.json", "%186", "/dev/ttys1");
	assert.deepEqual(args.slice(0, 7), ["display-popup", "-E", "-B", "-c", "/dev/ttys1", "-t", "%186"]);
	assert.ok(args.includes("100%"));
	assert.equal(args.at(-1), "/tmp/images with 'quotes'.json");
	assert.match(args.at(-2)!, /viewer\.py$/);
});

test("shortcut opens newest image; /image ID opens a chosen one", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-image-label-"));
	const path = join(root, "one.png");
	const next = join(root, "two.png");
	writeFileSync(path, PNG);
	writeFileSync(next, PNG);
	const oldPane = process.env.TMUX_PANE;
	process.env.TMUX_PANE = "%186";
	let shortcut: any;
	let command: any;
	let sessionStart: any;
	const popups: Array<{ args: string[]; manifest: any }> = [];
	const notifications: string[] = [];
	let activePane = "%186";
	let popupExit = 0;
	const pi = {
		on(name: string, fn: any) { if (name === "session_start") sessionStart = fn; },
		registerShortcut(key: string, opts: any) { assert.equal(key, "alt+i"); shortcut = opts; },
		registerCommand(name: string, opts: any) { assert.equal(name, "image"); command = opts; },
		async exec(program: string, args: string[]) {
			assert.equal(program, "tmux");
			if (args[0] === "list-clients") return { code: 0, stdout: `/dev/ttys1\t${activePane}\n`, stderr: "" };
			popups.push({ args, manifest: JSON.parse(readFileSync(args.at(-1)!, "utf8")) });
			return { code: popupExit, stdout: "", stderr: "" };
		},
	};
	try {
		setCapabilities({ images: null, trueColor: true, hyperlinks: false });
		installImages(pi as any);
		sessionStart({}, { cwd: root, sessionManager: { getSessionId: () => "test-session" } });
		const lines = new Markdown(`Before ![diagram](${path}) After`, 0, 0, {} as any).render(80);
		assert.match(lines.join("\n"), /Before \[IMAGE 00 - diagram\] After/);
		const patched = Markdown.prototype.renderInlineTokens;
		installImages(pi as any);
		assert.strictEqual(Markdown.prototype.renderInlineTokens, patched);
		assert.match(new Markdown(`![diagram](${path})`, 0, 0, {} as any).render(80).join(""), /IMAGE 00/);
		assert.ok(!lines.join("\n").includes(path));
		assert.match(new Markdown(`![later](${next})`, 0, 0, {} as any).render(80).join(""), /IMAGE 01/);
		const ui = { notify(message: string) { notifications.push(message); } };
		await shortcut.handler({ mode: "tui", ui });
		await command.handler("00", { mode: "tui", ui });
		assert.deepEqual(notifications, []);
		assert.deepEqual(popups.map(({ manifest }) => manifest.selected), ["01", "00"]);
		assert.deepEqual(popups[0].manifest.images.map(({ id }: any) => id), ["00", "01"]);
		assert.ok(popups.every(({ args }) => args.includes("/dev/ttys1")));
		assert.ok(popups.every(({ args }) => !existsSync(args.at(-1)!)));
		activePane = "%205";
		await shortcut.handler({ mode: "tui", ui });
		assert.match(notifications.pop()!, /No tmux client is viewing Pi pane %186/);
		assert.equal(popups.length, 2);
		activePane = "%186";
		popupExit = 1;
		await shortcut.handler({ mode: "tui", ui });
		assert.match(notifications.pop()!, /exit code 1/);
		assert.ok(!existsSync(popups.at(-1)!.args.at(-1)!));
	} finally {
		if (oldPane === undefined) delete process.env.TMUX_PANE;
		else process.env.TMUX_PANE = oldPane;
		rmSync(root, { recursive: true, force: true });
	}
});

test("hot reload migrates an old registry without list()", () => {
	const proto = Markdown.prototype as any;
	const state = proto.__piImageLabelsV2;
	const previous = state.registry;
	const root = mkdtempSync(join(tmpdir(), "pi-image-registry-upgrade-"));
	const path = join(root, "old.png");
	writeFileSync(path, PNG);
	try {
		state.registry = {
			byPath: new Map([[path, "0a"]]),
			byId: new Map([["0a", path]]),
			sessionId: "same-session",
		};
		let sessionStart: any;
		installImages({
			on(name: string, fn: any) { if (name === "session_start") sessionStart = fn; },
			registerShortcut() {}, registerCommand() {},
		} as any);
		sessionStart({}, { cwd: root, sessionManager: { getSessionId: () => "same-session" } });
		assert.equal(state.registry.get("0a"), path);
		assert.deepEqual(state.registry.list(), [{ id: "0a", path, description: "old.png" }]);
		assert.match(new Markdown(`![old](${path})`, 0, 0, {} as any).render(80).join(""), /IMAGE 0a/);
	} finally {
		state.registry = previous;
		rmSync(root, { recursive: true, force: true });
	}
});

test("upgrades an already loaded image renderer on /reload", () => {
	const proto = Markdown.prototype as any;
	const previous = proto.renderInlineTokens;
	const previousMarker = proto.__piImageLabelsV2;
	const root = mkdtempSync(join(tmpdir(), "pi-image-upgrade-"));
	const path = join(root, "one.png");
	writeFileSync(path, PNG);
	try {
		delete proto.__piImageLabelsV2;
		proto.renderInlineTokens = function (tokens: any[], styleContext?: any) {
			if (tokens.some((token) => token.type === "image" && token.href)) return "OLD_IMAGE_RENDERER";
			return previous.call(this, tokens, styleContext);
		};
		installImages({ on() {}, registerShortcut() {}, registerCommand() {} } as any);
		const lines = new Markdown(`![diagram](${path})`, 0, 0, {} as any).render(80).join("\n");
		assert.match(lines, /\[IMAGE 00 - diagram\]/);
		assert.ok(!lines.includes("OLD_IMAGE_RENDERER"));
	} finally {
		proto.renderInlineTokens = previous;
		proto.__piImageLabelsV2 = previousMarker;
		rmSync(root, { recursive: true, force: true });
	}
});

test("viewer supplies explicit pixel dimensions to kitten", () => {
	const code = `import importlib.util, json; spec=importlib.util.spec_from_file_location('viewer', ${JSON.stringify(new URL("./viewer.py", import.meta.url).pathname)}); module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module); print(json.dumps({'args': module.kitten_args('/tmp/a.png',84,28), 'tall': module.tmux_wrap(b'\\x1b_Ga=T,s=12,v=8;AAAA\\x1b\\\\',84,28).decode('latin1'), 'wide': module.tmux_wrap(b'\\x1b_Ga=T,s=16,v=8;AAAA\\x1b\\\\',84,28).decode('latin1')}))`;
	const python = popupArguments("/tmp/test.json", "%1", "/dev/ttys1").at(-3)!;
	const { args, tall, wide } = JSON.parse(execFileSync(python, ["-c", code], { encoding: "utf8" }));
	assert.equal(args[0], join(homedir(), "bin", "kitten"));
	assert.ok(args.includes("--use-window-size=84,28,756,504"));
	assert.ok(args.includes("--place=84x26@0x1"));
	assert.ok(args.includes("--scale-up=yes"));
	assert.ok(args.includes("--passthrough=none"));
	assert.match(tall, /,r=26;/);
	assert.doesNotMatch(tall, /,c=/);
	assert.match(wide, /,c=84;/);
	assert.doesNotMatch(wide, /,r=/);
	assert.ok(wide.includes("tmux;"));
});

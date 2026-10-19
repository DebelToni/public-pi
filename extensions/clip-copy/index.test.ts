import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { copyViaClip, installClipCopy } from "./index.ts";

function fixture() {
	const root = mkdtempSync(join(homedir(), "tmp", "pi-clip-copy-test-"));
	const bin = join(root, "bin");
	mkdirSync(bin);
	mkdirSync(join(root, "tmp"));
	for (const name of ["clip", "osc52"]) {
		writeFileSync(join(bin, name), readFileSync(join(homedir(), "bin", name)), { mode: 0o700 });
	}
	writeFileSync(join(bin, "pbcopy"), '#!/bin/sh\ncat > "$TEST_CAPTURE"\nprintf native > "$TEST_ROUTE"\n', { mode: 0o700 });
	writeFileSync(join(bin, "tmux"), `#!/bin/sh
case "$1" in
  show-environment)
    printf '%s\\n' "$@" > "$TEST_QUERY"
    if [ "$TEST_TMUX_SSH" = 1 ]; then printf 'SSH_CONNECTION=synthetic-session\\n'; else exit 1; fi
    ;;
  load-buffer)
    [ "$2" = -w ] || exit 2
    cp "$3" "$TEST_CAPTURE"
    printf remote > "$TEST_ROUTE"
    ;;
  *) exit 2 ;;
esac
`, { mode: 0o700 });
	const env = {
		HOME: root, PATH: `${bin}:/usr/bin:/bin`, TMPDIR: join(root, "tmp"),
		TEST_CAPTURE: join(root, "capture"), TEST_ROUTE: join(root, "route"), TEST_QUERY: join(root, "query"),
	};
	return { root, bin, env, close: () => rmSync(root, { recursive: true, force: true }) };
}

for (const scenario of ["local", "ssh", "ssh-tty-only", "later-ssh-attachment", "local-tmux"] as const) {
	test(`actual clip/osc52 scripts route ${scenario} without touching real clipboards`, async () => {
		const f = fixture();
		try {
			const env: NodeJS.ProcessEnv = { ...f.env };
			if (scenario !== "local") Object.assign(env, { TMUX: "synthetic", TMUX_PANE: "%999999" });
			if (scenario === "ssh") env.SSH_CONNECTION = "synthetic";
			if (scenario === "ssh-tty-only") env.SSH_TTY = "synthetic";
			if (scenario === "later-ssh-attachment") env.TEST_TMUX_SSH = "1";
			const text = '# Synthetic\nПривет 👋\n$(do-not-execute) "quotes"\n' + "x".repeat(120_000);
			await copyViaClip(text, env);
			assert.equal(readFileSync(f.env.TEST_CAPTURE, "utf8"), text);
			assert.equal(readFileSync(f.env.TEST_ROUTE, "utf8"), scenario === "local" || scenario === "local-tmux" ? "native" : "remote");
			if (scenario === "later-ssh-attachment") {
				assert.equal(readFileSync(f.env.TEST_QUERY, "utf8"), 'show-environment\n-t\n%999999\nSSH_CONNECTION\n');
				assert.equal(env.SSH_CONNECTION, undefined, "must not mutate the Pi environment");
			}
		} finally { f.close(); }
	});
}

test("clip failure is reported without echoing stderr or message text", async () => {
	const f = fixture();
	try {
		writeFileSync(join(f.bin, "clip"), '#!/bin/sh\necho sensitive-fixture >&2\nexit 9\n', { mode: 0o700 });
		await assert.rejects(copyViaClip("synthetic", f.env), { message: "clip failed; clipboard delivery was not confirmed." });
		rmSync(join(f.bin, "clip"));
		await assert.rejects(copyViaClip("synthetic", f.env), { message: "clip failed; clipboard delivery was not confirmed." });
	} finally { f.close(); }
});

function host(text: string | undefined = "last assistant text") {
	const status: string[] = [], errors: string[] = [], flashes: string[] = [];
	return {
		session: { getLastAssistantText: () => text },
		ui: { flash: (s: string) => flashes.push(s) },
		showError: (s: string) => errors.push(s), showStatus: (s: string) => status.push(s),
		status, errors, flashes,
	};
}

test("last-message handler awaits clip and restores the original on shutdown", async () => {
	const original = async () => { throw new Error("native clipboard must not run"); };
	const prototype = { handleCopyCommand: original };
	const copied: string[] = [];
	const restore = installClipCopy(prototype, async text => { copied.push(text); });
	const h = host();
	await prototype.handleCopyCommand.call(h, { flashConfirmation: true });
	assert.deepEqual(copied, ["last assistant text"]);
	assert.deepEqual(h.flashes, ["Copied via clip!"]);
	assert.deepEqual(h.errors, []);
	restore();
	assert.equal(prototype.handleCopyCommand, original);
});

test("fullscreen selection delegates to Pi instead of copying the last message", async () => {
	let delegated = 0;
	const prototype = { handleCopyCommand: async () => { delegated++; } };
	installClipCopy(prototype, async () => { throw new Error("must not copy last message"); });
	const h = { ...host(), ui: { getCopyOnSelect: () => false, hasActiveSelection: () => true } };
	await prototype.handleCopyCommand.call(h, { preferSelection: true });
	assert.equal(delegated, 1);
});

test("missing messages and failed clipboard writes never claim success", async () => {
	const prototype = { handleCopyCommand: async () => {} };
	let called = 0;
	installClipCopy(prototype, async () => { called++; throw new Error("synthetic"); });
	const empty = host("");
	await prototype.handleCopyCommand.call(empty);
	assert.equal(called, 0);
	assert.equal(empty.errors.length, 1);
	const h = host();
	await prototype.handleCopyCommand.call(h);
	assert.equal(h.errors.length, 1);
	assert.deepEqual(h.status, []);
});

test("restore does not overwrite another extension's later patch", () => {
	const prototype = { handleCopyCommand: async () => {} };
	const restore = installClipCopy(prototype, async () => {});
	const later = async () => {};
	prototype.handleCopyCommand = later;
	restore();
	assert.equal(prototype.handleCopyCommand, later);
});

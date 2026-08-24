import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { isExistingEmptyDirectory, shouldBlockDangerousRmRf } from "./rm-rf-policy.ts";

const fixture = mkdtempSync(join(tmpdir(), "pi-safety-rmrf-"));
const safeRoot = join(fixture, "safe-temp");
const outside = join(fixture, "outside");
const empty = join(outside, "empty");
const nonempty = join(outside, "nonempty");
mkdirSync(safeRoot);
writeFileSync(join(safeRoot, ".sentinel"), "keep temp root");
mkdirSync(empty, { recursive: true });
mkdirSync(nonempty);
writeFileSync(join(nonempty, "keep"), "valuable");

test.after(() => rmSync(fixture, { recursive: true, force: true }));

const options = { tempRoots: [safeRoot] };
const blocks = (command: string, cwd = outside) => shouldBlockDangerousRmRf(command, cwd, options);

test("allows static descendants of the configured temp root", () => {
	assert.equal(blocks(`rm -rf ${safeRoot}/scratch`), false);
	assert.equal(blocks(`rm -rf ${safeRoot}/scratch/*`), false);
	assert.equal(blocks(`rm -rf ${safeRoot}/scratch 2>/dev/null || true`), false);
	assert.equal(blocks(`ssh host 'rm -rf ${safeRoot}/remote-scratch; mkdir -p ${safeRoot}/remote-scratch'`), false);
});

test("recognizes the system temp aliases without allowing their roots", () => {
	assert.equal(shouldBlockDangerousRmRf("rm -rf /tmp/pi-safety-missing", outside), false);
	assert.equal(shouldBlockDangerousRmRf("rm -rf /private/tmp/pi-safety-missing", outside), false);
	assert.equal(shouldBlockDangerousRmRf("rm -rf /tmp", outside), true);
	assert.equal(shouldBlockDangerousRmRf("rm -rf /", outside), true);
});

test("keeps dangerous roots, escapes, dynamic targets, and mixed target lists blocked", () => {
	assert.equal(blocks("rm -rf /"), true);
	assert.equal(blocks("rm -rf ~"), true);
	assert.equal(blocks("rm -rf *"), true);
	assert.equal(blocks(`rm -rf ${safeRoot}`), true);
	assert.equal(blocks(`rm -rf ${safeRoot}/../outside/nonempty`), true);
	assert.equal(blocks(`rm -rf ${safeRoot}/*/nested`), true);
	assert.equal(blocks(`rm -rf ${safeRoot}/scratch "$HOME"`), true);
	assert.equal(blocks(`rm -rf ${safeRoot}/scratch /`), true);
	assert.equal(blocks(`rm -rf ${safeRoot}/scratch && rm -rf /`), true);
	assert.equal(blocks(`rm -rf ${safeRoot}/scratch >/dev/null /`), true);
});

test("allows existing empty directories outside temp, but not files, missing paths, or nonempty directories", () => {
	assert.equal(isExistingEmptyDirectory(empty, outside), true);
	assert.equal(blocks(`rm -rf ${empty}`), false);
	assert.equal(blocks(`sudo -n rm -rf ${empty}`), false);
	assert.equal(blocks(`rm -rf ${nonempty}`), true);
	assert.equal(blocks(`rm -rf ${join(nonempty, "keep")}`), true);
	assert.equal(blocks(`rm -rf ${join(outside, "missing")}`), true);
});

test("does not trust a temp path that traverses a symlink outside the temp root", () => {
	const link = join(safeRoot, "escape");
	symlinkSync(nonempty, link, "dir");
	assert.equal(blocks(`rm -rf ${link}/keep`), true);
	assert.equal(blocks(`rm -rf ${link}/missing`), true);
});

test("leaves ordinary relative cleanup and harmless commands unchanged", () => {
	assert.equal(blocks("rm -rf build"), false);
	assert.equal(blocks("rm -r build"), false);
	assert.equal(blocks("echo done"), false);
});

import assert from "node:assert/strict";
import test from "node:test";
import {
	FAST_MODE_ENTRY_TYPE,
	getFastSessionMode,
	parseFastCommand,
	resolveFastMode,
	type FastSessionMode,
} from "./fast-mode.ts";

function entry(mode: FastSessionMode, updatedAt = Date.now()) {
	return {
		type: "custom",
		customType: FAST_MODE_ENTRY_TYPE,
		data: { version: 1, mode, updatedAt },
	};
}

test("parses the documented command forms only", () => {
	assert.deepEqual(parseFastCommand("ON"), { scope: "session", action: "on" });
	assert.deepEqual(parseFastCommand(" off "), { scope: "session", action: "off" });
	assert.deepEqual(parseFastCommand("status"), { scope: "session", action: "status" });
	assert.deepEqual(parseFastCommand("inherit"), { scope: "session", action: "inherit" });
	assert.deepEqual(parseFastCommand("global on"), { scope: "global", action: "on" });
	assert.deepEqual(parseFastCommand("global off"), { scope: "global", action: "off" });
	assert.deepEqual(parseFastCommand("global status"), { scope: "global", action: "status" });
	for (const invalid of ["", "yes", "global", "global inherit", "on extra"]) {
		assert.equal(parseFastCommand(invalid), undefined);
	}
});

test("sessions inherit the global default without an override", () => {
	assert.deepEqual(resolveFastMode([], false), {
		sessionMode: "inherit",
		globalDefault: false,
		effective: false,
	});
	assert.equal(resolveFastMode([], true).effective, true);
});

test("explicit session state wins over the global default", () => {
	assert.equal(resolveFastMode([entry("on")], false).effective, true);
	assert.equal(resolveFastMode([entry("off")], true).effective, false);
});

test("inherit clears an earlier explicit session override", () => {
	const entries = [entry("on", 1), entry("inherit", 2)];
	assert.equal(getFastSessionMode(entries), "inherit");
	assert.equal(resolveFastMode(entries, false).effective, false);
});

test("latest file entry wins across branches rather than following one branch", () => {
	const entries = [
		{ ...entry("on", 100), id: "left", parentId: "root" },
		{ ...entry("off", 50), id: "right", parentId: "root" },
	];
	assert.equal(getFastSessionMode(entries), "off");
});

test("malformed or future entries do not hide the latest valid state", () => {
	const entries = [
		entry("on", 1),
		{ type: "custom", customType: FAST_MODE_ENTRY_TYPE, data: { version: 2, mode: "off", updatedAt: 2 } },
		{ type: "custom", customType: FAST_MODE_ENTRY_TYPE, data: { version: 1, mode: "off" } },
	];
	assert.equal(getFastSessionMode(entries), "on");
});

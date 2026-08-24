import assert from "node:assert/strict";
import test from "node:test";
import { compactResumeHint } from "./index.ts";

test("removes only the plain resume-hint label", () => {
	assert.equal(
		compactResumeHint("To resume this session: pi --session 01a00fba-0c13-777c-8853-f6274a1e5d3f\n"),
		"pi --session 01a00fba-0c13-777c-8853-f6274a1e5d3f\n",
	);
});

test("removes the ANSI-dimmed resume-hint label", () => {
	assert.equal(
		compactResumeHint("\x1b[2mTo resume this session:\x1b[22m pi --session abc\n"),
		"pi --session abc\n",
	);
});

test("preserves session-directory arguments and unrelated output", () => {
	assert.equal(
		compactResumeHint("To resume this session: pi --session-dir '/tmp/custom dir' --session abc\n"),
		"pi --session-dir '/tmp/custom dir' --session abc\n",
	);
	assert.equal(compactResumeHint("Error: To resume this session: not a hint\n"), "Error: To resume this session: not a hint\n");
});

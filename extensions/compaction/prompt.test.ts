import assert from "node:assert/strict";
import test from "node:test";
import { CUSTOM_COMPACTION_PROMPT, buildCompactionPrompt } from "./prompt.ts";

test("custom memory-transfer prompt wraps the serialized conversation", () => {
	const result = buildCompactionPrompt("[User]: current work");
	assert.ok(result.startsWith(CUSTOM_COMPACTION_PROMPT));
	assert.match(result, /<conversation>\n\[User\]: current work\n<\/conversation>$/);
});

test("compaction explicitly excludes secret material", () => {
	assert.match(CUSTOM_COMPACTION_PROMPT, /NEVER PRESERVE credentials/);
	assert.doesNotMatch(CUSTOM_COMPACTION_PROMPT, /^PRESERVE credentials/m);
});

test("previous summary and manual /compact instructions are preserved", () => {
	const result = buildCompactionPrompt(
		"conversation",
		"prior durable state",
		"focus especially on the provider payload",
	);
	assert.match(result, /Previous summary to carry forward:\nprior durable state/);
	assert.match(result, /Additional compaction focus from the user:\nfocus especially on the provider payload/);
});

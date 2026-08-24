import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import steeringContinuity, {
	STEERING_CONTINUITY_MESSAGE_TYPE,
	STEERING_CONTINUITY_REMINDER,
} from "./index.ts";

type InputEvent = {
	text: string;
	images?: unknown[];
	streamingBehavior?: "steer" | "followUp";
};
type InputHandler = (event: InputEvent) => unknown;
type SentMessage = {
	message: { customType: string; content: string; display: boolean };
	options: { deliverAs?: "steer" | "followUp" | "nextTurn" } | undefined;
};

function registeredHandler() {
	let handler: InputHandler | undefined;
	const sent: SentMessage[] = [];
	steeringContinuity({
		on(event: string, candidate: InputHandler) {
			if (event === "input") handler = candidate;
		},
		sendMessage(message: SentMessage["message"], options: SentMessage["options"]) {
			sent.push({ message, options });
		},
	} as unknown as ExtensionAPI);
	assert.ok(handler);
	return { handler, sent };
}

test("the continuity reminder is concise", () => {
	assert.match(STEERING_CONTINUITY_REMINDER, /additive work or clarification/);
	assert.match(STEERING_CONTINUITY_REMINDER, /Preserve and complete all unfinished, non-conflicting prior work/);
	assert.match(STEERING_CONTINUITY_REMINDER, /active task and each additive steering message, in their original order/);
});

test("steering queues a hidden reminder and leaves the user message unchanged", async () => {
	const { handler, sent } = registeredHandler();
	const images = [{ type: "image" }];
	assert.deepEqual(await handler({ text: "answer this", images, streamingBehavior: "steer" }), {
		action: "continue",
	});
	assert.deepEqual(sent, [{
		message: {
			customType: STEERING_CONTINUITY_MESSAGE_TYPE,
			content: STEERING_CONTINUITY_REMINDER,
			display: false,
		},
		options: { deliverAs: "steer" },
	}]);
});

test("follow-up and idle messages do not queue a reminder", async () => {
	const { handler, sent } = registeredHandler();
	assert.deepEqual(await handler({ text: "later", streamingBehavior: "followUp" }), { action: "continue" });
	assert.deepEqual(await handler({ text: "idle" }), { action: "continue" });
	assert.deepEqual(sent, []);
});

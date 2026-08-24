import { describe, expect, test } from "bun:test";
import { requestContinuation } from "./continuation-request.js";

function setup() {
	const sent: any[] = [];
	const events = { emit() {} };
	const pi = {
		events,
		sendMessage(message: any, options: any) {
			sent.push({ message, options });
			return Promise.resolve();
		},
	} as any;
	return { pi, sent };
}

describe("automatic recovery continuation", () => {
	test("continues the main task without the subagent extension", async () => {
		const { pi, sent } = setup();
		await requestContinuation(pi, { isIdle: () => true } as any, { target: "main" });
		expect(sent).toEqual([{
			message: {
				customType: "main-continuation",
				content: "<system-reminder>\nContinue the interrupted main task from the current conversation and external state. Preserve completed work, verify uncertain side effects, and do not restart the task unnecessarily.\n</system-reminder>",
				display: false,
			},
			options: { deliverAs: "steer", triggerTurn: true },
		}]);
	});

	test("uses the subagent continuation handler when it is installed", async () => {
		const sent: any[] = [];
		const pi = {
			events: { emit(value: any, request: any) { request.run = Promise.resolve("handled"); } },
			sendMessage(message: any, options: any) { sent.push({ message, options }); return Promise.resolve(); },
		} as any;
		await expect(requestContinuation(pi, { isIdle: () => true } as any, { target: "main" })).resolves.toBe("handled");
		expect(sent).toEqual([]);
	});
});

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, test } from "bun:test";
import {
	CODEX_SEAT_REQUEST_CHANNEL,
	CODEX_SELECTION_REQUEST_CHANNEL,
	codexAccountSelectionDisabled,
	formatCodexAccountUsage,
	hasUnambiguousPostSeatUsage,
	parseCodexUsageStatus,
	requestCodexAccountSelection,
	requestCodexSeatChange,
	type CodexSeatRequestV1,
	type CodexSelectionRequestV1,
} from "./index.js";

const context = {} as ExtensionContext;
const guard = () => true;

describe("Codex account boundary", () => {
	test("seat requests expose only the versioned context and guard", async () => {
		let keys: string[] = [];
		const events = {
			emit(channel: string, value: unknown) {
				expect(channel).toBe(CODEX_SEAT_REQUEST_CHANNEL);
				const request = value as CodexSeatRequestV1;
				keys = Object.keys(request).sort();
				request.run = Promise.resolve({ version: 1, status: "succeeded" });
			},
		};
		expect(await requestCodexSeatChange({ events } as never, context, guard)).toEqual({
			version: 1,
			status: "succeeded",
		});
		expect(keys).toEqual(["context", "guard", "version"]);
	});

	test("selection commands honor the synchronous companion test-mode block", () => {
		const events = {
			emit(_channel: string, value: unknown) {
				(value as { selectionDisabled: boolean }).selectionDisabled = true;
			},
		};
		expect(codexAccountSelectionDisabled({ events } as never)).toBe(true);
	});

	test("missing companion is explicitly unavailable", async () => {
		const result = await requestCodexSeatChange({ events: { emit() {} } } as never, context, guard);
		expect(result.status).toBe("unavailable");
	});

	test("recovery selection uses a narrow versioned request", async () => {
		let keys: string[] = [];
		const events = {
			emit(channel: string, value: unknown) {
				expect(channel).toBe(CODEX_SELECTION_REQUEST_CHANNEL);
				const request = value as CodexSelectionRequestV1;
				keys = Object.keys(request).sort();
				request.run = Promise.resolve({
					version: 1,
					status: "selected",
					provider: "codex-next",
					modelId: request.modelId,
					syncId: "sync-1",
				});
			},
		};
		expect(await requestCodexAccountSelection({ events } as never, context, "gpt-5.6-sol", guard)).toEqual({
			version: 1,
			status: "selected",
			provider: "codex-next",
			modelId: "gpt-5.6-sol",
			syncId: "sync-1",
		});
		expect(keys).toEqual(["context", "guard", "modelId", "version"]);
	});
});

describe("Codex usage classification", () => {
	test("hard quota signals override percentage fields", () => {
		expect(parseCodexUsageStatus({
			rate_limit: { limit_reached: true, primary_window: { used_percent: 20 } },
		})).toEqual({ score: 0, label: "rate limit reached" });
	});

	test("usage-based accounts remain excluded", () => {
		expect(parseCodexUsageStatus({
			spend_control: { reached: false },
			credits: { overage_limit_reached: false },
		})).toEqual({ score: -1, label: "usage-based/skipped" });
	});

	test("usage reports preserve account labels without selecting a provider", () => {
		expect(formatCodexAccountUsage([
			{ label: "Y Ananas", providerId: "codex-y-ananas", usage: { score: 80, label: "80% left" } },
			{ label: "X Banan", providerId: "codex-x-banan", usage: { score: -1, label: "usage-based/skipped" } },
		])).toBe("Y Ananas: 80% left\nX Banan: usage-based/skipped");
	});

	test("post-seat state requires one usable account and no unknown observations", () => {
		const usable = { score: 75, label: "75% left" };
		const exhausted = { score: 0, label: "rate limit reached" };
		const usageBased = { score: -1, label: "usage-based/skipped" };
		expect(hasUnambiguousPostSeatUsage([usable, exhausted, usageBased])).toBe(true);
		expect(hasUnambiguousPostSeatUsage([usable, usable, usageBased])).toBe(false);
		expect(hasUnambiguousPostSeatUsage([usable, undefined])).toBe(false);
		expect(hasUnambiguousPostSeatUsage([exhausted, usageBased])).toBe(false);
	});
});

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	CODEX_ACCOUNT_SELECTION_MODE_CHANNEL,
	formatCodexAccountUsage,
	hasUnambiguousPostSeatUsage,
	queryCodexAccountUsage,
	requestCodexSeatChange,
	type CodexAccountUsageEntry,
	type CodexSeatRequestResultV1,
} from "../codex-accounts/index.js";

const POLL_ATTEMPTS = 12;
const POLL_INTERVAL_MS = 5_000;

export function soleUsableProvider(entries: readonly CodexAccountUsageEntry[]) {
	if (!hasUnambiguousPostSeatUsage(entries.map((entry) => entry.usage))) return undefined;
	return entries.find((entry) => (entry.usage?.score ?? 0) > 0)?.providerId;
}

type SeatCycleCheckOperations = {
	query(context: ExtensionContext, forceRefresh: boolean): Promise<CodexAccountUsageEntry[]>;
	rotate(
		pi: ExtensionAPI,
		context: ExtensionContext,
		guard: () => boolean,
	): Promise<CodexSeatRequestResultV1>;
	sleep(milliseconds: number): Promise<void>;
};

const DEFAULT_OPERATIONS: SeatCycleCheckOperations = {
	query: queryCodexAccountUsage,
	rotate: requestCodexSeatChange,
	sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
};

export function installCodexSelectionTestMode(pi: ExtensionAPI) {
	return pi.events.on(CODEX_ACCOUNT_SELECTION_MODE_CHANNEL, (value) => {
		if (!value || typeof value !== "object") return;
		const mode = value as { version?: unknown; selectionDisabled?: unknown };
		if (mode.version === 1 && mode.selectionDisabled === false) {
			mode.selectionDisabled = true;
		}
	});
}

export function installSeatCycleCheck(
	pi: ExtensionAPI,
	overrides: Partial<SeatCycleCheckOperations> = {},
) {
	const operations = { ...DEFAULT_OPERATIONS, ...overrides };
	let sessionGeneration = 0;
	let sessionActive = false;
	pi.on("session_start", () => {
		sessionGeneration++;
		sessionActive = true;
	});
	pi.on("session_shutdown", () => {
		sessionGeneration++;
		sessionActive = false;
	});

	pi.registerCommand("seat-cycle-check", {
		description: "Rotate one prepaid seat and print usage changes without selecting a model",
		handler: async (args, context) => {
			if (args.trim()) {
				context.ui.notify("Usage: /seat-cycle-check", "warning");
				return;
			}
			const generation = sessionGeneration;
			const guard = () => sessionActive && generation === sessionGeneration;
			const before = await operations.query(context, true);
			const beforeProvider = soleUsableProvider(before);
			context.ui.notify(`Before seat rotation:\n${formatCodexAccountUsage(before)}`, "info");
			if (!beforeProvider) {
				context.ui.notify(
					"The initial usage state is not uniquely attributable; no seat was rotated.",
					"warning",
				);
				return;
			}
			if (!guard()) return;

			const seat = await operations.rotate(pi, context, guard);
			if (seat.status !== "succeeded") {
				context.ui.notify(
					`Seat rotation ${seat.status}: ${seat.message}`,
					seat.status === "failed" ? "error" : "warning",
				);
				return;
			}

			let after = before;
			let afterProvider: string | undefined;
			for (let attempt = 0; attempt < POLL_ATTEMPTS && guard(); attempt++) {
				await operations.sleep(POLL_INTERVAL_MS);
				if (!guard()) return;
				after = await operations.query(context, attempt === 0);
				afterProvider = soleUsableProvider(after);
				if (afterProvider && afterProvider !== beforeProvider) break;
			}
			const moved = !!afterProvider && afterProvider !== beforeProvider;
			context.ui.notify(
				[
					moved
						? `Seat usage moved to ${afterProvider}.`
						: "Seat rotated, but a unique changed usage holder was not observed before timeout.",
					formatCodexAccountUsage(after),
				].join("\n"),
				moved ? "info" : "warning",
			);
		},
	});
}

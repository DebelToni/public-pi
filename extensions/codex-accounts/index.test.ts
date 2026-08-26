import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
	formatCodexAccountUsage,
	forcedOAuthRefreshRequested,
	formatRemaining,
	loadCodexUsageHistory,
	parseCodexUsageStatus,
	quotaWindowLabel,
	saveCodexUsageSnapshots,
	type CodexUsageSnapshot,
} from "./index.ts";

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

function snapshot(providerId: string, observedAt: number, leftPercent: number): CodexUsageSnapshot {
	return {
		label: providerId.replace("codex-", ""),
		providerId,
		planType: "team",
		observedAt,
		windows: [{
			label: "5h",
			usedPercent: 100 - leftPercent,
			leftPercent,
			limitWindowSeconds: 18_000,
			resetAtMs: observedAt + 2 * HOUR_MS,
		}],
	};
}

test("forced OAuth refresh flags are rejected before command parsing", () => {
	assert.equal(forcedOAuthRefreshRequested("--refresh account1 gpt-5.6-sol"), true);
	assert.equal(forcedOAuthRefreshRequested("-r account1 gpt-5.6-sol"), true);
	assert.equal(forcedOAuthRefreshRequested("--auto gpt-5.6-sol"), false);
});

test("usage parsing derives 5h/weekly labels from durations and normalizes reset timestamps", () => {
	const now = Date.UTC(2026, 7, 25, 12, 0, 0);
	const usage = parseCodexUsageStatus({
		plan_type: "team",
		rate_limit: {
			// Deliberately reversed to prove labels do not depend on primary/secondary roles.
			primary_window: { used_percent: 40, limit_window_seconds: 604_800, reset_at: (now + 5 * DAY_MS) / 1000 },
			secondary_window: { used_percent: 12, limit_window_seconds: 18_000, reset_after_seconds: 2 * 60 * 60 },
		},
	}, now)!;
	assert.equal(usage.score, 60);
	assert.equal(usage.label, "5h 88% left · weekly 60% left");
	assert.deepEqual(usage.windows.map(({ label, leftPercent }) => ({ label, leftPercent })), [
		{ label: "5h", leftPercent: 88 },
		{ label: "weekly", leftPercent: 60 },
	]);
	assert.equal(usage.windows[0].resetAtMs, now + 2 * HOUR_MS);
	assert.equal(usage.windows[1].resetAtMs, now + 5 * DAY_MS);
	assert.equal(quotaWindowLabel(86_400, "primary"), "1d");
	assert.equal(formatRemaining(now + DAY_MS + 3 * HOUR_MS, now), "1d 3h");
});

test("usage-based plans have no quota windows and cannot replace saved quota", () => {
	const usage = parseCodexUsageStatus({
		plan_type: "self_serve_business_usage_based",
		spend_control: { reached: false },
		credits: { overage_limit_reached: false },
	}, 123)!;
	assert.equal(usage.score, -1);
	assert.equal(usage.label, "usage-based/skipped");
	assert.deepEqual(usage.windows, []);
});

test("quota snapshots are atomically overwritten per account with mode 0600", (t) => {
	const root = mkdtempSync("/tmp/pi-codex-usage-");
	const path = join(root, "history.json");
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const old = snapshot("codex-one", 1_000, 90);
	const other = snapshot("codex-two", 2_000, 80);
	saveCodexUsageSnapshots([old, other], path);
	const replacement = snapshot("codex-one", 3_000, 25);
	saveCodexUsageSnapshots([replacement], path);
	const history = loadCodexUsageHistory(path);
	assert.equal(history.accounts["codex-one"].observedAt, 3_000);
	assert.equal(history.accounts["codex-one"].windows[0].leftPercent, 25);
	assert.equal(history.accounts["codex-two"].observedAt, 2_000);
	assert.equal(statSync(path).mode & 0o777, 0o600);
});

test("formatting reports live usage-based state together with stale saved quota", () => {
	const now = Date.UTC(2026, 7, 25, 12, 0, 0);
	const saved = snapshot("codex-account7", now - HOUR_MS, 44);
	const text = formatCodexAccountUsage([{
		label: "account7",
		providerId: "codex-account7",
		usage: { score: -1, label: "usage-based/skipped", planType: "usage", observedAt: now, windows: [] },
		saved,
	}], now);
	assert.match(text, /account7: usage-based\/skipped; saved 1h 0m ago: 5h: 44% left/);
});

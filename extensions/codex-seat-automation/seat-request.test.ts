import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	CODEX_SEAT_REQUEST_CHANNEL,
	requestCodexSeatChange,
} from "../codex-accounts/index.js";
import {
	executeSeatRequestV1,
	installSeatRequestHook,
	type SeatAutomationConfigV1,
} from "./seat-request.js";
import type { VerifiedWebhookResult } from "./webhook-client.mjs";

const OPERATION_ID = "123e4567-e89b-12d3-a456-426614174000";
const context = {} as ExtensionContext;
const config: SeatAutomationConfigV1 = {
	version: 1,
	enabled: true,
	automaticRecovery: false,
	keyId: "friend-1",
	privateKeyPath: "/private/key",
	macPublicKeyPath: "/public/mac-key",
	url: "https://example.test/hook/abcdefghijklmnopqrstuvwxyz123456",
};
const CONFIGURATION_ID = createHash("sha256").update(JSON.stringify({
	keyId: config.keyId,
	privateKeyPath: config.privateKeyPath,
	macPublicKeyPath: config.macPublicKeyPath,
	url: config.url,
})).digest("hex");

class EventBus {
	private handlers = new Map<string, Set<(value: unknown) => void>>();

	emit(channel: string, value: unknown) {
		for (const handler of this.handlers.get(channel) ?? []) handler(value);
	}

	on(channel: string, handler: (value: unknown) => void) {
		const handlers = this.handlers.get(channel) ?? new Set();
		handlers.add(handler);
		this.handlers.set(channel, handlers);
		return () => handlers.delete(handler);
	}
}

function hookHarness(transport: Parameters<typeof installSeatRequestHook>[1]) {
	const events = new EventBus();
	const lifecycle = new Map<string, Array<() => void>>();
	const pi = {
		events,
		on(event: string, handler: () => void) {
			const handlers = lifecycle.get(event) ?? [];
			handlers.push(handler);
			lifecycle.set(event, handlers);
		},
	} as unknown as ExtensionAPI;
	installSeatRequestHook(pi, transport);
	return { events, lifecycle, pi };
}

function response(
	state: "accepted" | "running" | "succeeded" | "failed" | "uncertain",
): VerifiedWebhookResult {
	const terminal = ["succeeded", "failed", "uncertain"].includes(state);
	const successful = state === "succeeded";
	return {
		status: state === "accepted" ? 202 : 200,
		ok: true,
		code: state === "accepted" ? "JOB_ACCEPTED" : "JOB_STATUS",
		message: "verified",
		job: {
			kind: "seat.rotate",
			operationId: OPERATION_ID,
			state,
			result: terminal
				? { ok: successful, code: successful ? "SEAT_ROTATED" : "FAILED", message: "terminal", data: {} }
				: null,
			isTerminal: terminal,
		},
		payload: {},
	};
}

function dependencies(options: {
	rotate?: () => Promise<VerifiedWebhookResult>;
	status?: () => Promise<VerifiedWebhookResult>;
	pending?: { version: 1; operationId: string; createdAt: number; configurationId: string };
} = {}) {
	let pending = options.pending;
	let generated = 0;
	let clears = 0;
	return {
		values: {
			rotate: options.rotate ?? (async () => response("accepted")),
			status: options.status ?? (async () => response("succeeded")),
			newOperationId: () => { generated++; return OPERATION_ID; },
			now: () => 1_000,
			sleep: async () => {},
			loadConfig: () => config,
			withLock: async <T>(operation: () => Promise<T>) => operation(),
			readPending: () => pending,
			writePending: (value: typeof pending) => { pending = value; },
			clearPending: (operationId: string) => {
				if (pending?.operationId === operationId) pending = undefined;
				clears++;
			},
		},
		get pending() { return pending; },
		get generated() { return generated; },
		get clears() { return clears; },
	};
}

test("transport seam receives no seat targeting fields", async () => {
	let keys: string[] = [];
	const { pi } = hookHarness(async (request) => {
		keys = Object.keys(request).sort();
		return { version: 1, status: "succeeded" };
	});
	expect((await requestCodexSeatChange(pi, context, () => true)).status).toBe("succeeded");
	expect(keys).toEqual(["context", "guard", "version"]);
});

test("unsupported event versions are ignored", () => {
	const { events } = hookHarness(async () => ({ version: 1, status: "succeeded" }));
	const request: Record<string, unknown> = { version: 2, context, guard: () => true };
	events.emit(CODEX_SEAT_REQUEST_CHANNEL, request);
	expect(request.run).toBeUndefined();
});

test("one persisted operation is submitted and cleared only after signed success", async () => {
	const fake = dependencies();
	const result = await executeSeatRequestV1({ version: 1, context, guard: () => true }, fake.values);
	expect(result).toEqual({ version: 1, status: "succeeded" });
	expect(fake.generated).toBe(1);
	expect(fake.pending).toBeUndefined();
	expect(fake.clears).toBe(1);
});

test("a lost submission response retries the same operation ID", async () => {
	const seen: string[] = [];
	let calls = 0;
	const fake = dependencies({
		rotate: async () => {
			seen.push(OPERATION_ID);
			calls++;
			if (calls === 1) throw new Error("connection reset");
			return response("succeeded");
		},
	});
	const result = await executeSeatRequestV1({ version: 1, context, guard: () => true }, fake.values);
	expect(result.status).toBe("succeeded");
	expect(seen).toEqual([OPERATION_ID, OPERATION_ID]);
	expect(fake.generated).toBe(1);
});

test("an existing pending operation is resumed instead of generating another", async () => {
	const fake = dependencies({
		pending: {
			version: 1,
			operationId: OPERATION_ID,
			createdAt: 500,
			configurationId: CONFIGURATION_ID,
		},
		rotate: async () => response("running"),
		status: async () => response("succeeded"),
	});
	const result = await executeSeatRequestV1({ version: 1, context, guard: () => true }, fake.values);
	expect(result.status).toBe("succeeded");
	expect(fake.generated).toBe(0);
});

test("an uncertain terminal job preserves the operation ID", async () => {
	const fake = dependencies({
		rotate: async () => response("uncertain"),
	});
	const result = await executeSeatRequestV1({ version: 1, context, guard: () => true }, fake.values);
	expect(result.status).toBe("failed");
	expect(fake.pending?.operationId).toBe(OPERATION_ID);
	expect(fake.clears).toBe(0);
});

test("a pending operation cannot cross client configuration", async () => {
	let rotateCalls = 0;
	const fake = dependencies({
		pending: {
			version: 1,
			operationId: OPERATION_ID,
			createdAt: 500,
			configurationId: "0".repeat(64),
		},
		rotate: async () => { rotateCalls++; return response("succeeded"); },
	});
	const result = await executeSeatRequestV1({ version: 1, context, guard: () => true }, fake.values);
	expect(result.status).toBe("failed");
	expect(rotateCalls).toBe(0);
	expect(fake.pending?.operationId).toBe(OPERATION_ID);
});

test("cancellation preserves a pending operation for later status recovery", async () => {
	let allowed = true;
	const fake = dependencies({
		rotate: async () => {
			allowed = false;
			return response("running");
		},
	});
	const result = await executeSeatRequestV1({ version: 1, context, guard: () => allowed }, fake.values);
	expect(result.status).toBe("failed");
	expect(fake.pending?.operationId).toBe(OPERATION_ID);
	expect(fake.clears).toBe(0);
});

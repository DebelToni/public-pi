import assert from "node:assert/strict";
import test from "node:test";
import { installContinuationLifecycle } from "./continuation-lifecycle.ts";

function fixture() {
	const handlers = new Map<string, () => void>();
	const wait = installContinuationLifecycle({ on: (name: string, fn: () => void) => handlers.set(name, fn) } as any);
	return { wait, emit: (name: string) => handlers.get(name)?.() };
}

test("continuation waits through parent settlement and reports submission before settle", async () => {
	const f = fixture();
	const order: string[] = [];
	const run = f.wait(() => { f.emit("agent_start"); order.push("submit"); }, () => order.push("started"));
	run.then(() => order.push("settled"));
	await Promise.resolve();
	assert.deepEqual(order, ["submit", "started"]);
	f.emit("agent_settled");
	await run;
	assert.deepEqual(order, ["submit", "started", "settled"]);
});

test("continuation shutdown rejects a waiter even before the parent starts", async () => {
	const f = fixture();
	const run = f.wait(() => {});
	f.emit("session_shutdown");
	await assert.rejects(run, /shut down/);
});

test("async send and callback failures are not masked by synchronous settlement", async () => {
	for (const failSend of [true, false]) {
		const f = fixture();
		const run = f.wait(() => {
			f.emit("agent_start");
			f.emit("agent_settled");
			if (failSend) return Promise.reject(new Error("send failed"));
		}, () => { if (!failSend) throw new Error("callback failed"); });
		await assert.rejects(run, failSend ? /send failed/ : /callback failed/);
	}
});

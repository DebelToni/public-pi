import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Observe the parent only once its trigger is submitted, never while children run. */
export function installContinuationLifecycle(pi: ExtensionAPI) {
	type Waiter = { started: boolean; timer: ReturnType<typeof setTimeout>; finish(error?: Error): void };
	const waiters = new Set<Waiter>();
	pi.on("agent_start", () => {
		for (const waiter of waiters) {
			if (waiter.started) continue;
			waiter.started = true;
			clearTimeout(waiter.timer);
			waiter.timer = setTimeout(() => waiter.finish(new Error("The continued parent did not settle before timeout.")), 20 * 60_000);
		}
	});
	pi.on("agent_settled", () => {
		for (const waiter of [...waiters]) if (waiter.started) waiter.finish();
	});
	pi.on("session_shutdown", () => {
		for (const waiter of [...waiters]) waiter.finish(new Error("Session shut down during continuation."));
	});
	return async (submit: () => unknown, onStarted?: () => void) => {
		let waiter!: Waiter;
		const settled = new Promise<void>((resolve, reject) => {
			waiter = {
				started: false,
				timer: setTimeout(() => waiter.finish(new Error("The continued parent did not start.")), 5_000),
				finish(error) {
					if (!waiters.delete(waiter)) return;
					clearTimeout(waiter.timer);
					if (error) reject(error); else resolve();
				},
			};
			waiters.add(waiter);
		});
		let submitted: Promise<unknown> = Promise.resolve();
		try {
			submitted = Promise.resolve(submit());
			onStarted?.();
		} catch (error) {
			// Keep a rejected send observed even when the callback also throws.
			void submitted.catch(() => {});
			submitted = Promise.reject(error);
		}
		try {
			// Also observe async send failures after a synchronous settle event.
			await Promise.all([submitted, settled]);
		} catch (error) {
			waiter.finish(error instanceof Error ? error : new Error(String(error)));
			throw error;
		}
	};
}

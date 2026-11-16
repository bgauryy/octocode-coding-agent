import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import { shutdownSession } from "../src/core/agent-session-runtime/shutdown.ts";

/** A session whose abort waits for an idle signal that never comes (an aborted tool left the run marked active). */
function stuckSession() {
	const calls: string[] = [];
	const session = {
		abort: vi.fn(() => {
			calls.push("abort");
			return new Promise<void>(() => {});
		}),
		extensionRunner: { hasHandlers: () => false },
		sessionManager: { retire: () => calls.push("retire") },
		dispose: () => calls.push("dispose"),
	} as unknown as AgentSession;
	return { session, calls };
}

describe("shutdownSession with an abort that never settles", () => {
	afterEach(() => vi.useRealTimers());

	it("holds a timer while waiting, then finishes the release phases", async () => {
		vi.useFakeTimers();
		const { session, calls } = stuckSession();
		let done = false;
		const shutdown = shutdownSession(session, { type: "session_shutdown", reason: "quit" }).then(() => {
			done = true;
		});
		await vi.advanceTimersByTimeAsync(1_000);
		// A pending timer keeps the event loop alive: without one Node ends the process with exit 13 (unsettled await).
		expect(vi.getTimerCount()).toBeGreaterThan(0);
		expect(done).toBe(false);
		await vi.advanceTimersByTimeAsync(5_000);
		await shutdown;
		expect(calls).toEqual(["abort", "retire", "dispose"]);
		expect(vi.getTimerCount()).toBe(0);
	});
});

import { expect, it, vi } from "vitest";
import { liveSession } from "./team-live-session.ts";

it("shuts native activity down before invalidating a live session", async () => {
	const shutdown = vi.fn();
	const live = await liveSession({
		tools: [],
		extra: {
			names: [],
			register: (api) => api.on("session_shutdown", shutdown),
		},
	});
	const ctx = live.session.extensionRunner.createContext();
	vi.useFakeTimers();
	try {
		await live.session.extensionRunner.emit({ type: "agent_start" });
		// The working line counts the run in its own indicator; activity's one timer repaints it each second to say when the
		// model has gone silent, and closing the session clears it.
		expect(vi.getTimerCount()).toBe(1);
		await Promise.all([live.close(), live.close()]);
		expect(() => vi.advanceTimersByTime(2_000)).not.toThrow();
		expect(vi.getTimerCount()).toBe(0);
		expect(shutdown).toHaveBeenCalledOnce();
		expect(() => ctx.hasUI).toThrow("stale");
	} finally {
		await live.close();
		vi.clearAllTimers();
		vi.useRealTimers();
	}
});

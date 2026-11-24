import { expect, it, vi } from "vitest";
import { liveSession } from "./team-live-session.ts";

it("shuts native activity down before invalidating a live session", async () => {
	const shutdown = vi.fn();
	const live = await liveSession({
		tools: [],
		extra: {
			names: [],
			register: (api) => api.bus.on("session_shutdown", shutdown),
		},
	});
	const ctx = live.session.featureHost.createContext();
	vi.useFakeTimers();
	try {
		await live.session.featureHost.emit({ type: "agent_start" });
		// One repeating timer serves everything that ticks: the animation clock, which the working line's indicator,
		// activity's silence check and the tab title's busy mark all subscribe to. The other timer is the title painter's
		// one-shot 250 ms paint, which coalesces the light's first change. Closing clears both.
		expect(vi.getTimerCount()).toBe(2);
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

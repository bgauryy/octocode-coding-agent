import type { ApplicationEvent } from "@octocodeai/octocode-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionEvent } from "../src/core/agent-session/types.ts";
import { SessionStatusTracker } from "../src/core/application/service/lifecycle.ts";
import { acceptApplicationEvent, createApplicationState } from "../src/core/application/state.ts";

/** Feeds engine events through the tracker into a real store, as the application service does. */
function follow() {
	const store = createApplicationState("s");
	const tracker = new SessionStatusTracker();
	const published: ApplicationEvent[] = [];
	const feed = (...events: AgentSessionEvent[]) => {
		for (const event of events) {
			const status = tracker.next(event, store.getState());
			if (!status) continue;
			published.push(status);
			acceptApplicationEvent(store, status);
		}
		const { status, statusDetail, statusUntil } = store.getState();
		return {
			status,
			...(statusDetail ? { detail: statusDetail } : {}),
			...(statusUntil ? { until: statusUntil } : {}),
		};
	};
	return { feed, published };
}

const quiet = (idleMs: number): AgentSessionEvent => ({ type: "model_wait", idleMs });
const retry = (delayMs: number): AgentSessionEvent => ({
	type: "auto_retry_start",
	attempt: 1,
	maxAttempts: 3,
	delayMs,
	errorMessage: "overloaded",
});

describe("session status precedence", () => {
	afterEach(() => vi.useRealTimers());

	it("keeps compacting while the model is quiet, and returns to the quiet status when the compaction ends", () => {
		const { feed } = follow();
		expect(feed({ type: "compaction_start", reason: "threshold" })).toEqual({ status: "compacting" });
		expect(feed(quiet(25_000))).toEqual({ status: "compacting" });
		expect(
			feed({ type: "compaction_end", reason: "threshold", result: undefined, aborted: false, willRetry: false }),
		).toEqual({
			status: "stalled",
			detail: "Model not answering for 25s",
		});
		expect(feed(quiet(0))).toEqual({ status: "idle" });
	});

	it("keeps a retry that waits out its delay, and lets a quiet attempt show once the attempt is out", () => {
		vi.useFakeTimers({ now: 1_000_000 });
		const { feed } = follow();
		expect(feed(retry(30_000))).toEqual({ status: "retrying", detail: "Retry 1 of 3", until: 1_030_000 });
		expect(feed(quiet(20_000))).toEqual({ status: "retrying", detail: "Retry 1 of 3", until: 1_030_000 });
		vi.setSystemTime(1_055_000);
		expect(feed(quiet(25_000))).toEqual({ status: "stalled", detail: "Model not answering for 25s" });
		// The quiet ends: the retry it covered is still open, so the status goes back to it, not to idle.
		expect(feed(quiet(0))).toEqual({ status: "retrying", detail: "Retry 1 of 3", until: 1_030_000 });
		expect(feed({ type: "auto_retry_end", success: true, attempt: 1 })).toEqual({ status: "idle" });
	});

	it("names a request waiting out its provider's rate-limit cool-down until it goes out", () => {
		vi.useFakeTimers({ now: 1_000_000 });
		const { feed } = follow();
		const cooling: AgentSessionEvent = {
			type: "model_wait",
			idleMs: 0,
			cooldown: { provider: "anthropic", until: 1_012_000 },
		};
		expect(feed(cooling)).toEqual({
			status: "retrying",
			detail: "Waiting out anthropic rate limit",
			until: 1_012_000,
		});
		// A compaction still wins; the cool-down shows again once it ends.
		expect(feed({ type: "compaction_start", reason: "threshold" })).toEqual({ status: "compacting" });
		expect(
			feed({ type: "compaction_end", reason: "threshold", result: undefined, aborted: false, willRetry: false }),
		).toEqual({ status: "retrying", detail: "Waiting out anthropic rate limit", until: 1_012_000 });
		// The request went out: the wait is over, and a later silence reads as the model's.
		expect(feed(quiet(0))).toEqual({ status: "idle" });
		expect(feed(quiet(25_000))).toEqual({ status: "stalled", detail: "Model not answering for 25s" });
	});

	it("publishes only changes: a repeated end event says nothing", () => {
		const { feed, published } = follow();
		feed(
			{ type: "compaction_start", reason: "manual" },
			{ type: "compaction_end", reason: "manual", result: undefined, aborted: false, willRetry: false },
			{ type: "compaction_end", reason: "manual", result: undefined, aborted: false, willRetry: false },
			quiet(0),
		);
		expect(published).toEqual([
			{ type: "session.status", status: "compacting" },
			{ type: "session.status", status: "idle" },
		]);
	});
});

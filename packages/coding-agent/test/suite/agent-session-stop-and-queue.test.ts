import { fauxAssistantMessage } from "@octocodeai/octocode-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, getUserTexts, type Harness } from "./harness.ts";

function onFirst(harness: Harness, type: "auto_retry_start" | "agent_settled"): Promise<void> {
	return new Promise<void>((resolve) => {
		const unsubscribe = harness.session.subscribe((event) => {
			if (event.type !== type) return;
			unsubscribe();
			resolve();
		});
	});
}

describe("AgentSession Stop and queued input", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function harness(baseDelayMs = 0): Promise<Harness> {
		const created = await createHarness({ settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs } } });
		harnesses.push(created);
		return created;
	}

	it("a Stop while the run waits to retry ends the run and withdraws the queue: nothing more is sent", async () => {
		const h = await harness(10_000);
		h.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			fauxAssistantMessage("must not be requested"),
		]);
		const waiting = onFirst(h, "auto_retry_start");
		const running = h.session.prompt("first");
		await waiting;
		await h.session.followUp("queued while waiting");
		expect(h.session.getQueuedInputs()).toHaveLength(1);
		await h.session.abort();
		await running;
		await h.session.settled();
		expect(h.faux.state.callCount).toBe(1);
		expect(h.session.getQueuedInputs()).toEqual([]);
		expect(getUserTexts(h)).toEqual(["first"]);
		expect(h.session.lastRunOutcome?.status).toBe("aborted");
	});

	it("cancelling only the retry wait ends the run with its failure and closes the retry series", async () => {
		const h = await harness(10_000);
		h.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			fauxAssistantMessage("must not be requested"),
		]);
		const waiting = onFirst(h, "auto_retry_start");
		const running = h.session.prompt("first");
		await waiting;
		h.session.abortRetry();
		await running;
		expect(h.faux.state.callCount).toBe(1);
		expect(h.eventsOfType("auto_retry_end").map((event) => event.finalError)).toEqual(["Retry cancelled"]);
		expect(h.session.retryAttempt).toBe(0);
	});

	it("a retry series no reply closed ends with its run, so the next run's first failure starts a new series", async () => {
		const h = await harness();
		h.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			fauxAssistantMessage("recovered"),
		]);
		// Preparing the retry fails after the series started (its auto_retry_start is out).
		const boundaries = (h.session as unknown as { _c: { boundaries: { omitRecoveryAttempt(): void } } })._c.boundaries;
		const omit = boundaries.omitRecoveryAttempt.bind(boundaries);
		boundaries.omitRecoveryAttempt = () => {
			throw new Error("disk full");
		};
		await expect(h.session.prompt("first")).rejects.toThrow("disk full");
		expect(h.session.retryAttempt).toBe(0);
		expect(h.eventsOfType("auto_retry_end")).toMatchObject([{ success: false, attempt: 1, finalError: "disk full" }]);
		boundaries.omitRecoveryAttempt = omit;
		await h.session.prompt("second");
		expect(h.eventsOfType("auto_retry_start").map((event) => event.attempt)).toEqual([1, 1]);
		expect(h.faux.state.callCount).toBe(3);
	});

	it("input queued as its run settles starts a run of its own instead of waiting for the next prompt", async () => {
		const h = await harness();
		h.setResponses([fauxAssistantMessage("first reply"), fauxAssistantMessage("late reply")]);
		const settled = onFirst(h, "agent_settled");
		const running = h.session.prompt("first");
		await settled;
		// The run's last delivery point is behind it: nothing in that run delivers this.
		const late = h.session.followUp("late");
		await running;
		await expect(late).resolves.toBe("queued");
		await vi.waitFor(() => expect(h.faux.state.callCount).toBe(2));
		await h.session.settled();
		expect(getUserTexts(h)).toEqual(["first", "late"]);
		expect(h.session.getQueuedInputs()).toEqual([]);
	});

	it("a steer sent while the session is idle starts a run with it", async () => {
		const h = await harness();
		h.setResponses([fauxAssistantMessage("reply")]);
		await expect(h.session.steer("idle steer")).resolves.toBe("queued");
		await vi.waitFor(() => expect(h.faux.state.callCount).toBe(1));
		await h.session.settled();
		expect(getUserTexts(h)).toEqual(["idle steer"]);
	});
});

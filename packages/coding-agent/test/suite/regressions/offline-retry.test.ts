import { fauxAssistantMessage, type FauxResponseStep } from "@octocodeai/octocode-ai";
import { afterEach, describe, expect, it } from "vitest";
import { NETWORK_OUTAGE_MESSAGE_TYPE } from "../../../src/core/agent-session/retry.ts";
import { createHarness, getMessageText } from "../harness.ts";

const PROBE = "OCTOCODE_NETWORK_PROBE";
const offlineFailure = "fetch failed (ENOTFOUND)";

afterEach(() => {
	process.env[PROBE] = "online";
});

/** A failure that also records the network state the next retry will see. */
function failWhile(networkAfter: "online" | "offline"): FauxResponseStep {
	return () => {
		process.env[PROBE] = networkAfter;
		return fauxAssistantMessage("", { stopReason: "error", errorMessage: offlineFailure });
	};
}

describe("offline retry", () => {
	it("keeps retrying past maxRetries while offline, then tells the model how long the outage lasted", async () => {
		process.env[PROBE] = "offline";
		const harness = await createHarness({
			settings: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 1, offlineIntervalMs: 1 } },
		});
		let seenByModel: unknown[] = [];
		// The network returns during the third wait: the check before the retry fires finds it back.
		const unsubscribe = harness.session.subscribe((event) => {
			if (event.type === "auto_retry_start" && event.attempt === 3) process.env[PROBE] = "online";
		});
		try {
			harness.setResponses([
				failWhile("offline"),
				failWhile("offline"),
				failWhile("offline"),
				(context) => {
					seenByModel = context.messages;
					return fauxAssistantMessage("back online");
				},
			]);

			await harness.session.prompt("hello");

			expect(harness.faux.state.callCount).toBe(4);
			const starts = harness.eventsOfType("auto_retry_start");
			expect(starts.map((event) => event.maxAttempts)).toEqual([0, 0, 0]);
			expect(starts.every((event) => typeof event.offlineSince === "number")).toBe(true);
			const [end] = harness.eventsOfType("auto_retry_end");
			expect(end?.success).toBe(true);
			expect(typeof end?.offlineMs).toBe("number");

			const notes = seenByModel.map(getMessageText).filter((text) => text.includes("Network was unavailable"));
			expect(notes).toHaveLength(1);
			expect(notes[0]).toContain("The network is back after 3 retries");
			const stored = harness.session.messages.filter(
				(message) => message.role === "custom" && message.customType === NETWORK_OUTAGE_MESSAGE_TYPE,
			);
			expect(stored).toHaveLength(1);
			expect(stored[0]).toMatchObject({ display: false });
		} finally {
			unsubscribe();
			harness.cleanup();
		}
	});

	it("keeps the bounded retries when the network works: a host that does not resolve is not an outage", async () => {
		process.env[PROBE] = "online";
		const harness = await createHarness({
			settings: { retry: { enabled: true, maxRetries: 2, baseDelayMs: 1, offlineIntervalMs: 1 } },
		});
		try {
			harness.setResponses([failWhile("online"), failWhile("online"), failWhile("online"), failWhile("online")]);

			await harness.session.prompt("hello");

			expect(harness.faux.state.callCount).toBe(3);
			expect(harness.eventsOfType("auto_retry_start").map((event) => event.maxAttempts)).toEqual([2, 2]);
			const [end] = harness.eventsOfType("auto_retry_end");
			expect(end?.success).toBe(false);
			expect(end?.offlineMs).toBeUndefined();
			expect(
				harness.session.messages.some(
					(message) => message.role === "custom" && message.customType === NETWORK_OUTAGE_MESSAGE_TYPE,
				),
			).toBe(false);
		} finally {
			harness.cleanup();
		}
	});

	it("stops at retry.offlineMaxMs", async () => {
		process.env[PROBE] = "offline";
		const harness = await createHarness({
			settings: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 1, offlineIntervalMs: 5, offlineMaxMs: 1 } },
		});
		try {
			harness.setResponses(Array.from({ length: 6 }, () => failWhile("offline")));

			await harness.session.prompt("hello");

			const [end] = harness.eventsOfType("auto_retry_end");
			expect(end?.success).toBe(false);
			expect(harness.faux.state.callCount).toBeLessThan(6);
		} finally {
			harness.cleanup();
		}
	});
});

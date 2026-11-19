import { fauxAssistantMessage } from "@octocodeai/octocode-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getApplicationPort } from "../../src/core/application/index.ts";
import { MODEL_WAIT_AFTER_MS } from "../../src/core/agent-session/model-wait.ts";
import { createHarness, type Harness } from "./harness.ts";

describe("a stalled model request is visible to the user", () => {
	let harness: Harness | undefined;
	afterEach(() => {
		harness?.cleanup();
		harness = undefined;
		vi.useRealTimers();
	});

	it("says the model is quiet while it stalls, then names the retry, and clears when tokens arrive", async () => {
		vi.useFakeTimers();
		harness = await createHarness({ settings: { retry: { enabled: true, maxRetries: 2, baseDelayMs: 30_000 } } });
		const port = getApplicationPort(harness.session);
		const seen: Array<{ status: string; detail?: string }> = [];
		port.subscribeState((snapshot) => seen.push({ status: snapshot.status ?? "idle", detail: snapshot.statusDetail }));
		const wire: string[] = [];
		harness.session.subscribe((event) => {
			if (event.type === "model_wait") wire.push(`wait:${event.idleMs > 0 ? "on" : "off"}`);
		});

		let timeOut!: () => void;
		let answer!: () => void;
		harness.setResponses([
			() =>
				new Promise((resolve) => {
					timeOut = () =>
						resolve(
							fauxAssistantMessage("", { stopReason: "error", errorMessage: "Request timed out after 300000ms" }),
						);
				}),
			() =>
				new Promise((resolve) => {
					answer = () => resolve(fauxAssistantMessage("hello"));
				}),
		]);

		const run = harness.session.prompt("hi");
		await vi.advanceTimersByTimeAsync(MODEL_WAIT_AFTER_MS - 1000);
		expect(seen.some((s) => s.status === "stalled")).toBe(false);

		await vi.advanceTimersByTimeAsync(1000 + 10_000);
		const stalled = seen.filter((s) => s.status === "stalled");
		expect(stalled.at(-1)?.detail).toMatch(/^Model not answering for (2\ds|3\ds)$/);
		expect(getApplicationPort(harness.session).getSnapshot().status).toBe("stalled");

		timeOut();
		await vi.advanceTimersByTimeAsync(1);
		expect(seen.at(-1)).toMatchObject({ status: "retrying", detail: "Retry 1 of 2 in 30s" });

		await vi.advanceTimersByTimeAsync(30_000);
		await vi.advanceTimersByTimeAsync(MODEL_WAIT_AFTER_MS + 1000);
		expect(getApplicationPort(harness.session).getSnapshot().status).toBe("stalled");

		answer();
		await vi.advanceTimersByTimeAsync(1);
		await run;
		expect(getApplicationPort(harness.session).getSnapshot().status).toBe("idle");
		expect(wire.at(-1)).toBe("wait:off");
		expect(harness.session.messages.at(-1)?.role).toBe("assistant");
	});

	it("clears when the request ends without tokens", async () => {
		vi.useFakeTimers();
		harness = await createHarness({ settings: { retry: { enabled: false } } });
		let fail!: () => void;
		harness.setResponses([
			() =>
				new Promise((resolve) => {
					fail = () => resolve(fauxAssistantMessage("", { stopReason: "error", errorMessage: "Request timed out" }));
				}),
		]);
		const run = harness.session.prompt("hi");
		await vi.advanceTimersByTimeAsync(MODEL_WAIT_AFTER_MS + 1000);
		expect(getApplicationPort(harness.session).getSnapshot().status).toBe("stalled");
		fail();
		await vi.advanceTimersByTimeAsync(1);
		await run;
		expect(getApplicationPort(harness.session).getSnapshot().status).toBe("idle");
	});
});

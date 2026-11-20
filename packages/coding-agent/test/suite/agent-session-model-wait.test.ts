import { fauxAssistantMessage } from "@octocodeai/octocode-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getApplicationPort } from "../../src/core/application/index.ts";
import { MODEL_WAIT_AFTER_MS } from "../../src/core/agent-session/model-wait.ts";
import { testFeatures } from "../helpers/features.ts";
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
		const seen: Array<{ status: string; detail?: string; until?: number }> = [];
		port.subscribeState((snapshot) =>
			seen.push({ status: snapshot.status ?? "idle", detail: snapshot.statusDetail, until: snapshot.statusUntil }),
		);
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
		// The retry names itself and says when its attempt starts, so a client counts down instead of showing a fixed delay.
		expect(seen.at(-1)).toMatchObject({ status: "retrying", detail: "Retry 1 of 2", until: Date.now() + 30_000 - 1 });

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

	it("counts no silence while a compaction prepares the request, and counts from when the request goes out", async () => {
		vi.useFakeTimers();
		let release!: () => void;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 1_200, maxTokens: 100 }],
			compactionPolicy: { enabled: true, keepRecentTokens: 1, reserveTokens: 0 },
			builtinCompactionFactories: [
				(api) => {
					api.bus.on("session_before_compact", async ({ preparation: { firstKeptEntryId, tokensBefore } }) => {
						await held;
						return { compaction: { summary: "older history summary", firstKeptEntryId, tokensBefore } };
					});
				},
			],
		});
		// The history already exceeds the window, so the first request compacts inside its preparation.
		harness.sessionManager.appendMessage({ role: "user", content: "y".repeat(8000), timestamp: Date.now() - 1 });
		harness.session.refreshContext();
		const port = getApplicationPort(harness.session);
		const statuses: string[] = [];
		port.subscribeState((snapshot) => {
			const status = snapshot.statusDetail
				? `${snapshot.status}: ${snapshot.statusDetail}`
				: (snapshot.status ?? "idle");
			if (statuses.at(-1) !== status) statuses.push(status);
		});
		let answer!: () => void;
		harness.setResponses([
			() =>
				new Promise((resolve) => {
					answer = () => resolve(fauxAssistantMessage("hello"));
				}),
		]);

		const run = harness.session.prompt("hi");
		await vi.advanceTimersByTimeAsync(MODEL_WAIT_AFTER_MS + 5000);
		expect(port.getSnapshot().status).toBe("compacting");
		expect(harness.eventsOfType("model_wait")).toEqual([]);

		release();
		await vi.advanceTimersByTimeAsync(MODEL_WAIT_AFTER_MS - 1000);
		expect(harness.eventsOfType("compaction_end")).toHaveLength(1);
		expect(port.getSnapshot().status).toBe("idle");
		await vi.advanceTimersByTimeAsync(2000);
		expect(port.getSnapshot().statusDetail).toBe("Model not answering for 20s");

		answer();
		await vi.advanceTimersByTimeAsync(1);
		await run;
		expect(statuses.filter((status) => status !== "idle")).toEqual([
			"compacting",
			"stalled: Model not answering for 20s",
		]);
		expect(statuses.at(-1)).toBe("idle");
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

	it("tells features once per quiet request, not on each refresh, and never for a request that answers in time", async () => {
		vi.useFakeTimers();
		const stalls: number[] = [];
		harness = await createHarness({
			settings: { retry: { enabled: true, maxRetries: 2, baseDelayMs: 1000 } },
			features: testFeatures([
				(api) => {
					api.bus.on("model_stall", async (event) => void stalls.push(event.idleMs));
				},
			]),
		});
		let timeOut!: () => void;
		let answer!: () => void;
		harness.setResponses([
			() =>
				new Promise((resolve) => {
					timeOut = () => resolve(fauxAssistantMessage("", { stopReason: "error", errorMessage: "Request timed out" }));
				}),
			() =>
				new Promise((resolve) => {
					answer = () => resolve(fauxAssistantMessage("hello"));
				}),
			() => fauxAssistantMessage("quick"),
		]);
		const run = harness.session.prompt("hi");
		// The status refreshes every few seconds while the first request is quiet; features hear of it once.
		await vi.advanceTimersByTimeAsync(MODEL_WAIT_AFTER_MS + 30_000);
		expect(harness.eventsOfType("model_wait").length).toBeGreaterThan(3);
		expect(stalls).toHaveLength(1);
		expect(stalls[0]).toBeGreaterThanOrEqual(MODEL_WAIT_AFTER_MS);
		// The retry is a new request: its own silence is news again.
		timeOut();
		await vi.advanceTimersByTimeAsync(1000 + MODEL_WAIT_AFTER_MS + 1000);
		expect(stalls).toHaveLength(2);
		answer();
		await vi.advanceTimersByTimeAsync(1);
		await run;
		await harness.session.prompt("again");
		await vi.advanceTimersByTimeAsync(MODEL_WAIT_AFTER_MS + 1000);
		expect(stalls).toHaveLength(2);
	});
});

import type { StreamFn } from "@octocodeai/octocode-agent-core";
import {
	type AssistantMessage,
	type AssistantMessageEventStream,
	createAssistantMessageEventStream,
	fauxAssistantMessage,
} from "@octocodeai/octocode-ai";
import { afterEach, describe, expect, it } from "vitest";
import { summaryStallMessage } from "../../../src/core/compaction/index.ts";
import { createHarness, type Harness } from "../harness.ts";

/**
 * A compaction summary once streamed for more than ten minutes with only a spinner on screen. The session now reports
 * the summary's progress (`compaction_progress`, at most once a second) and ends an attempt that receives nothing for
 * the HTTP idle window as a retryable timeout; a stream that keeps producing is never ended.
 */
describe("compaction summary progress and liveness", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	const usage = {
		input: 10,
		output: 10,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 20,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};

	async function compactableHarness(idleMs: number): Promise<Harness> {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);
		const policy = harness.settingsManager.getCompactionSettings();
		harness.settingsManager.getCompactionSettings = () => ({ ...policy, keepRecentTokens: 1 });
		harness.settingsManager.applyOverrides({
			retry: { enabled: true, maxRetries: 2, baseDelayMs: 0 },
			httpIdleTimeoutMs: idleMs,
		});
		const now = Date.now();
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "message to compact" }],
			timestamp: now - 1000,
		});
		const model = harness.getModel();
		harness.sessionManager.appendMessage({
			...fauxAssistantMessage("assistant response to compact", { timestamp: now - 500 }),
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage,
		});
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
		return harness;
	}

	/** A summary written `chunk` by `chunk`, one every `everyMs`. */
	function writing(model: Parameters<StreamFn>[0], chunks: string[], everyMs: number): AssistantMessageEventStream {
		const stream = createAssistantMessageEventStream();
		const base = { ...fauxAssistantMessage(""), api: model.api, provider: model.provider, model: model.id, usage };
		const partial = (text: string): AssistantMessage => ({ ...base, content: [{ type: "text", text }] });
		let text = "";
		let sent = 0;
		const timer = setInterval(() => {
			if (sent < chunks.length) {
				text += chunks[sent++];
				stream.push({ type: "text_delta", contentIndex: 0, delta: chunks[sent - 1], partial: partial(text) });
				return;
			}
			clearInterval(timer);
			stream.push({ type: "done", reason: "stop", message: partial(text) });
		}, everyMs);
		return stream;
	}

	it("reports progress while a slow summary keeps producing, and never ends it", async () => {
		const harness = await compactableHarness(1_000);
		let calls = 0;
		harness.session.agent.streamFunction = (model) => {
			calls++;
			// A chunk every 300 ms for about 2.7 seconds: slower than a second in total, never silent for one.
			return writing(model, ["## Goal\n", ...Array.from({ length: 8 }, (_, i) => `step ${i}. `)], 300);
		};

		const result = await harness.session.compact();

		expect(calls).toBe(1);
		expect(result.summary).toContain("step 7.");
		expect(harness.eventsOfType("summarization_retry_scheduled")).toHaveLength(0);
		const progress = harness.eventsOfType("compaction_progress");
		expect(progress.length).toBeGreaterThanOrEqual(2);
		expect(progress[0]).toMatchObject({ reason: "manual" });
		const elapsed = progress.map((event) => event.elapsedMs);
		for (let i = 1; i < elapsed.length; i++) expect(elapsed[i] - elapsed[i - 1]).toBeGreaterThanOrEqual(900);
		const received = progress.map((event) => event.receivedChars);
		expect(received.at(-1)).toBeGreaterThan(received[0]);
	});

	it("retries an attempt that stays silent past the HTTP idle window", async () => {
		const harness = await compactableHarness(1_000);
		let calls = 0;
		let firstSignal: AbortSignal | undefined;
		harness.session.agent.streamFunction = (model, _context, options) => {
			calls++;
			if (calls > 1) return writing(model, ["## Goal\n", "recovered"], 10);
			firstSignal = options?.signal;
			return createAssistantMessageEventStream();
		};

		const result = await harness.session.compact();

		expect(calls).toBe(2);
		expect(firstSignal?.aborted).toBe(true);
		expect(result.summary).toContain("recovered");
		const scheduled = harness.eventsOfType("summarization_retry_scheduled");
		expect(scheduled).toHaveLength(1);
		expect(scheduled[0]).toMatchObject({ errorMessage: summaryStallMessage(1_000) });
	});
});

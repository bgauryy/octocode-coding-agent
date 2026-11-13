import {
	type AssistantMessage,
	type AssistantMessageEventStream,
	createAssistantMessageEventStream,
	isRetryableAssistantError,
	type Model,
	normalizeContext,
} from "@octocodeai/octocode-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	completeSummarization,
	type SummaryProgress,
	summaryStallMessage,
	summaryStreamWatcher,
} from "../src/core/compaction/index.ts";

const model = {
	id: "m",
	name: "m",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://example.test",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 64_000,
} as Model<"anthropic-messages">;

const usage = {
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function message(text: string, overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage,
		stopReason: "stop",
		timestamp: Date.now(),
		...overrides,
	};
}

/** A stream that writes `chunks` one every `everyMs`, then ends; aborting it ends it as a provider does. */
function slowStream(chunks: string[], everyMs: number, signal?: AbortSignal): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	let text = "";
	let sent = 0;
	const timer = setInterval(() => {
		if (sent < chunks.length) {
			text += chunks[sent];
			stream.push({ type: "text_delta", contentIndex: 0, delta: chunks[sent], partial: message(text) });
			sent++;
			return;
		}
		clearInterval(timer);
		stream.push({ type: "done", reason: "stop", message: message(text) });
	}, everyMs);
	signal?.addEventListener("abort", () => {
		clearInterval(timer);
		stream.push({ type: "error", reason: "aborted", error: message(text, { stopReason: "aborted" }) });
	});
	return stream;
}

/** A stream that sends nothing until it is aborted. */
function silentStream(signal?: AbortSignal): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	signal?.addEventListener("abort", () =>
		stream.push({ type: "error", reason: "aborted", error: message("", { stopReason: "aborted" }) }),
	);
	return stream;
}

const context = normalizeContext({ systemPrompt: "Summarize", messages: [] });

describe("summary stream watcher", () => {
	beforeEach(() => {
		vi.useFakeTimers({ now: 1_000_000 });
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("reports elapsed time and received characters at most once a second while a long summary streams", async () => {
		const progress: SummaryProgress[] = [];
		const watch = summaryStreamWatcher({ idleMs: 60_000, onProgress: (update) => progress.push(update) });
		// Ten characters every 100 ms for 5 seconds.
		const chunks = Array.from({ length: 50 }, () => "0123456789");
		const stream = await watch((_model, _context, options) => slowStream(chunks, 100, options?.signal))(model, context);
		const result = stream.result();
		await vi.advanceTimersByTimeAsync(5_200);
		const done = await result;

		expect(done.stopReason).toBe("stop");
		expect(done.content).toEqual([{ type: "text", text: chunks.join("") }]);
		// One report per second, never more: elapsed grows by a second each time and the count only grows.
		expect(progress.map((update) => update.elapsedMs)).toEqual([1_000, 2_000, 3_000, 4_000, 5_000]);
		const counts = progress.map((update) => update.receivedChars);
		expect(counts).toEqual([...counts].sort((a, b) => a - b));
		expect(counts[0]).toBeGreaterThan(0);
		expect(counts.at(-1)).toBeLessThanOrEqual(500);
		// The stream ended: no report after it.
		await vi.advanceTimersByTimeAsync(3_000);
		expect(progress).toHaveLength(5);
	});

	it("never ends a slow stream that keeps producing, however long it runs", async () => {
		const watch = summaryStreamWatcher({ idleMs: 1_000 });
		// A chunk every 900 ms for about 27 seconds: always inside the 1-second liveness window.
		const chunks = Array.from({ length: 30 }, (_, index) => `part ${index} `);
		const stream = await watch((_model, _context, options) => slowStream(chunks, 900, options?.signal))(model, context);
		const result = stream.result();
		await vi.advanceTimersByTimeAsync(30_000);
		const done = await result;
		expect(done.stopReason).toBe("stop");
		expect(done.content).toEqual([{ type: "text", text: chunks.join("") }]);
	});

	it("ends an attempt that receives nothing for the liveness window as a retryable timeout", async () => {
		const watch = summaryStreamWatcher({ idleMs: 5_000 });
		let innerSignal: AbortSignal | undefined;
		const stream = await watch((_model, _context, options) => {
			innerSignal = options?.signal;
			return silentStream(options?.signal);
		})(model, context);
		const result = stream.result();
		await vi.advanceTimersByTimeAsync(4_000);
		expect(innerSignal?.aborted).toBe(false);
		await vi.advanceTimersByTimeAsync(1_500);
		const failed = await result;

		expect(failed.stopReason).toBe("error");
		expect(failed.errorMessage).toBe(summaryStallMessage(5_000));
		expect(isRetryableAssistantError(failed)).toBe(true);
		// The provider request is cancelled, not left running.
		expect(innerSignal?.aborted).toBe(true);
	});

	it("retries a silent attempt by the retry policy, and the next attempt's summary stands", async () => {
		const watch = summaryStreamWatcher({ idleMs: 2_000 });
		let calls = 0;
		const send = watch((_model, _context, options) => {
			calls++;
			return calls === 1 ? silentStream(options?.signal) : slowStream(["## Goal\n", "done"], 100, options?.signal);
		});
		const scheduled: string[] = [];
		const pending = completeSummarization(
			model,
			context,
			{},
			send,
			{ enabled: true, maxRetries: 2, baseDelayMs: 10 },
			{ onRetryScheduled: (_attempt, _max, _delay, error) => void scheduled.push(error) },
		);
		await vi.advanceTimersByTimeAsync(10_000);
		const response = await pending;

		expect(calls).toBe(2);
		expect(scheduled).toEqual([summaryStallMessage(2_000)]);
		expect(response.stopReason).toBe("stop");
		expect(response.content).toEqual([{ type: "text", text: "## Goal\ndone" }]);
	});

	it("passes the caller's cancel through and never reports a cancel as a timeout", async () => {
		const watch = summaryStreamWatcher({ idleMs: 5_000 });
		const controller = new AbortController();
		const stream = await watch((_model, _context, options) => silentStream(options?.signal))(model, context, {
			signal: controller.signal,
		});
		const result = stream.result();
		await vi.advanceTimersByTimeAsync(1_000);
		controller.abort();
		await vi.advanceTimersByTimeAsync(10_000);
		const cancelled = await result;
		expect(cancelled.stopReason).toBe("aborted");
		expect(cancelled.errorMessage).toBeUndefined();
	});

	it("does not end attempts when the liveness window is disabled", async () => {
		const watch = summaryStreamWatcher({ idleMs: 0 });
		const stream = await watch((_model, _context, options) => slowStream(["a"], 60_000, options?.signal))(
			model,
			context,
		);
		const result = stream.result();
		await vi.advanceTimersByTimeAsync(130_000);
		expect((await result).stopReason).toBe("stop");
	});
});

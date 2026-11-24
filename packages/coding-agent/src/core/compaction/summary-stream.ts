/**
 * How a compaction's summary requests are watched while they stream: progress for the status line, and an attempt that
 * receives nothing for the liveness window ends as a retryable timeout. A stream that keeps producing is never ended,
 * however long it runs; the output cap (`summaryMaxTokens`) is what bounds its length.
 */

import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEvent,
	type AssistantMessageEventStream,
	createAssistantMessageEventStream,
	type Model,
	type RetryCallbacks,
	type RetryPolicy,
	type SimpleStreamOptions,
} from "@octocodeai/octocode-ai";
import { sharedClock } from "@octocodeai/octocode-common/clock";
import { formatDuration } from "../../utils/duration.ts";

/** What a compaction's summary requests have done so far. */
export interface SummaryProgress {
	/** Since the first summary request of the compaction started. */
	elapsedMs: number;
	/** Characters of text, thinking and tool-call input received over all its requests. */
	receivedChars: number;
}

/** Starts one streamed request; `C` is the context type its caller sends (a stream function's or the model registry's). */
type SummaryStream<C> = (
	model: Model<Api>,
	context: C,
	options?: SimpleStreamOptions,
) => AssistantMessageEventStream | Promise<AssistantMessageEventStream>;

/** How the session sends a compaction's summary requests; a feature that writes the summary itself uses it too. */
export interface SummaryRequestPolicy {
	/** The run's transient system override for cache-sharing requests; absent for the recorded instruction projection. */
	forceSystemPrompt?: string;
	/** Wraps a stream function so its requests report progress and a silent attempt ends as a retryable timeout. */
	watch<C>(stream: SummaryStream<C>): SummaryStream<C>;
	/** The session's `retry` settings. */
	retry: RetryPolicy;
	/** Shows each retry the way the session shows a summary retry. */
	callbacks: RetryCallbacks;
}

export interface SummaryWatchOptions {
	/** Silence after which an attempt ends as a retryable timeout; 0 or less never ends one. */
	idleMs: number;
	/** Called at most once per `tickMs` while a request streams. */
	onProgress?: (progress: SummaryProgress) => void;
	/** How often progress is reported and silence checked; one second by default. */
	tickMs?: number;
}

const DEFAULT_TICK_MS = 1_000;

/** Characters an event adds to what was received. */
function receivedChars(event: AssistantMessageEvent): number {
	return event.type === "text_delta" || event.type === "thinking_delta" || event.type === "toolcall_delta"
		? event.delta.length
		: 0;
}

/** The text a silent attempt ends with; `timed out` makes the retry policy treat it as transient. */
export function summaryStallMessage(idleMs: number): string {
	return `The summary request timed out: nothing arrived for ${formatDuration(idleMs)}`;
}

/** The failed message a silent attempt ends with, built on what it had received. */
function stalledMessage(partial: AssistantMessage | undefined, model: Model<Api>, idleMs: number): AssistantMessage {
	return {
		role: "assistant",
		content: partial?.content ?? [],
		api: partial?.api ?? model.api,
		provider: partial?.provider ?? model.provider,
		model: partial?.model ?? model.id,
		usage: partial?.usage ?? {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		errorMessage: summaryStallMessage(idleMs),
		timestamp: partial?.timestamp ?? Date.now(),
	};
}

/**
 * A wrapper for the stream functions of one compaction: progress adds up over all the requests it wraps, from the
 * moment the wrapper is made. Each request gets its own abort signal, linked to the caller's, so ending a silent
 * attempt never cancels the compaction; the retry policy then decides whether another attempt runs.
 */
export function summaryStreamWatcher(options: SummaryWatchOptions): SummaryRequestPolicy["watch"] {
	const startedAt = Date.now();
	const tickMs = options.tickMs ?? DEFAULT_TICK_MS;
	let total = 0;
	return <C>(stream: SummaryStream<C>): SummaryStream<C> =>
		async (model, context, requestOptions) => {
			const attempt = new AbortController();
			const outer = requestOptions?.signal;
			const relay = () => attempt.abort(outer?.reason);
			if (outer?.aborted) relay();
			else outer?.addEventListener("abort", relay, { once: true });
			let source: AssistantMessageEventStream;
			try {
				source = await stream(model, context, { ...requestOptions, signal: attempt.signal });
			} catch (error) {
				outer?.removeEventListener("abort", relay);
				throw error;
			}
			const watched = createAssistantMessageEventStream();
			let lastEventAt = Date.now();
			let partial: AssistantMessage | undefined;
			let ended = false;
			const finish = (message?: AssistantMessage) => {
				if (ended) return;
				ended = true;
				stopTimer();
				outer?.removeEventListener("abort", relay);
				watched.end(message);
			};
			const stopTimer = sharedClock.subscribe(
				(now) => {
					if (options.idleMs > 0 && now - lastEventAt >= options.idleMs) {
						const error = stalledMessage(partial, model, options.idleMs);
						watched.push({ type: "error", reason: "error", error });
						finish(error);
						attempt.abort(new Error(error.errorMessage));
						return;
					}
					options.onProgress?.({ elapsedMs: now - startedAt, receivedChars: total });
				},
				{ everyMs: tickMs },
			);
			void (async () => {
				try {
					for await (const event of source) {
						if (ended) break;
						lastEventAt = Date.now();
						total += receivedChars(event);
						if ("partial" in event) partial = event.partial;
						watched.push(event);
					}
				} catch {
					// A source that cannot be read event by event still has its result, forwarded below.
				} finally {
					// A provider may finish with `end(result)` and no terminal event: forward that result too.
					if (!ended) void source.result().then(finish, () => finish());
				}
			})();
			return watched;
		};
}

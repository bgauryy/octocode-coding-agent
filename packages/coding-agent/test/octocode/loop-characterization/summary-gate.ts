import {
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	type TranscriptContext,
} from "@octocodeai/octocode-ai";
import type { AgentSession } from "../../../src/core/agent-session.ts";
import { getMessageText } from "../../suite/harness.ts";

/**
 * Holds the summary request of a compaction until the test lets it end, so a test can send events while it runs. Ordinary
 * turns still reach the scripted model. Once released or failed, later summary requests end the same way at once; an abort
 * of the request ends it as the summarizer would (a cancelled compaction).
 */
export interface SummaryGate {
	/** Resolves once a summary request is in flight. */
	started: Promise<void>;
	/** How many summary requests began. */
	requests(): number;
	/** The summary request ends with `summary`. */
	release(summary?: string): void;
	/** The summary request fails. */
	fail(message: string): void;
}

type Outcome = { summary: string } | { error: string; aborted?: boolean };

const usage = {
	input: 10,
	output: 10,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 20,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function isSummaryRequest(context: TranscriptContext): boolean {
	return context.messages.some((message) => {
		const text = getMessageText(message);
		return text.startsWith("<conversation>") || text.startsWith("# Conversation\n");
	});
}

export function gateSummary(session: Pick<AgentSession, "agent">): SummaryGate {
	const agent = session.agent;
	const original = agent.streamFunction;
	let markStarted = () => {};
	const started = new Promise<void>((resolve) => (markStarted = resolve));
	const waiting: Array<(outcome: Outcome) => void> = [];
	let outcome: Outcome | undefined;
	let requests = 0;
	agent.streamFunction = (model, context, options) => {
		if (!isSummaryRequest(context)) return original(model, context, options);
		requests++;
		const stream = createAssistantMessageEventStream();
		const finish = (result: Outcome) => {
			const base = { api: model.api, provider: model.provider, model: model.id, usage };
			if ("error" in result) {
				const aborted = result.aborted === true;
				stream.push({
					type: "error",
					reason: aborted ? "aborted" : "error",
					error: {
						...fauxAssistantMessage("", { stopReason: aborted ? "aborted" : "error", errorMessage: result.error }),
						...base,
					},
				});
			} else {
				stream.push({ type: "done", reason: "stop", message: { ...fauxAssistantMessage(result.summary), ...base } });
			}
		};
		options?.signal?.addEventListener("abort", () => finish({ error: "aborted", aborted: true }), { once: true });
		if (outcome) {
			const settled = outcome;
			queueMicrotask(() => finish(settled));
		} else waiting.push(finish);
		markStarted();
		return stream;
	};
	const settle = (result: Outcome) => {
		outcome = result;
		for (const finish of waiting.splice(0)) finish(result);
	};
	return {
		started,
		requests: () => requests,
		release: (summary = "SUMMARY") => settle({ summary }),
		fail: (message) => settle({ error: message }),
	};
}

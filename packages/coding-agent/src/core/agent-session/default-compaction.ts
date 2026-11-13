/** Octocode's default compaction summary: the one the session writes when no extension supplies one. */

import type { ThinkingLevel } from "@octocodeai/octocode-agent-core";
import { type Model, type RetryCallbacks, streamSimple } from "@octocodeai/octocode-ai/compat";
import {
	type CompactionPreparation,
	type CompactionResult,
	compact,
	type SummaryRequestPolicy,
} from "../compaction/index.ts";
import type { CompactionReason } from "../session-compaction.ts";
import { createSessionUsageRecorder } from "../usage-totals.ts";
import type { SessionPublic } from "./host.ts";
import type { RequestAuth } from "./request-auth.ts";
import type { AgentSessionEvent } from "./types.ts";

/** What Octocode's default compaction summary needs; the session passes itself or a test double. */
export interface DefaultCompactionHost {
	readonly session: Pick<SessionPublic, "sessionManager" | "settingsManager" | "agent">;
	emit(event: AgentSessionEvent): void;
	getSummarizationRequestAuth(
		model: Model<any>,
		signal?: AbortSignal,
	): Promise<RequestAuth & { thinkingLevel: ThinkingLevel }>;
	summarizationRetryCallbacks(source: { source: "compaction"; reason: CompactionReason }): RetryCallbacks;
}

/** Generate Octocode's built-in compaction summary for manual and automatic compaction. */
export async function runDefaultCompaction(
	host: DefaultCompactionHost,
	preparation: CompactionPreparation,
	model: Model<any>,
	signal: AbortSignal,
	reason: CompactionReason,
	customInstructions?: string,
	summaryRequest?: SummaryRequestPolicy,
): Promise<CompactionResult> {
	const { session } = host;
	// Resolve the request only when Octocode summarizes itself: routing may call models or fail.
	const record = createSessionUsageRecorder(session.sessionManager, "compaction_attempt", (entry) =>
		host.emit({ type: "entry_appended", entry }),
	);
	const request = await host.getSummarizationRequestAuth(model, signal);
	const sessionStream = session.agent.streamFunction ?? streamSimple;
	// Watched inside the usage record, so a silent attempt that was ended still has its usage recorded.
	const streamFn = summaryRequest ? summaryRequest.watch(sessionStream) : sessionStream;
	const result = await compact(
		preparation,
		request.model,
		request.apiKey,
		request.headers,
		customInstructions,
		signal,
		request.thinkingLevel,
		async (model, context, options) => {
			const stream = await streamFn(model, context, options);
			const result = stream.result.bind(stream);
			stream.result = async () => {
				const message = await result();
				record(message);
				return message;
			};
			return stream;
		},
		request.env,
		summaryRequest?.retry ?? session.settingsManager.getRetrySettings(),
		summaryRequest?.callbacks ?? host.summarizationRetryCallbacks({ source: "compaction", reason }),
		undefined, // sessionId
	);
	return { ...result, usage: undefined };
}

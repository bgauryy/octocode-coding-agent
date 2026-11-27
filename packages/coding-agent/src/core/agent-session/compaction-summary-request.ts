import { type SummaryRequestPolicy, summaryStreamWatcher } from "../compaction/index.ts";
import type { CompactionReason } from "../session-compaction.ts";
import type { SessionInternals } from "./host.ts";
import { summarizationRetryCallbacks } from "./retry.ts";

/**
 * How one compaction's summary requests are sent: progress on the status line (`compaction_progress`, at most once a
 * second), an attempt that receives nothing for the HTTP idle window (`httpIdleTimeoutMs`) ended as a retryable
 * timeout, and the session's retry policy.
 */
export function summaryRequestPolicy(
	host: Pick<SessionInternals, "session" | "emit"> & { forcedSystemPrompt(): string | undefined },
	reason: CompactionReason,
): SummaryRequestPolicy {
	const { settingsManager } = host.session;
	const emit = host.emit.bind(host);
	return {
		forceSystemPrompt: host.forcedSystemPrompt(),
		watch: summaryStreamWatcher({
			idleMs: settingsManager.getHttpIdleTimeoutMs(),
			onProgress: (progress) => emit({ type: "compaction_progress", reason, ...progress }),
		}),
		retry: settingsManager.getRetrySettings(),
		callbacks: summarizationRetryCallbacks(emit, { source: "compaction", reason }),
	};
}

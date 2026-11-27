import { isRecord } from "@octocodeai/octocode-contracts/guards";

export const CONTEXT_NOTICE_TYPE = "octocode-context-usage";
export const RUNNING_WORK_TYPE = "octocode-running-work";

/** Whether a generated state notice belongs to an earlier compaction. Unknown legacy provenance stays visible. */
export function supersededNotice(message: unknown, compactionId: string | undefined): boolean {
	if (!compactionId || !isRecord(message) || message.role !== "custom") return false;
	if (message.customType !== CONTEXT_NOTICE_TYPE && message.customType !== RUNNING_WORK_TYPE) return false;
	if (!isRecord(message.details)) return false;
	const previous = message.details.compactionId;
	return (previous === null || typeof previous === "string") && previous !== compactionId;
}

/** Prune only across a new compaction boundary; appending notices within one generation never rewrites its prefix. */
export function withoutSupersededNotices<T>(messages: T[], compactionId: string | undefined): T[] {
	if (!compactionId) return messages;
	const kept = messages.filter((message) => !supersededNotice(message, compactionId));
	return kept.length === messages.length ? messages : kept;
}

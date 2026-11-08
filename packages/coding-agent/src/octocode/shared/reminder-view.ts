import { isRecord } from "@octocodeai/octocode-contracts/guards";

/** The custom type of the hidden message that repeats a child's identity after a compaction (`subagents/identity-reminder.ts`). */
export const IDENTITY_REMINDER_TYPE = "octocode-subagent-identity-reminder";

function isReminder(message: unknown): boolean {
	return isRecord(message) && message.role === "custom" && message.customType === IDENTITY_REMINDER_TYPE;
}

/**
 * The messages a request shows: only the latest identity reminder, so an earlier (possibly replaced) assignment is not
 * read again. Returns `messages` itself when nothing is dropped. The child's `context` handler applies it to every live
 * request, and the cache-sharing summary request applies it too, so both send the same prefix.
 */
export function latestReminderOnly<T>(messages: T[]): T[] {
	const latest = messages.findLastIndex(isReminder);
	if (latest < 0) return messages;
	const kept = messages.filter((message, at) => at === latest || !isReminder(message));
	return kept.length === messages.length ? messages : kept;
}

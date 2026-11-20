/**
 * The channel (`api.channels`) on which a feature announces a notice worth a user's script: the hooks domain runs the
 * `Notification` hooks for each one, with `type` as `notification_type`. Publishers stay rare (one per outcome, never per
 * turn); neither side imports the other.
 */
export const USER_NOTICE_CHANNEL = "octocode:user-notice";

/**
 * The Octocode notification types, beside Claude Code's own (`idle_prompt`, `permission_prompt`, `elicitation_dialog`):
 * - `compaction_lifted`: a compaction dropped standing rules or decisions the summaries carried;
 * - `memory_update`: a memory pass changed a memory file;
 * - `model_stalled`: the model request has been quiet long enough to tell the user;
 * - `spend_limit`: a `subagents` limit (`maxCost`, `maxChildren`) refused a new subagent.
 */
type UserNoticeType = "compaction_lifted" | "memory_update" | "model_stalled" | "spend_limit";

export interface UserNotice {
	type: UserNoticeType;
	title: string;
	message: string;
}

/** Announces `notice`; nothing listens while hooks are off. */
export function publishUserNotice(channels: { emit(channel: string, data: unknown): void }, notice: UserNotice): void {
	channels.emit(USER_NOTICE_CHANNEL, notice);
}

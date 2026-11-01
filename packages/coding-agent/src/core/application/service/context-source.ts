import type { ApplicationSession } from "../session-port.ts";
import type { ApplicationTranscript } from "../transcript.ts";

type Source = Pick<ApplicationSession, "messages" | "sessionManager">;

function branchIds(session: Source): string[] {
	return (session.sessionManager?.getBranch() ?? []).map((entry) => entry.id);
}

/**
 * The session messages and branch the projection was built from. A turn boundary rebuilds the context array from the
 * session file after every turn; that is a refresh, not a change, when the branch only grew and every message is the
 * same or equal. Anything else (navigation, an edit, compaction) needs a full rebuild.
 */
export class ContextSource {
	private messages: readonly unknown[] = [];
	private branch: readonly string[] = [];

	reset(session: Source): void {
		this.messages = session.messages;
		this.branch = branchIds(session);
	}

	clear(): void {
		this.messages = [];
		this.branch = [];
	}

	/** Whether the projection still matches `session`; an equal rebuilt array is adopted in place. */
	unchanged(session: Source, transcript: ApplicationTranscript): boolean {
		if (this.messages === session.messages) return true;
		const branch = branchIds(session);
		const grew = branch.length >= this.branch.length && this.branch.every((id, index) => branch[index] === id);
		if (!grew || !transcript.adopt(this.messages, session.messages)) return false;
		this.messages = session.messages;
		this.branch = branch;
		return true;
	}
}

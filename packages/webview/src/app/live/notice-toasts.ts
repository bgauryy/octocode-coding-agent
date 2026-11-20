import {
	applicationNotice,
	type ApplicationNoticeLevel,
	type ApplicationSnapshot,
} from "@octocodeai/octocode-contracts";

/** One notice to show as a toast. */
export interface NoticeToast {
	id: string;
	text: string;
	level: ApplicationNoticeLevel;
}

/**
 * Picks the notice to toast from successive snapshots: the newest live notice activity (`APPLICATION_NOTICE_KIND`)
 * that arrived after the session was first seen. What a snapshot already held when the page opened, after a reconnect,
 * or after a switch to another session, is history and stays quiet; each notice is toasted at most once.
 */
export class NoticeToasts {
	private sessionId: string | undefined;
	private seen = new Set<string>();

	next(snapshot: ApplicationSnapshot | undefined): NoticeToast | undefined {
		if (!snapshot) return undefined;
		const first = snapshot.sessionId !== this.sessionId;
		if (first) this.sessionId = snapshot.sessionId;
		const seen = new Set<string>();
		let latest: NoticeToast | undefined;
		for (const activity of snapshot.activities ?? []) {
			const notice = activity.source === "live" ? applicationNotice(activity) : undefined;
			if (!notice) continue;
			seen.add(activity.id);
			if (!first && !this.seen.has(activity.id)) latest = { id: activity.id, ...notice };
		}
		// Only what the snapshot still holds is remembered: a notice that left it never comes back.
		this.seen = seen;
		return latest;
	}
}

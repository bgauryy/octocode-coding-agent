import type { ActivityTone } from "@octocodeai/octocode-contracts";
import { followSessionActivity } from "../activity/session-activity.ts";

/** Records one session's light tone; the caller owns the write's outcome (`SessionIndex.activityLater` through `later`). */
export type WriteActivity = (sessionId: string, tone: ActivityTone) => void;

/**
 * The cross-process half of the session's light (RFC 2026-11-23-app-state, T4): the process that has the session open
 * follows its light (`followSessionActivity`, the one `activity` mapping) and writes the tone when it changes. The store
 * notifies about twice per streamed token; the tone changes a few times per reply, so the database sees those few
 * writes. Other processes read the tone with the row's pid liveness (`/resume`, `coordinate list`); the session's start
 * writes `idle` and its end clears it in the database.
 */
export class SessionActivityRecord {
	private stop: (() => void) | undefined;
	private readonly write: WriteActivity;

	constructor(write: WriteActivity) {
		this.write = write;
	}

	/**
	 * Follows `sessionId` from now on, and stops following the session before it. `recorded` is the tone its row holds
	 * already (the session's start writes `idle`): the first write is the first change from it.
	 */
	follow(sessionId: string, recorded?: ActivityTone): void {
		this.close();
		let written = recorded;
		this.stop = followSessionActivity(sessionId, ({ tone }) => {
			if (tone === written) return;
			written = tone;
			this.write(sessionId, tone);
		});
	}

	/** Stops following: nothing more is written (the session's end clears the row's light). */
	close(): void {
		this.stop?.();
		this.stop = undefined;
	}
}

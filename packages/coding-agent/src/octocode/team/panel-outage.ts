import { safe } from "./panel-compact.ts";

export interface OutageNotice {
	text: string;
	/** The `ctx.ui.notify` level: an unusable database is an error, a locked one a warning, recovery info. */
	level: "info" | "warning" | "error";
}

/**
 * What the messages list says about the team database, read once a second: the footer keeps the short state
 * (`team off`, `team retrying`), and the full error is said here once per change, so a failure that repeats on every
 * tick adds no line. A database that cannot be used (`off`) is said at once; a locked one (`retrying`) only after it
 * failed on two ticks in a row, so one contended read that succeeds next adds nothing. Recovery is said only after an
 * outage that was said.
 */
export class TeamOutage {
	/** The failure last said, as `kind\0error`. */
	private said: string | undefined;
	/** A retrying failure seen on one tick and not said yet. */
	private pending: string | undefined;

	/** One read's result: the line to add to the messages list, if any. */
	next(error: string | undefined, retrying = false): OutageNotice | undefined {
		if (error === undefined) {
			this.pending = undefined;
			if (this.said === undefined) return undefined;
			this.said = undefined;
			return { text: "Team database reachable again.", level: "info" };
		}
		const shown = safe(error, 300);
		const key = `${retrying ? "retrying" : "off"}\0${shown}`;
		if (key === this.said) return undefined;
		if (retrying && this.pending !== key) {
			this.pending = key;
			return undefined;
		}
		this.pending = undefined;
		this.said = key;
		return retrying
			? { text: `Team database busy, retrying: ${shown}`, level: "warning" }
			: { text: `Team off: ${shown}`, level: "error" };
	}

	reset(): void {
		this.said = undefined;
		this.pending = undefined;
	}
}

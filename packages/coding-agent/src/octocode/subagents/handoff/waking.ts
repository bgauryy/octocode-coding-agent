import type { FeatureSetup } from "../../../core/features/index.ts";
import { sessionPhaseOf } from "../../shared/session-phase.ts";
import type { Report } from "./pending.ts";

/**
 * The reports a queue still owes the session, as a map that says when it changes. Each is delivered at least once and
 * leaves the map when the session records it.
 */
export class PendingReports extends Map<string, Report> {
	private readonly changed: () => void;

	constructor(changed: () => void) {
		super();
		this.changed = changed;
	}

	override set(id: string, report: Report): this {
		super.set(id, report);
		this.changed();
		return this;
	}

	override delete(id: string): boolean {
		const had = super.delete(id);
		if (had) this.changed();
		return had;
	}
}

/**
 * Tells the session's phase which reports will start a parent turn: those that wake, and are not given up on (every timed
 * retry failed, so they wait for the next settled turn, which no wake will start). One label per report.
 */
export function publishWaking(
	api: FeatureSetup,
	pending: ReadonlyMap<string, Report>,
	retries: ReadonlyMap<string, { attempts: number; timer?: unknown }>,
	maxAttempts: number,
): void {
	const exhausted = (id: string) => {
		const retry = retries.get(id);
		return retry !== undefined && !retry.timer && retry.attempts >= maxAttempts;
	};
	const labels = [...pending.entries()]
		.filter(([id, report]) => report.wake && !exhausted(id))
		.map(([, report]) => `report from ${report.details.id}`);
	sessionPhaseOf(api).setWakes("reports", labels);
}

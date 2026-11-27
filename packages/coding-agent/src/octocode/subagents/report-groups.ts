/**
 * Which background reports wait for a sibling's (`ReportQueue`), so children of one step that finish at nearly the same
 * moment cost the parent one turn.
 *
 * The children one parent step starts (the tool calls of one assistant message, a `tasks` array included) form a group.
 * A finished child's report goes at once, unless a background sibling of its group already settled and is still
 * building its report (its run has not ended, and its probe says the build is alive: not stalled, its supervised run
 * not over): then it waits for that report, and both go as one batch. A sibling that is still working never holds a
 * report: a finished result reaches the parent without waiting for slower siblings. Each report is judged by its own
 * group only: a report of another step, or of no group, never waits for it. No timer is involved; a probe that throws
 * releases the report.
 */

interface Member {
	background: boolean;
	settled: boolean;
	/** Its run ended. */
	ended?: boolean;
	/** Whether the child still works toward its answer, then (once settled) toward its report; absent until its process starts. */
	working?: () => boolean;
}

/**
 * Whether a settled member's report is still on its way: its probe (`working`, which then answers for the build) says
 * so. A probe that throws releases; a member that never had one (its process never started) is held for until it ends.
 */
function building(member: Member): boolean {
	if (!member.working) return true;
	try {
		return member.working();
	} catch {
		return false;
	}
}

export class ReportGroups {
	private step = 0;
	private readonly groupOf = new Map<string, number>();
	private readonly groups = new Map<number, Map<string, Member>>();
	private readonly remaining = new Map<number, number>();

	/** The parent's step ended or a new turn began: children started from now on form a new group. */
	nextStep(): void {
		this.step++;
	}

	/** A child was started in the current step (a resumed one moves to its new step). */
	join(id: string, background: boolean): void {
		const step = this.groupOf.get(id);
		if (step !== undefined) {
			const previous = this.groups.get(step);
			if (previous?.get(id)?.ended !== true) this.remaining.set(step, (this.remaining.get(step) ?? 1) - 1);
			previous?.delete(id);
			if (step !== this.step || previous?.size === 0) this.forgetEnded(step);
		}
		const group = this.groups.get(this.step) ?? new Map<string, Member>();
		group.set(id, { background, settled: false });
		this.groups.set(this.step, group);
		this.remaining.set(this.step, (this.remaining.get(this.step) ?? 0) + 1);
		this.groupOf.set(id, this.step);
	}

	/** The child's process started: `probe` says whether it still works toward its answer, and then its report. */
	working(id: string, probe: () => boolean): void {
		const member = this.member(id);
		if (member) member.working = probe;
	}

	/** The child settled with its final answer: its siblings' reports wait for its report while it is built. */
	settled(id: string): void {
		const member = this.member(id);
		if (member) member.settled = true;
	}

	/**
	 * The child's run ended (its report is queued, or it never had one): reports held for it go. It stays in its group
	 * while a sibling runs; the group is forgotten when every member ended.
	 */
	leave(id: string): void {
		const member = this.member(id);
		if (!member || member.ended) return;
		member.settled = true;
		member.ended = true;
		const step = this.groupOf.get(id)!;
		this.remaining.set(step, this.remaining.get(step)! - 1);
		this.forgetEnded(step);
	}

	/**
	 * Whether the report of `id` waits for a background sibling that settled and still builds its report (its run has not
	 * ended), unless that report is already in the batch (`batch`). The wait lasts while the sibling's probe says its
	 * report is on its way (it leaves, exits and is cleaned up): a stall or its supervised run's end releases it, and so
	 * does a probe that throws.
	 */
	awaitsReport(id: string, batch: ReadonlySet<string>): boolean {
		const step = this.groupOf.get(id);
		const group = step === undefined ? undefined : this.groups.get(step);
		if (!group) return false;
		for (const [other, member] of group)
			if (other !== id && member.background && member.settled && !member.ended && !batch.has(other) && building(member))
				return true;
		return false;
	}

	private forgetEnded(step: number): void {
		if (this.remaining.get(step) !== 0) return;
		for (const id of this.groups.get(step)?.keys() ?? []) this.groupOf.delete(id);
		this.groups.delete(step);
		this.remaining.delete(step);
	}

	private member(id: string): Member | undefined {
		const step = this.groupOf.get(id);
		return step === undefined ? undefined : this.groups.get(step)?.get(id);
	}
}

/** The children (of `queued`, the batch's) whose reports wait for a sibling's report being built (`awaitsReport`); the others go now. */
export function heldReports(groups: Pick<ReportGroups, "awaitsReport">, queued: readonly string[]): Set<string> {
	const batch = new Set(queued);
	const held = new Set<string>();
	for (const id of batch) if (groups.awaitsReport(id, batch)) held.add(id);
	return held;
}

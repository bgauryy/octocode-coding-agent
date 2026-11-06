import type { Member } from "@octocodeai/octocode-contracts/team";

/** The activity line of a member blocked on the user's answer: pausing it is deliberate, and a parent can route around it. */
export const WAITING_APPROVAL = "waiting for approval";

/** How a subagent's run ended, as the host (the process that ran it) reports it on the member (`Member.outcome`, `headline`). */
export interface RunEnd {
	outcome: NonNullable<Member["outcome"]>;
	headline?: string;
}

/** Ended runs remembered at most: the newest win. */
const ENDS_KEPT = 128;

/**
 * What only the process running a subagent knows of it: whether it waits for the user's answer to a dialog this process
 * shows, and when it last wrote output (its own row only says its process is alive).
 */
export class WaitingApprovals {
	private readonly waiting = new Set<string>();
	private readonly output = new Map<string, number>();
	private readonly ends = new Map<string, RunEnd>();

	set(id: string, waiting: boolean): void {
		if (waiting) this.waiting.add(id);
		else this.waiting.delete(id);
	}

	/** Subagent `id` wrote output at `at`. */
	noteOutput(id: string, at: number): void {
		this.output.set(id, at);
	}

	/** The run of subagent `id` ended: its member carries `outcome` and `headline` while its row exists. */
	noteEnd(id: string, end: RunEnd): void {
		this.ends.delete(id);
		this.ends.set(id, end);
		if (this.ends.size > ENDS_KEPT) this.ends.delete(this.ends.keys().next().value!);
	}

	/** How the run of `id` ended, once this host knows: a finished child's row is gone, so the panel asks here. */
	endOf(id: string): RunEnd | undefined {
		return this.ends.get(id);
	}

	clear(): void {
		this.ends.clear();
		this.waiting.clear();
		this.output.clear();
	}

	/** The view with each waiting member marked `waiting` (and its activity line replaced), each ended child's outcome, and each running child's last output. */
	overlay<T extends { members: Member[] }>(view: T): T {
		if (this.waiting.size === 0 && this.output.size === 0 && this.ends.size === 0) return view;
		return {
			...view,
			members: view.members.map((member) => {
				const lastOutputAt = this.output.get(member.id);
				const end = this.ends.get(member.id);
				return {
					...member,
					// The listing prints the activity line; panels and the webview read `waiting`.
					...(this.waiting.has(member.id) ? { activity: WAITING_APPROVAL, waiting: "approval" as const } : {}),
					...(end ? { outcome: end.outcome, ...(end.headline ? { headline: end.headline } : {}) } : {}),
					...(lastOutputAt === undefined ? {} : { lastOutputAt }),
				};
			}),
		};
	}
}

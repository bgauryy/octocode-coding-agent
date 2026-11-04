import type { Member } from "@octocodeai/octocode-contracts/team";

/** The activity line of a member blocked on the user's answer: pausing it is deliberate, and a parent can route around it. */
export const WAITING_APPROVAL = "waiting for approval";

/**
 * What only the process running a subagent knows of it: whether it waits for the user's answer to a dialog this process
 * shows, and when it last wrote output (its own row only says its process is alive).
 */
export class WaitingApprovals {
	private readonly waiting = new Set<string>();
	private readonly output = new Map<string, number>();

	set(id: string, waiting: boolean): void {
		if (waiting) this.waiting.add(id);
		else this.waiting.delete(id);
	}

	/** Subagent `id` wrote output at `at`. */
	noteOutput(id: string, at: number): void {
		this.output.set(id, at);
	}

	clear(): void {
		this.waiting.clear();
		this.output.clear();
	}

	/** The view with each waiting member's activity line replaced, and each running child's last output. */
	overlay<T extends { members: Member[] }>(view: T): T {
		if (this.waiting.size === 0 && this.output.size === 0) return view;
		return {
			...view,
			members: view.members.map((member) => {
				const lastOutputAt = this.output.get(member.id);
				return {
					...member,
					...(this.waiting.has(member.id) ? { activity: WAITING_APPROVAL } : {}),
					...(lastOutputAt === undefined ? {} : { lastOutputAt }),
				};
			}),
		};
	}
}

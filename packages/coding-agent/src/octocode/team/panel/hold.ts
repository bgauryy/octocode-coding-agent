import type { Member } from "@octocodeai/octocode-contracts/team";
import { formatDuration } from "../../shared/format.ts";

/** A `Thinking:` line stays this long before another line replaces it, so a fast stream of thoughts does not flicker. */
export const THINKING_HOLD_MS = 400;

/** A running bash command shows its elapsed time once it has run this long. */
const ELAPSED_AFTER_MS = 1_000;

const THINKING = /^Thinking\b/i;
const BASH = /^Running bash\b/i;

interface Held {
	line: string;
	/** When the panel first drew this line. */
	at: number;
}

/**
 * What each working child's activity line shows, as opposed to what its row holds now. A thinking line is held for
 * `THINKING_HOLD_MS`; a running bash command stays (with the time it has been shown) until the next tool line replaces it,
 * through the gaps and thoughts between calls. Display only: it reads the rows the panel already has, and keeps one
 * small entry per working child.
 */
export class ActivityHold {
	private readonly held = new Map<string, Held>();

	/** `members` with their activity lines as the panel draws them at `now`; the input is left as it is. */
	apply(members: readonly Member[], now: number): Member[] {
		const working = new Set<string>();
		const shown = members.map((member) => {
			if (member.status !== "working") return member;
			working.add(member.id);
			const line = this.next(member.id, member.activity ?? "", now);
			return line === (member.activity ?? "") ? member : { ...member, activity: line };
		});
		for (const id of this.held.keys()) if (!working.has(id)) this.held.delete(id);
		return shown;
	}

	clear(): void {
		this.held.clear();
	}

	private next(id: string, incoming: string, now: number): string {
		const cur = this.held.get(id);
		if (cur && cur.line !== incoming) {
			const bashStays = BASH.test(cur.line) && (incoming === "" || THINKING.test(incoming));
			const thoughtHeld = THINKING.test(cur.line) && now - cur.at < THINKING_HOLD_MS;
			if (bashStays || thoughtHeld) return this.draw(cur, now);
		}
		if (cur?.line === incoming) return this.draw(cur, now);
		if (incoming === "") {
			this.held.delete(id);
			return "";
		}
		const fresh = { line: incoming, at: now };
		this.held.set(id, fresh);
		return this.draw(fresh, now);
	}

	private draw(held: Held, now: number): string {
		const ran = now - held.at;
		return BASH.test(held.line) && ran >= ELAPSED_AFTER_MS ? `${held.line} · ${formatDuration(ran)}` : held.line;
	}
}

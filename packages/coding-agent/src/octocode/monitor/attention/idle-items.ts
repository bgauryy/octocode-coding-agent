import { renderPrompt } from "../../../core/prompt-template.ts";
import type { Attention } from "../ledger.ts";

/** The custom message that names ongoing items nobody works on. */
export const IDLE_ITEM_TYPE = "octocode-idle-item";

/** The nudge for `refs`, one line each. */
export function idleItemsText(refs: readonly string[]): string {
	return refs.map((ref) => renderPrompt("notices/monitor/idle-item.md", { ref }).trim()).join("\n");
}

/** The reading of an idle-items nudge: how many refs, with the refs as its subject (`monitor.alert` keys on them). */
export function idleItemsAttention(refs: readonly string[], at = Date.now()): Attention {
	return { rule: "idle-items", value: refs.length, threshold: 0, subject: refs.join(","), at };
}

/** Tells each idle item once while the same work keeps running; a change of the idle set (or no work) starts over. */
export class IdleItems {
	private told = new Set<string>();

	/**
	 * The refs of `idle` to name now: not yet told in this wait, and not `acted` on. An acted-on ref is counted in `dropped`
	 * and stays untold, so a later wait names it if the run then did nothing about it. Nothing (and the memory cleared)
	 * when no work runs.
	 */
	fresh(
		working: boolean,
		idle: readonly string[],
		acted: (ref: string) => boolean,
	): { fresh: string[]; dropped: number } {
		if (!working) {
			this.told.clear();
			return { fresh: [], dropped: 0 };
		}
		this.told = new Set([...this.told].filter((ref) => idle.includes(ref)));
		const fresh: string[] = [];
		let dropped = 0;
		for (const ref of idle) {
			if (this.told.has(ref)) continue;
			if (acted(ref)) dropped++;
			else {
				this.told.add(ref);
				fresh.push(ref);
			}
		}
		return { fresh, dropped };
	}
}

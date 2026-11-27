import { renderPrompt } from "../../../core/prompt-template.ts";
import type { Attention } from "../ledger.ts";

/** One stall to tell: `stall` the first time, `replan` the second (the work graph's stall tracker decides). */
export interface StalledItem {
	ref: string;
	agent: string;
	level: "stall" | "replan";
	minutes: number;
}

/** The custom message that names a stalled delegated item. */
export const STALLED_ITEM_TYPE = "octocode-stalled-item";

/** The nudge for `alerts`, one line each: a first stall asks for the child's state, a second for a re-plan. */
export function stalledItemsText(alerts: readonly StalledItem[]): string {
	return alerts
		.map(({ ref, agent, minutes, level }) =>
			renderPrompt(level === "stall" ? "notices/monitor/stalled-item.md" : "notices/monitor/stalled-item-again.md", {
				ref,
				agent,
				minutes: String(minutes),
			}).trim(),
		)
		.join("\n");
}

/** The reading of one stall: its silent minutes against the limit, the item as its subject. */
export function stalledItemAttention(alert: StalledItem, limit: number, at = Date.now()): Attention {
	return { rule: "stalled-item", value: alert.minutes, threshold: limit, subject: alert.ref, at };
}

import { visibleWidth } from "@octocodeai/octocode-tui";
import type { Member } from "@octocodeai/octocode-contracts/team";
import { clip } from "../../shared/text.ts";
import type { AgentEnd } from "./state.ts";

export { shownWorking } from "./state.ts";

/** A subagent that left the team keeps a row this long (its outcome, or neutral `left`), so its departure does not just vanish. */
export const FINISHED_MS = 30_000;

/** An agent that left the team (its row is gone from the database): its last snapshot and when it was last seen. */
export interface Finished {
	member: Member;
	at: number;
	/** How it ended, when the host reported it. */
	end?: AgentEnd;
}

/** Rows come from other processes' database rows: untrusted text, sanitized and cut to one line before drawing. */
export const safe = (text: string | undefined, max = 200) => (text ? clip(text, max) : "");

/** The most rows the panel takes, however tall the terminal (or when its height is unknown). */
const PANEL_MAX_ROWS = 16;

/**
 * The rows the panel may take on a terminal `rows` high: a third of it, never fewer than a header, an agent and a
 * "+N more" row, never more than `PANEL_MAX_ROWS`.
 */
export const panelBudget = (rows = Number.POSITIVE_INFINITY) =>
	Math.min(PANEL_MAX_ROWS, Math.max(3, Math.floor(rows / 3)));

/** `text` cut to `width` cells, ending in `…` when cut. */
export function fitName(text: string, width: number): string {
	if (visibleWidth(text) <= width) return text;
	let chars = width;
	let cut = clip(text, chars);
	while (chars > 1 && visibleWidth(cut) > width) cut = clip(text, --chars);
	return cut;
}

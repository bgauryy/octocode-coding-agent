import { GLYPH, SEPARATOR, truncateToWidth, visibleWidth } from "@octocodeai/octocode-tui";
import type { Member } from "@octocodeai/octocode-contracts/team";
import type { Theme } from "../../theme/theme.ts";
import { formatDuration } from "../shared/format.ts";
import { clip } from "../shared/render/text.ts";
import { worktreeName } from "../shared/member-worktree.ts";
import { type AgentEnd, type PanelEntry, panelColor, panelMark, panelState } from "./panel-state.ts";

export { type PanelEntry, shownWorking } from "./panel-state.ts";

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

/** A name keeps at least this many cells before the state columns, so agents stay tellable apart on a narrow terminal. */
export const NAME_MIN = 8;

/** The rows the panel may take on a terminal `rows` high: a third of it, never fewer than a header, an agent and a "+N more" row. */
export const panelBudget = (rows: number) => Math.max(3, Math.floor(rows / 3));

/** `text` cut to `width` cells, ending in `…` when cut. */
export function fitName(text: string, width: number): string {
	if (visibleWidth(text) <= width) return text;
	let chars = width;
	let cut = clip(text, chars);
	while (chars > 1 && visibleWidth(cut) > width) cut = clip(text, --chars);
	return cut;
}

/**
 * One row per agent: mark, name (at least `NAME_MIN` cells), state, the `✉` count of messages waiting for its answer,
 * and the age when it fits. For terminals with few rows or narrow ones: the name gives way to the state and the count.
 */
export function collapsedRows(tree: PanelEntry[], now: number, theme: Theme, width: number): string[] {
	return tree.map((entry) => {
		const { member, depth, doneAt } = entry;
		const state = panelState(entry, now);
		const lively = state.state === "running" || state.state === "waiting";
		const age = formatDuration((doneAt ?? now) - member.joinedAt);
		const prefix = depth > 0 ? `${"  ".repeat(depth - 1)} └ ` : "";
		const flag = member.pending ? `${GLYPH.message} ${member.pending}` : "";
		const tail = flag ? `${SEPARATOR}${flag}` : "";
		const worktree = entry.isolated ? `${SEPARATOR}worktree ${clip(worktreeName(entry.isolated.folder), 24)}` : "";
		const name = fitName(
			`${prefix}${clip(member.id, 64)}`,
			Math.max(NAME_MIN, width - state.label.length - worktree.length - tail.length - 7),
		);
		const bare = ` ${panelMark(theme, state, now, doneAt)} ${theme.fg(lively ? "text" : "muted", name)}${SEPARATOR}${theme.fg(panelColor(state), state.label)}${theme.fg("accent", worktree)}${theme.fg("warning", tail)}`;
		const ageText = visibleWidth(bare) + age.length + SEPARATOR.length <= width ? `${SEPARATOR}${age}` : "";
		return truncateToWidth(`${bare}${theme.fg("dim", ageText)}`, Math.max(1, width), "…");
	});
}

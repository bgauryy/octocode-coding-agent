import type { Member } from "@octocodeai/octocode-contracts/team";
import type { Theme } from "../../theme/theme.ts";
import { STATE_COLOR, stateMark, type UiState } from "../../theme/status.ts";

/** A subagent joins the team just before its first turn; its stored `idle` then is not news, so the panel shows it working. */
const STARTING_MS = 3_000;

/** Whether the panel shows `member` as working: its stored status, or a subagent that joined moments ago. */
export function shownWorking(member: Member, now: number): boolean {
	return (
		member.status === "working" ||
		(member.parentId !== undefined && !member.toolCalls && now - member.joinedAt < STARTING_MS)
	);
}

/** One panel row's agent: its depth under this session, and when it left the team (`✓ done`) if it did. */
export interface PanelEntry {
	member: Member;
	depth: number;
	doneAt?: number;
}

/** What a panel row says about an agent: the design state (mark and colour), its word, and when it finished. */
export interface PanelState {
	state: UiState;
	label: "working" | "idle" | "done";
	/** When a done agent left the team: its mark glows briefly after this. */
	since?: number;
}

/** The one place the panel decides an agent's state: working is running, idle is pending, a departed agent is done. */
export function panelState({ member, doneAt }: PanelEntry, now: number): PanelState {
	if (doneAt !== undefined) return { state: "done", label: "done", since: doneAt };
	return shownWorking(member, now) ? { state: "running", label: "working" } : { state: "pending", label: "idle" };
}

/** The colour role of `state`'s word and of its mark. */
export const panelColor = (state: PanelState) => STATE_COLOR[state.state];

/** The mark in front of an agent's row, painted for `now` (a spinner frame while it works, a glow just after it finished). */
export const panelMark = (theme: Theme, state: PanelState, now: number): string =>
	stateMark(theme, state.state, { now, ...(state.since === undefined ? {} : { since: state.since }) });

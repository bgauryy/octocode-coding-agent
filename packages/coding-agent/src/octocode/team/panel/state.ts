import type { Member, Traffic } from "@octocodeai/octocode-contracts/team";
import type { Theme } from "../../../theme/theme.ts";
import { STATE_COLOR, stateMark, type UiState } from "../../../theme/status.ts";

/** A subagent joins the team just before its first turn; its stored `idle` then is not news, so the panel shows it working. */
const STARTING_MS = 3_000;

/** Whether the panel shows `member` as working: its stored status, or a subagent that joined moments ago. */
export function shownWorking(member: Member, now: number): boolean {
	return (
		member.status === "working" ||
		(member.parentId !== undefined && !member.toolCalls && now - member.joinedAt < STARTING_MS)
	);
}

/** How a finished run ended: the report's outcome, or `stopped` for a run someone ended. */
type AgentOutcome = "done" | "partial" | "blocked" | "failed" | "stopped";

/** What the host knows of a finished run that the team database no longer holds: its outcome and a one-line headline. */
export interface AgentEnd {
	outcome: AgentOutcome;
	headline?: string;
}

/** Why an agent needs the user: its process waits for an approval dialog, or it asked this session a question that still waits for the answer. */
export interface Need {
	kind: "approval" | "ask";
	/** The newest unanswered question to this session (`ask`). */
	message?: Traffic;
	/** How many questions wait. */
	count: number;
}

/** One panel row's agent: its depth under this session, and when it left the team if it did. */
export interface PanelEntry {
	member: Member;
	depth: number;
	doneAt?: number;
	/** How the run ended, when the host reported it. */
	end?: AgentEnd;
	/** Set while the agent waits for the user. */
	need?: Need;
	/** Set when it works in its own worktree (a checkout other than this session's): the worktree's folder. */
	isolated?: { folder: string };
}

/** What a panel row says about an agent: the design state (mark and colour) and its word. */
export interface PanelState {
	state: UiState;
	label: "needs you" | "working" | "idle" | "left" | "done" | "partial" | "blocked" | "failed" | "stopped";
}

const ENDED: Record<AgentOutcome, PanelState> = {
	done: { state: "done", label: "done" },
	partial: { state: "done", label: "partial" },
	blocked: { state: "waiting", label: "blocked" },
	failed: { state: "failed", label: "failed" },
	stopped: { state: "stopped", label: "stopped" },
};

/**
 * A departed agent shows its outcome when the host reported one; without that evidence the mark stays neutral, since a
 * stopped or failed agent leaves too. A live agent that waits for the user outranks working.
 */
export function panelState({ member, doneAt, end, need }: PanelEntry, now: number): PanelState {
	if (doneAt !== undefined) return end ? { ...ENDED[end.outcome] } : { state: "pending", label: "left" };
	if (need) return { state: "waiting", label: "needs you" };
	return shownWorking(member, now) ? { state: "running", label: "working" } : { state: "pending", label: "idle" };
}

/** Whether a row waits on the user: a live agent that needs an answer, or a run that ended blocked. */
export const needsAttention = (state: PanelState): boolean => state.label === "needs you" || state.label === "blocked";

/** The colour role of `state`'s word and of its mark. */
export const panelColor = (state: PanelState) => STATE_COLOR[state.state];

/** The mark in front of an agent's row, painted for `now` (a spinner frame while it works, a glow just after it finished at `since`). */
export const panelMark = (theme: Theme, state: PanelState, now: number, since?: number): string =>
	stateMark(theme, state.state, {
		now,
		background: true,
		...(since === undefined ? {} : { since }),
	});

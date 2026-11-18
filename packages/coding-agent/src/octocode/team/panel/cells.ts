import path from "node:path";
import { GLYPH, visibleWidth } from "@octocodeai/octocode-tui";
import type { Member } from "@octocodeai/octocode-contracts/team";
import type { Theme } from "../../../theme/theme.ts";
import {
	cachedPercent,
	formatCost,
	formatDuration,
	formatTokens,
	newPromptTokens,
	toolCallCount,
} from "../../shared/format.ts";
import { plural } from "../../shared/text.ts";
import { routeThinking } from "../../render/route-thinking.ts";
import { runnerMember } from "../runner-kind.ts";
import { activityText } from "./activity.ts";
import { fitName, safe } from "./compact.ts";
import { markSince, type PanelEntry, panelMark, panelState } from "./state.ts";

/** A model id keeps this many cells on the detail line; a longer one is cut before its `:level`. */
const MODEL_MAX = 28;
/** The branch or folder shown after `worktree`, cut to this many cells. */
const WHERE_MAX = 28;
/** A name is cut to this many cells, so one long name cannot push every column right. */
const NAME_MAX = 20;

/**
 * `anthropic/claude-opus-4-5:high` → `claude-opus-4-5:high`: the provider adds width, not meaning. A long id is cut
 * before its `:level`, which says how hard the agent thinks and stays visible.
 */
function modelLabel(model: string | undefined): string {
	if (!model) return "";
	const name = model.slice(model.lastIndexOf("/") + 1);
	const colon = name.lastIndexOf(":");
	if (colon <= 0 || name.length <= MODEL_MAX) return safe(name, MODEL_MAX);
	return `${safe(name.slice(0, colon), Math.max(1, MODEL_MAX - (name.length - colon)))}${name.slice(colon)}`;
}

/**
 * The badge of an agent that works in its own worktree: `worktree ⎇ branch`, or `worktree folder` without a branch.
 * `short` is the bare word. Both empty for an agent in this session's checkout.
 */
function worktreeBadge(entry: PanelEntry): { full: string; short: string } {
	if (!entry.isolated) return { full: "", short: "" };
	const { branch } = entry.member;
	const name = branch ? `⎇ ${safe(branch, WHERE_MAX)}` : safe(path.basename(entry.isolated.folder), WHERE_MAX);
	return { full: name ? `worktree ${name}` : "worktree", short: "worktree" };
}

type Usage = Pick<Member, "input" | "cacheRead" | "output">;
/**
 * An agent's tokens, as the footer counts them: new prompt tokens and output. Cache reads are re-reads of the
 * conversation; they show only as the cached share beside it.
 */
const totalTokens = (usage: Usage) => newPromptTokens(usage) + usage.output;
const tokensText = (usage: Usage) => (totalTokens(usage) > 0 ? `${formatTokens(totalTokens(usage))} tok` : "");

/** The share of prompt tokens read from cache: high means cheap re-reads of the conversation. */
function cachedShare(usage: Usage): string {
	const prompt = newPromptTokens(usage) + usage.cacheRead;
	return usage.cacheRead > 0 ? `${cachedPercent(usage.cacheRead, prompt)}% cached` : "";
}

/**
 * `implementer` and `high`: the role and the effort its own process reports in `Member.model` (`provider/id:level`). A
 * runner (`mailbox: "pull"`) owns its effort, so it shows `?`. No effort when it is unknown: a held row has no model yet.
 * The role always shows, also for an id that starts with it (`researcher-3fa9`).
 */
function roleParts(member: Member): { role: string; effort: string } {
	if (!member.role) return { role: "", effort: "" };
	const effort = runnerMember(member) ? "?" : (routeThinking(member.model) ?? "");
	return { role: safe(member.role, 24), effort };
}

/** Where an agent sits in the panel: this session (the tree's root), one of its descendants, or a peer session. */
export type RowKind = "root" | "child" | "peer";

/** What one agent's grid row draws, as plain text cells (the grid paints and measures them). */
export interface Row {
	entry: PanelEntry;
	kind: RowKind;
	/** The painted state mark. */
	mark: string;
	/** Working or waiting for the user: the name and goal show in the text colour, else muted. */
	lively: boolean;
	name: string;
	role: string;
	effort: string;
	elapsed: string;
	cost: string;
	tokens: string;
	cached: string;
	goal: string;
	activity: string;
	/** `✉ N`: messages waiting for this agent's answer; drawn at the end of the goal cell and never cut. */
	pending: string;
	/** The detail line's cells, in the order they give way last to first. */
	detail: { model: string; tools: string; where: string; whereShort: string; locks: string };
}

/** One agent's row cells at `now`. `known`: false for this session's row before its team row exists (no clock, no spend). */
export function row(entry: PanelEntry, kind: RowKind, now: number, theme: Theme, known = true): Row {
	const { member } = entry;
	const state = panelState(entry, now);
	const working = state.state === "running";
	const where = worktreeBadge(entry);
	const { role, effort } = roleParts(member);
	return {
		entry,
		kind,
		mark: panelMark(theme, state, now, markSince(entry)),
		// An agent that waits for the user reads as live as one that works.
		lively: working || state.state === "waiting",
		name: fitName(safe(member.id, 64), NAME_MAX),
		role,
		effort,
		elapsed: known ? formatDuration((entry.doneAt ?? now) - member.joinedAt) : "",
		// This session's own spend is in the footer's one total, which also holds every descendant's.
		cost: kind === "root" ? "" : formatCost(member),
		tokens: tokensText(member),
		cached: cachedShare(member),
		goal: safe(member.goal),
		activity: working ? safe(activityText(member.activity, [member.cwd, member.checkout])) : "",
		pending: member.pending ? `${GLYPH.message} ${member.pending}` : "",
		detail: {
			model: modelLabel(member.model),
			tools: member.toolCalls > 0 ? toolCallCount(member.toolCalls) : "",
			where: where.full,
			whereShort: where.short,
			locks: member.locks?.length ? plural(member.locks.length, "lock") : "",
		},
	};
}

/** A leading item id (`B657+B658:`), drawn dim before the goal. */
const ITEM_LEAD = /^((?:B\d+[+,]?)+:)/;

/** `goal` painted: a leading item id dim, the rest in `color`. */
export function paintGoal(theme: Theme, goal: string, color: "text" | "muted"): string {
	const lead = ITEM_LEAD.exec(goal)?.[1] ?? "";
	return `${lead ? theme.fg("dim", lead) : ""}${theme.fg(color, goal.slice(lead.length))}`;
}

/** `role:effort` painted: the role muted, `:level` dim. */
export function paintRole(theme: Theme, role: string, effort: string): string {
	if (!role) return effort ? theme.fg("dim", effort) : "";
	return `${theme.fg("muted", role)}${effort ? theme.fg("dim", `:${effort}`) : ""}`;
}

export const widest = (texts: readonly string[]) => Math.max(0, ...texts.map((text) => visibleWidth(text)));

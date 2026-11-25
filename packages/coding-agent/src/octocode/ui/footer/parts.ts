import path from "node:path";
import { isScreenReaderMode } from "@octocodeai/octocode-tui";
import { truncateToWidth } from "@octocodeai/octocode-tui/text";
import { sanitizeTerminalText, styledLine } from "@octocodeai/octocode-common/sanitize";
import { homeTilde } from "@octocodeai/octocode-common/home-tilde";
import { usageCells, usagePercent } from "../../../core/agent-session/usage-gauge.ts";
import type { Theme } from "../../../theme/theme.ts";
import { CHIPS, type ChipParts, chipLabel, chipShortLabel } from "../../permission/mode.ts";
import { cachedPercent, formatCost, formatTokens, newPromptTokens } from "../../shared/format.ts";
import { totalSpend } from "../../shared/team-spend.ts";
import { resetClock } from "@octocodeai/octocode-common/time";
import { QUOTA_ALARM } from "../../shared/quota-text.ts";
import type { FooterPaint, FooterPart } from "./fit.ts";
import type { FooterState } from "./state.ts";

type Color = Parameters<Theme["fg"]>[0];

/**
 * Priorities of the steps parts take when a line is too narrow; the smallest goes first. Zone A's optional parts give way
 * first (30–49), then zone H's (50–69), then zone E's (70–89); floors are 90 and up and `keep`.
 */
export const PRIORITY = {
	hooks: 32,
	actions: 34,
	runningCollapse: 40,
	team: 44,
	breakdown: 50,
	whereElide: 51,
	chipWord: 52,
	ctxWindow: 54,
	chipKey: 56,
	ctxBar: 58,
	/** At 50% and over the gauge holds until H's floor. */
	ctxBarHalf: 69,
	tokens: 62,
	/** A plan window from 70 %: its reset time goes early, the figure holds until zone H's floor. */
	quota: 60,
	cached: 66,
	quotaShort: 86,
	whereBasename: 88,
	/**
	 * Floors, in the order the last pass cuts them on a very narrow row: zone A's work marks first, then the plan mark, the
	 * context, the location (its branch text first) and `Σ`. The permission mode outlasts them all (the footer is the one
	 * place it shows); only the context alarm outlasts it.
	 */
	wakeRetry: 90,
	queued: 91,
	runningFloor: 92,
	plan: 93,
	quotaFloor: 93,
	ctxFloor: 94,
	whereFloor: 95,
	/** From 90 % a plan window outlasts the location: the next requests may be refused. */
	quotaAlarm: 96,
	sigma: 97,
	chipFloor: 98,
	/** Past the alarm point (80% of the auto-compact point) the context gauge holds its bar and percent through every other step. */
	ctxAlarm: 99,
} as const;

/** Text drawn without colour (a model id, a path, a branch): every terminal control removed, on one row. */
export const plainRow = (text: string) => styledLine(sanitizeTerminalText(text));

const BAR_CELLS = 8;

/** Where the gauge turns red: 80% of the auto-compact point, as a percent of the window (80% of the window without one). */
function alarmPercent(context: { window: number; compactAt?: number }): number {
	return context.compactAt ? ((context.compactAt * 0.8) / context.window) * 100 : 80;
}

/**
 * An 8-cell gauge of the window and its colour: green under half of the window, yellow after, red above `alarmAt`
 * (a percent of the window), judged on the rounded percent the label shows. Any use fills at least one cell.
 */
export function contextBar(percent: number, alarmAt = 80): { bar: string; color: Color } {
	const shown = Math.round(percent);
	const filled = usageCells(percent, BAR_CELLS);
	return {
		bar: "▰".repeat(filled) + "▱".repeat(BAR_CELLS - filled),
		color: shown > alarmAt ? "error" : shown >= 50 ? "warning" : "success",
	};
}

/**
 * `cwd ⎇ branch`: the path, then its root and last two directories, then its basename, and last the basename alone, so
 * zone H's `ctx NN%` floor outlasts the branch. The branch gets a third of the row.
 */
export function wherePart(state: FooterState, branch: string | null, theme: FooterPaint, width: number): FooterPart {
	const place = plainRow(state.home ? homeTilde(state.cwd, state.home) : state.cwd);
	const segments = place.split(/(?<=[\\/])/);
	const elided = segments.length > 3 ? `${segments[0]}…${path.sep}${segments.slice(-2).join("")}` : undefined;
	const shownBranch = branch
		? plainRow(truncateToWidth(plainRow(branch), Math.max(1, Math.floor(width / 3)), "…"))
		: "";
	const where = (dir: string) =>
		`${theme.fg("text", dir)}${shownBranch ? ` ${theme.fg("muted", `⎇ ${shownBranch}`)}` : ""}`;
	return {
		text: where(place),
		keep: true,
		...(elided
			? { middle: where(elided), priority: PRIORITY.whereElide, later: PRIORITY.whereBasename }
			: { priority: PRIORITY.whereBasename }),
		short: where(plainRow(path.basename(state.cwd))),
		...(shownBranch ? { bare: theme.fg("text", plainRow(path.basename(state.cwd))) } : {}),
		floor: PRIORITY.whereFloor,
	};
}

/** The mode in its tone with its shortcut dim beside it; then without the word `permission:`; then without the shortcut. Counters go to zone A. */
export function chipPart(chip: ChipParts | undefined, theme: FooterPaint): FooterPart {
	if (!chip) return { text: "", priority: PRIORITY.chipWord, keep: true };
	const bare = { ...chip, counters: "" };
	const tone = CHIPS[chip.mode].color;
	const key = theme.fg("dim", ` · ${chip.key}`);
	return {
		text: `${theme.fg(tone, chipLabel(bare))}${key}`,
		middle: `${theme.fg(tone, chipShortLabel(bare))}${key}`,
		short: theme.fg(tone, chipShortLabel(bare)),
		priority: PRIORITY.chipWord,
		later: PRIORITY.chipKey,
		floor: PRIORITY.chipFloor,
		keep: true,
	};
}

/** Zone H: `ctx ▰▰▱▱▱▱▱▱ 34% of 271k`, the tokens spent (new prompt plus output) and the cached share of the prompt. */
export function healthParts(state: FooterState, theme: FooterPaint): FooterPart[] {
	const context = state.context;
	let ctx: FooterPart = { text: "", priority: PRIORITY.ctxWindow, floor: PRIORITY.ctxFloor, keep: true, whole: true };
	if (context) {
		const label = theme.fg("muted", "ctx");
		const unknown = theme.fg("dim", "?");
		const window = theme.fg("dim", `of ${formatTokens(context.window)}`);
		// A window of 0 is no window at all (the model declares none): the gauge says it does not know.
		if (context.window <= 0) ctx = { ...ctx, text: `${label} ${unknown}`, short: `${label} ${unknown}` };
		else if (context.percent === null) {
			// Right after compaction, until the next reply: unknown, never `0%`.
			ctx = { ...ctx, text: `${label} ${unknown} ${window}`, short: `${label} ${unknown}` };
		} else {
			const shown = Math.round(context.percent);
			const { bar, color } = contextBar(context.percent, alarmPercent(context));
			const figure = theme.fg(color, usagePercent(context.percent));
			// A screen reader gets words, not an 8-cell bar of block glyphs.
			const gauge = isScreenReaderMode()
				? `${theme.fg("muted", "context")} ${figure}`
				: `${label} ${theme.fg(color, bar)} ${figure}`;
			ctx = {
				...ctx,
				text: `${gauge} ${window}`,
				middle: gauge,
				short: `${label} ${figure}`,
				later: color === "error" ? PRIORITY.ctxAlarm : shown >= 50 ? PRIORITY.ctxBarHalf : PRIORITY.ctxBar,
				...(color === "error" ? { floor: PRIORITY.ctxAlarm } : {}),
			};
		}
	}
	// Cache reads are re-reads of the conversation on every request: they show as the cached share, not in the tokens.
	const usage = state.usage;
	const fresh = newPromptTokens(usage);
	const spent = fresh + usage.output;
	// Nothing spent yet (a fresh session): no `0 tok` placeholder.
	const tokens = spent > 0 ? theme.fg("muted", `${formatTokens(spent)} tok`) : "";
	const breakdown = theme.fg("dim", `(↑${formatTokens(fresh)} ↓${formatTokens(usage.output)})`);
	// The session's cumulative share of prompt tokens read from cache (the turn line shows each run's own share).
	// Hidden until a provider reports a cache read, so models without prompt caching show no permanent `0%`.
	const hitRate = usage.cacheRead > 0 ? cachedPercent(usage.cacheRead, usage.input) : undefined;
	return [
		ctx,
		{
			text: tokens ? `${tokens} ${breakdown}` : "",
			short: tokens,
			priority: PRIORITY.breakdown,
			later: PRIORITY.tokens,
			details: true,
		},
		{
			text: hitRate === undefined ? "" : theme.fg("muted", `${hitRate}% cached`),
			priority: PRIORITY.cached,
			details: true,
		},
	];
}

/**
 * A plan window near its cap: `quota 5h 92% · resets 14:20` in the warning colour from 70 %, the error colour from 90 %,
 * then `quota 5h 92%`, then `5h 92%`; never cut (a cut figure misreads). Nothing below 70 % (`FooterState.quota`).
 */
export function quotaPart(state: FooterState, theme: FooterPaint, now = Date.now()): FooterPart {
	const quota = state.quota;
	if (!quota) return { text: "", priority: PRIORITY.quota };
	const alarm = quota.usedFraction >= QUOTA_ALARM;
	const tone: Color = alarm ? "error" : "warning";
	const figure = `${quota.label} ${Math.round(quota.usedFraction * 100)}%`;
	const named = theme.fg(tone, `quota ${figure}`);
	const reset =
		quota.resetsAt !== undefined && quota.resetsAt > now
			? theme.fg("dim", ` · resets ${resetClock(quota.resetsAt, now)}`)
			: "";
	return {
		text: `${named}${reset}`,
		...(reset ? { middle: named } : {}),
		short: theme.fg(tone, figure),
		priority: alarm ? PRIORITY.quotaAlarm : PRIORITY.quota,
		later: alarm ? PRIORITY.quotaAlarm : PRIORITY.quotaShort,
		floor: alarm ? PRIORITY.quotaAlarm : PRIORITY.quotaFloor,
		keep: true,
		whole: true,
		details: true,
	};
}

/** A plan's share as an estimate, never money: `~$3.10 plan`. */
const planEstimate = (cost: number) => `~$${cost < 0.01 ? "<0.01" : cost.toFixed(2)} plan`;

/**
 * The one total, `Σ`: the ledger plus the live agents that have not reported yet, money apart from what the spend a plan
 * paid for (`FooterState.planBilled`, and each live agent whose `billing` is `plan`) would have cost at list price:
 * `Σ ≈$1.24`, `Σ ~$3.10 plan`, `Σ ≈$1.24 · ~$3.10 plan`. `Σ (sub)` when a plan paid for all of it and nothing priced it.
 */
export function sigmaText(state: FooterState, theme: FooterPaint): string {
	const live = state.live ?? [];
	const reported = state.reported ?? new Set<string>();
	const total = totalSpend(state.usage, live, reported);
	// The live agents' plan share: the total with and without their plan-billed spend (`totalSpend` decides who is held).
	const unplanned = live.map((agent) => (agent.billing === "plan" ? { ...agent, cost: 0 } : agent));
	const livePlan = total.cost - totalSpend(state.usage, unplanned, reported).cost;
	const plan = state.planBilled;
	const planReplies = (plan?.replies ?? 0) + (livePlan > 1e-9 ? 1 : 0);
	const planCost = planReplies > 0 ? Math.max(0, (plan?.cost ?? 0) + livePlan) : 0;
	const metered = total.cost - planCost > 1e-9 ? total.cost - planCost : 0;
	const money = formatCost({ cost: metered, unpriced: total.unpriced });
	const estimate = planCost > 0 ? theme.fg("muted", planEstimate(planCost)) : "";
	if (!money && !estimate) return planReplies > 0 && total.cost <= 1e-9 ? theme.fg("text", "Σ (sub)") : "";
	const [priced = "", unpriced] = money.split(" + ");
	const head = priced === "cost n/a" ? theme.fg("warning", priced) : priced ? theme.fg("text", priced) : "";
	const shown = `${head}${unpriced ? theme.fg("warning", ` + ${unpriced}`) : ""}`;
	return `${theme.fg("text", "Σ")} ${[shown, estimate].filter(Boolean).join(theme.fg("dim", " · "))}`;
}

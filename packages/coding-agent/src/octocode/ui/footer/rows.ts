import path from "node:path";
import { truncateToWidth, wrapTextWithAnsi } from "@octocodeai/octocode-tui/text";
import { sanitizeTerminalText, styledLine } from "../../../../../common/src/sanitize.ts";
import type { StatusEntry } from "../../../core/footer-data-provider.ts";
import type { ProviderKind } from "../../../core/model-runtime/catalog.ts";
import { paintStatus } from "../../../theme/status.ts";
import type { Theme } from "../../../theme/theme.ts";
import { CHIPS, type ChipParts, chipLabel, chipShortLabel, PERMISSION_ID } from "../../permission/mode.ts";
import { formatCost, formatTokens, formatTokenUsage, newPromptTokens } from "../../shared/format.ts";
import { STATUS } from "../../shared/status.ts";
import type { UsageTotals } from "../../shared/util.ts";
import { shortThinking } from "./spend.ts";
import { homeTilde } from "../../../../../common/src/home-tilde.ts";
import { fitFooterLine, type FooterPaint, type FooterPart } from "./fit.ts";

/**
 * Octocode's two-line footer, in the order other coding agents converged on: line 1 is what the agent is and is doing
 * (model, permission mode, thinking, context, running agents, bash jobs, queued messages and a running hook; run time,
 * speed and cost on the right). Line 2 shows cwd, branch, session name, total tokens, compactions and other statuses.
 * Alerts that do not fit use up to three extra rows; /status retains the complete data.
 * Rendering is pure in (state, statuses, width); the activity indicator owns the live run clock.
 */

export interface FooterState {
	model?: string | undefined;
	/** The model's provider id: the same model id can come from several hosts (Anthropic, Bedrock, OpenRouter). */
	provider?: string | undefined;
	/** The model's provider is paid by subscription: the cost shown is an estimate, not a bill. */
	subscription?: boolean;
	/** What the model's provider is (subscription, API key, account, CLI, local): shown beside the model. */
	kind?: ProviderKind | undefined;
	/** Thinking level, only for models that reason. */
	thinking?: string | undefined;
	/**
	 * `limit` is where Octocode compacts automatically (the window less the built-in reserve); `percent`
	 * is of `limit`, and null right after compaction, until the next response.
	 */
	context?: { percent: number | null; limit: number } | undefined;
	/** The session's replies and every subagent's spend (foreground results, background reports): `input` is the whole prompt, shown as new tokens plus cache reads (`formatTokenUsage`); `cost` is Octocode's estimate. */
	usage: UsageTotals;
	/** A run is in progress. The run's time is the transcript's turn line (`Worked 12s`), not the footer's. */
	running?: boolean;
	/** Completed compaction entries across the session, including resumed history. */
	compactions?: number;
	cwd: string;
	home?: string | undefined;
	sessionName?: string | undefined;
	/** The permission chip, drawn first after the model; none until the mode is known. */
	chip?: ChipParts | undefined;
}

type Color = Parameters<Theme["fg"]>[0];
type Paint = FooterPaint;

/** Status keys this footer places itself; any other extension's status is appended to line 2. */
const OWN = {
	permission: PERMISSION_ID,
	team: STATUS.team,
	running: STATUS.running,
	queued: STATUS.queued,
	speed: STATUS.speed,
	hooks: STATUS.hooks,
	backlog: STATUS.backlog,
	steps: STATUS.steps,
} as const;
const BAR_CELLS = 8;

/** An 8-cell gauge and its colour: green under half, yellow to 80%, red above. Any use fills at least one cell. */
export function contextBar(percent: number): { bar: string; color: Color } {
	const cells = Math.round((percent / 100) * BAR_CELLS);
	const filled = Math.min(BAR_CELLS, Math.max(percent > 0 ? 1 : 0, cells));
	return {
		bar: "▰".repeat(filled) + "▱".repeat(BAR_CELLS - filled),
		color: percent > 80 ? "error" : percent >= 50 ? "warning" : "success",
	};
}

/**
 * A part of a line. Parts drop (or switch to `short`) lowest `priority` first until the line fits; `keep` parts are
 * shortened last; on very narrow rows the highest priority part survives.
 */
type Part = FooterPart;

/** Text drawn without colour (a model id, a path, a branch): every terminal control removed, on one row. */
const plainRow = (text: string) => styledLine(sanitizeTerminalText(text));

/** The mode in its tone, the shortcut dim beside it; the short form drops the shortcut. */
function chipPart(chip: ChipParts | undefined, theme: Paint): Part {
	if (!chip) return { text: "", priority: 95, keep: true };
	const tone = CHIPS[chip.mode].color;
	return {
		text: `${theme.fg(tone, chipLabel(chip))}${theme.fg("dim", ` · ${chip.key}`)}`,
		priority: 95,
		keep: true,
		short: theme.fg(tone, chipShortLabel(chip)),
	};
}

export function footerLines(
	state: FooterState,
	branch: string | null,
	statuses: ReadonlyMap<string, StatusEntry>,
	theme: Paint,
	width: number,
): string[] {
	// Statuses are data: each is painted in its tone with this frame's theme, so a theme switch reaches every one.
	// A status may carry its own colours; any other control goes, and it stays on one row (`styledLine`).
	const text = (key: string) => styledLine(statuses.get(key)?.text ?? "");
	const status = (key: string, shown = text(key)) => paintStatus({ text: shown, tone: statuses.get(key)?.tone }, theme);
	// `provider/id` when it fits; the short form drops the provider before cutting the id.
	const model = plainRow(
		state.model ? (state.provider ? `${state.provider}/${state.model}` : state.model) : "no model",
	);
	const shortModel = plainRow(truncateToWidth(state.model ?? "no model", Math.max(1, Math.floor(width / 3)), "…"));
	const context = state.context;
	// Context is a safety signal: it outranks the ephemeral status counters and shortens to `ctx 42%` before anything is dropped.
	let ctx: Part = { text: "", priority: 93, keep: true };
	if (context) {
		const window = formatTokens(context.limit);
		if (context.percent === null)
			ctx = { ...ctx, text: `${theme.fg("muted", "ctx")} ${theme.fg("dim", `? of ${window}`)}` };
		else {
			const { bar, color } = contextBar(context.percent);
			const percent = theme.fg(color, `${Math.round(context.percent)}%`);
			ctx = {
				...ctx,
				text: `${theme.fg("muted", "ctx")} ${theme.fg(color, bar)} ${percent} ${theme.fg("dim", `of ${window}`)}`,
				short: `${theme.fg("muted", "ctx")} ${percent}`,
			};
		}
	}
	const cost = formatCost(state.usage) + (formatCost(state.usage) && state.subscription ? " (sub)" : "");
	const top = fitFooterLine(
		[
			{
				text: theme.fg("accent", model),
				priority: 94,
				keep: true,
				...(shortModel !== model ? { short: theme.fg("accent", shortModel) } : {}),
			},
			// The provider's kind beside the model: the first part to go on a narrow terminal.
			{ text: state.kind ? theme.fg("muted", state.kind) : "", priority: 5 },
			// The one home of the permission mode, with its shortcut: kept on a narrow terminal, shortened after the model.
			chipPart(state.chip, theme),
			// Kept ahead of the status counters (90): a short form first, then the counters give way.
			{
				text: state.thinking ? theme.fg("muted", `thinking ${plainRow(state.thinking)}`) : "",
				priority: 91,
				keep: true,
				...(state.thinking ? { short: theme.fg("muted", shortThinking(plainRow(state.thinking))) } : {}),
			},
			ctx,
			{ text: status(OWN.team), priority: 90, keep: true, details: true },
			{ text: status(OWN.running), priority: 90, keep: true, details: true },
			// Messages waiting for the run to end: the user should see theirs did not get lost.
			{ text: status(OWN.queued), priority: 85, keep: true, details: true },
			// Last of the left parts: its clock grows, so nothing else on the row moves with it.
			{ text: status(OWN.hooks), priority: 80, keep: true, details: true },
		],
		[
			// The speed of the last run: hidden while the next one works.
			{ text: text(OWN.speed) && !state.running ? theme.fg("dim", text(OWN.speed)) : "", priority: 10 },
			{ text: cost ? theme.fg("muted", cost) : "", priority: 40, details: true },
		],
		theme,
		width,
	);

	const place = plainRow(state.home ? homeTilde(state.cwd, state.home) : state.cwd);
	// A third of the row, like the shortened model: long branch names fit wide terminals whole.
	const shownBranch = branch
		? plainRow(truncateToWidth(plainRow(branch), Math.max(1, Math.floor(width / 3)), "…"))
		: branch;
	const where = (dir: string) =>
		`${theme.fg("text", dir)}${shownBranch ? ` ${theme.fg("muted", `⎇ ${shownBranch}`)}` : ""}`;
	const usage = formatTokenUsage(state.usage);
	// Cache reads are re-reads of the conversation on every request: listed in the breakdown, not in the total.
	const spent = newPromptTokens(state.usage) + state.usage.output;
	// Nothing spent yet (a fresh session): no `0 tokens` placeholder.
	const tokens = spent > 0 || usage ? theme.fg("muted", `${formatTokens(spent)} tokens`) : "";
	const others = [...statuses]
		.filter(([key]) => !(Object.values(OWN) as string[]).includes(key))
		.sort(([a], [b]) => a.localeCompare(b));
	const bottomParts: Part[] = [
		{ text: where(place), priority: 100, keep: true, short: where(plainRow(path.basename(state.cwd))) },
		// Session names come from anywhere (RPC, other extensions); Octocode strips only newlines.
		{ text: state.sessionName ? theme.fg("muted", plainRow(state.sessionName)) : "", priority: 50 },
		{
			text: usage && tokens ? `${tokens} ${theme.fg("dim", `(${usage})`)}` : tokens,
			...(tokens ? { short: tokens } : {}),
			priority: 80,
			details: true,
		},
		{
			// Shown once there is one: zero compactions is the normal state, not news.
			text: state.compactions
				? theme.fg("muted", `${state.compactions} compaction${state.compactions === 1 ? "" : "s"}`)
				: "",
			priority: 75,
		},
		// Keep the workspace entry point when counts no longer fit; location and active-work statuses still win.
		{ text: status(OWN.backlog), priority: 20, keep: true, short: theme.fg("dim", "/web") },
		{ text: status(OWN.steps), priority: 76, keep: true, details: true },
		...others.map(([key, entry]) => ({
			text: status(key),
			priority: entry.tone === "error" ? 110 : entry.tone === "warning" ? 105 : 20,
			keep: entry.tone === "error" || entry.tone === "warning",
			details: true,
		})),
	];
	let bottom = fitFooterLine(bottomParts, [], theme, width);
	const detailsHidden = top.detailsHidden || bottom.detailsHidden;
	const detailsRoute = width < 9 ? "/status" : "… /status";
	if (detailsHidden) {
		bottom = fitFooterLine(
			[...bottomParts, { text: theme.fg("dim", detailsRoute), priority: 101, keep: true }],
			[],
			theme,
			width,
		);
	}
	const lines = [top.line, bottom.line];
	// Overflow alerts get two text rows and one explicit details route. A long extension status must not fill the screen.
	if (width > 1) {
		const alerts = [...statuses]
			.filter(([key, entry]) => key !== PERMISSION_ID && (entry.tone === "error" || entry.tone === "warning"))
			.sort(([, a], [, b]) => Number(b.tone === "error") - Number(a.tone === "error"))
			.filter(([key]) => {
				const shown = status(key);
				return shown && !lines.some((line) => line.includes(shown));
			});
		let remainingRows = 2;
		let omitted = 0;
		for (const [key, entry] of alerts) {
			if (remainingRows === 0) {
				omitted++;
				continue;
			}
			const alert = paintStatus({ text: `${entry.tone}: ${text(key)}`, tone: entry.tone }, theme);
			const clipped = truncateToWidth(alert, width * remainingRows, "…");
			const wrapped = wrapTextWithAnsi(clipped, width);
			const rows = wrapped.slice(0, remainingRows);
			lines.push(...rows);
			remainingRows -= rows.length;
			if (clipped !== alert || wrapped.length > rows.length) omitted++;
		}
		const needsRoute = width >= 7 && detailsHidden && !lines.some((line) => line.includes("/status"));
		if (omitted > 0 || needsRoute) {
			const route = omitted > 0 ? `+${omitted} alerts · /status` : detailsRoute;
			lines.push(truncateToWidth(theme.fg(omitted > 0 ? "warning" : "dim", route), width, "…"));
		}
	}
	return lines;
}

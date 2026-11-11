import path from "node:path";
import { truncateToWidth, visibleWidth } from "@octocodeai/octocode-tui/text";
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

/**
 * Octocode's two-line footer, in the order other coding agents converged on: line 1 is what the agent is and is doing
 * (model, permission mode, thinking, context, running agents, bash jobs, queued messages and a running hook; run time,
 * speed and cost on the right). Line 2 shows cwd, branch, session name, total tokens, compactions and other statuses.
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
type Paint = Pick<Theme, "fg" | "bold">;

/** Status keys this footer places itself; any other extension's status is appended to line 2. */
const OWN = { permission: PERMISSION_ID, ...STATUS } as const;
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
interface Part {
	text: string;
	priority: number;
	keep?: boolean;
	short?: string;
}

/** Text drawn without colour (a model id, a path, a branch): every terminal control removed, on one row. */
const plainRow = (text: string) => styledLine(sanitizeTerminalText(text));

/** Joins the left parts with dim dots and pushes the right parts to the edge, shortening and dropping until it fits. */
function fitLine(left: Part[], right: Part[], theme: Paint, width: number): string {
	const dot = theme.fg("dim", " · ");
	let parts = [...left, ...right].filter((part) => part.text !== "");
	const full = new Map(parts.map((part) => [part, part.text]));
	const render = () => {
		const l = left
			.filter((part) => parts.includes(part))
			.map((part) => part.text)
			.join(dot);
		const r = right
			.filter((part) => parts.includes(part))
			.map((part) => part.text)
			.join(dot);
		if (!r) return l;
		return `${l}${" ".repeat(Math.max(2, width - visibleWidth(l) - visibleWidth(r)))}${r}`;
	};
	while (visibleWidth(render()) > width) {
		const next = parts
			.filter((part) => !part.keep || part.short !== undefined)
			.sort((a, b) => a.priority - b.priority)[0];
		if (!next) break;
		if (next.short !== undefined) {
			next.text = next.short;
			delete next.short;
		} else parts = parts.filter((part) => part !== next);
	}
	// A kept model or work status can itself exceed the row. Shorten lower-priority parts before the permission chip,
	// rather than clipping the complete row from the right and hiding its most important status.
	while (visibleWidth(render()) > width && parts.length > 1) {
		const next = [...parts].sort((a, b) => a.priority - b.priority)[0];
		const room = visibleWidth(next.text) - (visibleWidth(render()) - width);
		if (room > 1) next.text = truncateToWidth(next.text, room, theme.fg("dim", "…"));
		else parts = parts.filter((part) => part !== next);
	}
	// Shortening a later part can make room for an earlier label's full text again.
	for (const part of [...parts].sort((a, b) => b.priority - a.priority)) {
		const short = part.text;
		part.text = full.get(part)!;
		if (visibleWidth(render()) > width) part.text = short;
	}
	return truncateToWidth(render(), Math.max(0, width), theme.fg("dim", "…"));
}

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
	const top = fitLine(
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
			{ text: status(OWN.team), priority: 90, keep: true },
			{ text: status(OWN.running), priority: 90, keep: true },
			// Messages waiting for the run to end: the user should see theirs did not get lost.
			{ text: status(OWN.queued), priority: 85, keep: true },
			// Last of the left parts: its clock grows, so nothing else on the row moves with it.
			{ text: status(OWN.hooks), priority: 80, keep: true },
		],
		[
			// The speed of the last run: hidden while the next one works.
			{ text: text(OWN.speed) && !state.running ? theme.fg("dim", text(OWN.speed)) : "", priority: 10 },
			{ text: cost ? theme.fg("muted", cost) : "", priority: 40 },
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
	const bottom = fitLine(
		[
			{ text: where(place), priority: 100, keep: true, short: where(plainRow(path.basename(state.cwd))) },
			// Session names come from anywhere (RPC, other extensions); Octocode strips only newlines.
			{ text: state.sessionName ? theme.fg("muted", plainRow(state.sessionName)) : "", priority: 50 },
			{
				text: usage && tokens ? `${tokens} ${theme.fg("dim", `(${usage})`)}` : tokens,
				...(tokens ? { short: tokens } : {}),
				priority: 80,
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
			...others.map(([key]) => ({ text: status(key), priority: 20 })),
		],
		[],
		theme,
		width,
	);
	return [top, bottom];
}

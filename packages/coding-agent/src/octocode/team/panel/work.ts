import { truncateToWidth, visibleWidth } from "@octocodeai/octocode-tui/text";
import type { Theme } from "../../../theme/theme.ts";
import { ENTITY } from "../../shared/entity.ts";
import { formatDuration, formatSpan } from "../../shared/format.ts";
import type { WorkKind, WorkRow } from "../../shared/running-work.ts";
import { fitName, safe } from "./compact.ts";

type Color = Parameters<Theme["fg"]>[0];

const GAP = "  ";
/** The type label's width in cells: the longest, `timer`. */
const LABEL_WIDTH = 5;
/** An id keeps at most this many cells, so a long name cannot take the row. */
const ID_MAX = 18;
/** The title and its detail need at least this many cells to be worth drawing. */
const TEXT_MIN = 8;

/**
 * The label and tone of each type: timers use the warning (yellow) tone, the rest the accent; a subagent is labelled
 * with the subagent mark, as in the team rows above. `mark` names a glyph the caller passes (`Marks`): this module stays
 * clear of the terminal package, which the headless session must not load.
 */
const TYPE: Record<WorkKind, { label: string; color: Color; mark: keyof Marks }> = {
	agent: { label: ENTITY.subagent, color: "accent", mark: "live" },
	bash: { label: "bash", color: "accent", mark: "live" },
	timer: { label: "timer", color: "warning", mark: "waiting" },
	external: { label: "ext", color: "accent", mark: "live" },
};

/** The glyphs in front of a row: presence (`GLYPH.live`) and waiting (`GLYPH.waiting`). */
export interface Marks {
	live: string;
	waiting: string;
}

const MINUTE_MS = 60_000;

/** Whole minutes of `ms`, rounded `down` (elapsed: never more than has passed) or up (time left: never less than remains); `<1m` below one. */
function wholeMinutes(ms: number, round: "down" | "up"): string {
	// Time left of a minute or less is `<1m`: its next repaint (the wake itself) shows `due`.
	const minutes = Math.max(0, round === "down" ? Math.floor(ms / MINUTE_MS) : Math.ceil(ms / MINUTE_MS));
	return minutes < (round === "down" ? 1 : 2) ? "<1m" : formatSpan(minutes * MINUTE_MS);
}

/**
 * The right-hand cell: a timer's time left, anything else its elapsed time. Empty when the row has no clock. `precise`
 * (the panel repaints every few moments, since a mark moves) shows seconds; otherwise whole minutes, which stay true
 * until the next minute repaint (`nextMinuteDelay`).
 */
function clock(row: WorkRow, now: number, precise: boolean): string {
	if (row.kind === "timer") {
		if (row.dueAt === undefined) return "";
		if (row.dueAt <= now) return "due";
		return `in ${precise ? formatSpan(row.dueAt - now) : wholeMinutes(row.dueAt - now, "up")}`;
	}
	if (row.startedAt === undefined) return "";
	return precise ? formatDuration(Math.max(0, now - row.startedAt)) : wholeMinutes(now - row.startedAt, "down");
}

/** The instant a row's minute count turns over: its start, or for a timer its wake. */
const phaseOf = (row: WorkRow) => (row.kind === "timer" ? row.dueAt : row.startedAt);

/** Past a minute boundary by this much, so a clock that may fire a tick early still finds the new minute. */
const BOUNDARY_PAD_MS = 50;

/**
 * Milliseconds until the next whole-minute change of the oldest row with a clock, or undefined when no row has one.
 * One repaint per minute, on that row's boundary: the other rows' minutes turn over at their own phase, so they can
 * read up to a minute behind, never ahead (elapsed rounds down, time left up).
 */
export function nextMinuteDelay(work: readonly WorkRow[], now: number): number | undefined {
	const phases = work.flatMap((row) => (phaseOf(row) === undefined ? [] : [phaseOf(row)!]));
	if (phases.length === 0) return undefined;
	const oldest = Math.min(...phases);
	const into = (((now - oldest) % MINUTE_MS) + MINUTE_MS) % MINUTE_MS;
	return MINUTE_MS - into + BOUNDARY_PAD_MS;
}

/** The title and, while there is room, ` › detail` after it. The title gives way last. */
function fitText(title: string, detail: string, room: number): [string, string] {
	const tail = detail ? ` › ${detail}` : "";
	if (visibleWidth(title) + visibleWidth(tail) <= room) return [title, tail];
	if (visibleWidth(title) >= room || room - visibleWidth(title) < 3 + 6) return [fitName(title, room), ""];
	// Cut the detail alone: cutting the whole tail would trim the separator's leading space and glue it to the title.
	return [title, ` › ${fitName(detail, room - visibleWidth(title) - 3)}`];
}

/** The block never takes more than this many rows when the terminal height is unknown. */
const MAX_WORK_ROWS = 6;

/**
 * One row per running item that is not a team member, grouped by type (agents the team does not list yet, bash jobs,
 * timers, external prompts): mark, type label, id, what it is (a reason or condition, then the command or note, dim)
 * and, right-aligned, its elapsed time or time left. At most `cap` rows (the terminal's budget, else `MAX_WORK_ROWS`);
 * the rest collapse into one `+N more` row. Every row fits `width`. Pure in (rows, now, width): it never repaints itself.
 */
export function workRows(
	work: readonly WorkRow[],
	now: number,
	theme: Theme,
	width: number,
	marks: Marks,
	cap?: number,
	/** Seconds in the clock cells (the default), or whole minutes. */
	precise = true,
): string[] {
	if (work.length === 0) return [];
	const limit = Math.max(1, cap ?? MAX_WORK_ROWS);
	// Past the cap the last row of it is the `+N more` row; with room for one row only, that row counts them all.
	const shown = work.length <= limit ? work : work.slice(0, limit - 1);
	const hidden = work.length - shown.length;
	if (shown.length === 0)
		return [truncateToWidth(theme.fg("muted", ` ${work.length} running`), Math.max(1, width), "…")];
	const ids = shown.map((row) => safe(row.id, ID_MAX));
	const idWidth = Math.max(...ids.map((id) => visibleWidth(id)));
	const clocks = shown.map((row) => clock(row, now, precise));
	const clockWidth = Math.max(...clocks.map((text) => visibleWidth(text)));
	const lines = shown.map((row, index) => {
		const type = TYPE[row.kind];
		const label = type.label + " ".repeat(Math.max(0, LABEL_WIDTH - visibleWidth(type.label)));
		const lead = ` ${theme.fg(type.color, marks[type.mark])} ${theme.fg(type.color, label)}${GAP}${theme.fg("text", ids[index] + " ".repeat(Math.max(0, idWidth - visibleWidth(ids[index]))))}`;
		const right = clocks[index] ? GAP + clocks[index].padStart(clockWidth) : "";
		const room = width - visibleWidth(lead) - GAP.length - visibleWidth(right);
		const [title, tail] = room >= TEXT_MIN ? fitText(safe(row.title), safe(row.detail), room) : ["", ""];
		const used = visibleWidth(title) + visibleWidth(tail);
		// The clock stays right-aligned to its column while the text is shorter than the room.
		const fill = right ? " ".repeat(Math.max(0, room - used)) : "";
		const text = title ? `${GAP}${theme.fg("text", title)}${theme.fg("dim", tail)}` : "";
		const clockColor: Color = row.kind === "timer" ? "warning" : "dim";
		return truncateToWidth(
			`${lead}${text}${fill}${right ? theme.fg(clockColor, right) : ""}`.trimEnd(),
			Math.max(1, width),
			"…",
		);
	});
	if (hidden > 0) lines.push(truncateToWidth(theme.fg("muted", ` +${hidden} more`), Math.max(1, width), "…"));
	return lines;
}

import type { TaskState } from "@octocodeai/octocode-contracts/backlogs";
import type { State } from "@octocodeai/octocode-contracts/snapshot";
import { sanitizeTerminalText } from "@octocodeai/octocode-common/sanitize";
import { itemTitle, withItemTitles } from "../render/item-titles.ts";
import { linkItem } from "../shared/text.ts";
import { PRIORITY_COLOR, STATE_COLOR, TASK_COLOR, type BoardTheme } from "./board-style.ts";

const ITEM = /^(\s*(?:- )?)(B\d+) \[(backlog|todo|ongoing|done) (p[0-3])([^\]]*)\] (.*)$/;
const TASK = /^(\s*(?:- )?)(T\d+) \[(todo|ongoing|done|dropped)\](.*)$/;
const FIELD = /^([A-Z][A-Za-z ]{1,24}):(.*)$/;
const TAIL =
	/(#[^\s()]+)|(\((?:blocked by|needs review|stale)[^)]*\))|(\((?:you|coordinator)\))|((?:⊂B\d+)|(?:\(from B\d+\)))/g;

type StyleTheme = Pick<BoardTheme, "fg" | "bold">;

const SUMMARY = /^(Added )?(B\d+)( → | · )(backlog|todo|ongoing|done|closed)( · )([\s\S]*)$/;

/**
 * A one-item `⎿` line (`B12 → done · Title`, `Added B3 · todo · Title`, `B4 · ongoing · Title`) with the id bold and
 * linked to the item's web page where a click is handled, the state in the board's colour and the title bright and
 * whole. Undefined for any other line. With the escape codes removed it is the plain summary on one line.
 */
export function styleBacklogSummary(theme: StyleTheme, summary: string, links?: boolean): string | undefined {
	const match = SUMMARY.exec(summary);
	if (!match) return undefined;
	const [, added, ref, arrow, state, dot, title] = match;
	const flat = sanitizeTerminalText(title).replace(/\s+/g, " ").trim();
	const color = state === "closed" ? "dim" : STATE_COLOR[state as State];
	return [
		added ? theme.fg("muted", added) : "",
		linkItem(theme.bold(ref), ref, links),
		theme.fg("dim", arrow),
		theme.bold(theme.fg(color, state)),
		flat ? `${theme.fg("dim", dot)}${theme.bold(theme.fg("text", flat))}` : "",
	].join("");
}

/** An item line's tail (`Title #tag ⊂B3 (blocked by B5) (you)`): tags and links dim, blockers warned, the holder accented. */
function tail(theme: StyleTheme, text: string): string {
	let out = "";
	let at = 0;
	for (const match of text.matchAll(TAIL)) {
		const [whole, tag, blocked, holder] = match;
		out += theme.fg("toolOutput", text.slice(at, match.index));
		out += theme.fg(
			tag ? "dim" : blocked ? "warning" : holder ? "accent" : "dim",
			blocked ? withItemTitles(whole, itemTitle) : whole,
		);
		at = match.index + whole.length;
	}
	return out + theme.fg("toolOutput", text.slice(at));
}

/**
 * The lines of a `backlog` result as the transcript draws them: each item line gets its state and priority in the board's
 * colours and its marks highlighted, task lines their state, `Key: value` lines a muted key. Only colour is added: with the
 * escape codes removed every line is the text the model read.
 */
export function styleBacklogLines(theme: StyleTheme, text: string, links?: boolean): string[] {
	return text.split("\n").map((line) => {
		const item = ITEM.exec(line);
		if (item) {
			const [, lead, ref, state, priority, kind, rest] = item;
			const color = PRIORITY_COLOR[Number(priority.slice(1))] ?? "text";
			return `${lead}${linkItem(theme.bold(ref), ref, links)} ${theme.fg("dim", "[")}${theme.fg(STATE_COLOR[state as State], state)} ${theme.fg(color, priority)}${theme.fg("dim", `${kind}]`)} ${tail(theme, rest)}`;
		}
		const task = TASK.exec(line);
		if (task) {
			const [, lead, ref, state, rest] = task;
			return `${lead}${theme.fg("dim", ref)} ${theme.fg("dim", "[")}${theme.fg(TASK_COLOR[state as TaskState], state)}${theme.fg("dim", "]")}${theme.fg("toolOutput", rest)}`;
		}
		const field = FIELD.exec(line);
		if (field)
			return `${theme.fg("muted", `${field[1]}:`)}${theme.fg("toolOutput", withItemTitles(field[2], itemTitle))}`;
		return theme.fg("toolOutput", withItemTitles(line, itemTitle));
	});
}

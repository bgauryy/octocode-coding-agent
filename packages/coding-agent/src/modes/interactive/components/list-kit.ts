/**
 * The pieces every picker, dialog and page puts around `ListView` (docs/tui-design.md, list contracts): the theme, the
 * row budget from the terminal, a two-column row, search that keeps the highlighted item, and the empty line that
 * names its search.
 */

import { type ListView, type ListViewTheme, truncateToWidth, visibleWidth } from "@octocodeai/octocode-tui";
import { keyText, noMatchMessage, type RankedHint } from "../../../theme/theme-tui-helpers.ts";
import { theme } from "../../../theme/theme.ts";
import { plainText } from "./styled-line.ts";

/** The colours of every list: accent cursor, muted foot and empty line. */
export function listTheme(): ListViewTheme {
	return {
		cursor: (text) => theme.fg("accent", text),
		position: (text) => theme.fg("muted", text),
		empty: (text) => theme.fg("muted", text),
		search: (text) => theme.fg("text", text),
	};
}

/**
 * Item rows a list may take: what the terminal leaves under `chrome` lines of title, hints and borders, between `min`
 * and `max`. Without a terminal (tests, a headless host) the list takes `max`.
 */
export function listRows(rows: number | undefined, chrome: number, max = 12, min = 3): number {
	if (!rows || rows <= 0) return max;
	return Math.max(min, Math.min(max, rows - chrome));
}

/**
 * Hand a key to a list and keep the same item highlighted when the key changed its search, so narrowing a query does
 * not lose the row the user was on. `handle` is the list's own key handler when the caller replaced `handleInput`.
 */
export function typeKeepingSelection<T>(
	list: ListView<T>,
	data: string,
	handle: (data: string) => void = (key) => list.handleInput(key),
): void {
	const before = list.getSelectedItem();
	const query = list.getQuery();
	handle(data);
	if (before === undefined || list.getQuery() === query) return;
	const index = list.getItems().indexOf(before);
	if (index >= 0) list.setSelectedIndex(index);
}

/** Set the list's empty line to `No <things>`, or `No <things> match "q"` while it searches (ListView adds `esc clears`). */
export function syncEmpty<T>(list: ListView<T>, things: string, recover?: readonly [key: string, verb: string]): void {
	list.setEmpty({ message: noMatchMessage(things, list.getQuery()), ...(recover ? { recover } : {}) });
}

/**
 * One dialog answer: `1.`–`9.` (dim), the label (accent and bold when selected), then an optional muted note, cut to
 * `width`. Label and note are drawn without terminal controls.
 */
export function numberedRow(
	label: string,
	index: number,
	state: { selected: boolean; width: number },
	note?: string,
): string {
	const number = index < 9 ? `${index + 1}. ` : "   ";
	const text = plainText(label);
	const shown = state.selected ? theme.fg("accent", theme.bold(text)) : theme.fg("text", text);
	const after = note ? `  ${theme.fg("muted", plainText(note))}` : "";
	return truncateToWidth(`${theme.fg("dim", number)}${shown}${after}`, state.width, "…");
}

/** The answer index a number key picks (`1` is the first), or undefined when `data` is no answer's number. */
export function answerNumber(data: string, count: number): number | undefined {
	if (!/^[1-9]$/.test(data)) return undefined;
	const index = Number(data) - 1;
	return index < count ? index : undefined;
}

/** A dialog's hint line: Enter's verb first, Esc's last. The rows show their numbers, so the hint does not. */
export function dialogHints(enterVerb: string, cancelVerb = "cancel"): RankedHint[] {
	return [
		[keyText("tui.select.confirm"), enterVerb, 1],
		[keyText("tui.select.cancel"), cancelVerb, 0],
	];
}

/** The label column width for `labels`: the widest, between `min` and `max`. */
export function labelColumn(labels: readonly string[], min: number, max: number): number {
	const widest = labels.reduce((width, label) => Math.max(width, visibleWidth(plainText(label))), 0);
	return Math.max(min, Math.min(max, widest));
}

/**
 * One list row: the label (accent when selected), then the muted description in the column after `column`, cut to
 * `width`. Both are untrusted text and drawn without terminal controls.
 */
export function columnRow(
	label: string,
	description: string | undefined,
	state: { selected: boolean; width: number },
	column: number,
): string {
	const text = plainText(label);
	const detail = description ? plainText(description) : "";
	const shown = state.selected ? theme.fg("accent", theme.bold(text)) : theme.fg("text", text);
	if (!detail || state.width < column + 12) return truncateToWidth(shown, state.width, "…");
	const head = truncateToWidth(shown, column, "…");
	const gap = " ".repeat(Math.max(1, column - visibleWidth(head)) + 1);
	return truncateToWidth(`${head}${gap}${theme.fg("muted", detail)}`, state.width, "…");
}

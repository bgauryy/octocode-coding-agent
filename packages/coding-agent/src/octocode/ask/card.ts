import { GLYPH, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@octocodeai/octocode-tui/text";
import { sanitizeTerminalText } from "../../../../common/src/sanitize.ts";
import type { DialogTheme } from "./dialog/theme.ts";
import { type AskView, PREVIEW_LINES } from "../shared/ask-view.ts";

/** The colours and weight the card uses: any terminal theme. */
export type CardTheme = Pick<DialogTheme, "fg" | "bold">;

/** What the card's owner tracks between key presses. */
export interface CardState {
	/** The highlighted row in `view.options`. */
	cursor: number;
	/** The body is shown whole and the details block open. */
	expanded: boolean;
	/** Multi-select: the rows ticked. */
	toggled?: ReadonlySet<number>;
	/** The answer given so far (a multi-question askUser). */
	answer?: string;
	warning?: string;
	/** The write-in editor's rendered lines while the user types in it. */
	editor?: string[];
	/** Draw no option rows (a free-text question while its editor is open). */
	hideRows?: boolean;
}

const WHY = "why it asks: ";

/** The key that opens the body and details: `tab`, which `app.tools.expand` (ctrl+o, the transcript's tools) leaves free. */
export const DETAILS_KEY = "\t";

/** Whether the card has anything `tab` would reveal at `width`. */
export function hasMore(view: AskView, width: number): boolean {
	return Boolean(view.notes?.length) || bodyLines(view, Math.max(1, width)).length > previewOf(view);
}

const previewOf = (view: AskView): number =>
	view.body?.collapsible ? Math.max(1, view.body.previewLines ?? PREVIEW_LINES) : Number.POSITIVE_INFINITY;

/** The body as wrapped screen lines (real line breaks kept, sanitized), quoted at `width`. */
function bodyLines(view: AskView, width: number): string[] {
	if (!view.body) return [];
	return view.body.text
		.split(/\r\n|\r|\n/)
		.flatMap((line) => wrapTextWithAnsi(sanitizeTerminalText(line), Math.max(1, width - 3)));
}

/** The index of the first recommended option, else 0: where the cursor starts. */
export const startRow = (view: AskView): number =>
	Math.max(
		0,
		view.options.findIndex((option) => option.recommended),
	);

/** The index of the write-in row, or -1. Rows after it (a multi-select's submit row) are actions, not answers. */
export const writeInRow = (view: AskView): number =>
	view.writeIn ? view.options.findIndex((option) => option.label === (view.writeIn || undefined)?.label) : -1;

/**
 * The card's lines at `width`, without borders or key hints (its owner adds them): the question in accent bold, dim
 * metadata, the body quoted with `│ ` and collapsed to its preview, the details block (one summary line until
 * expanded), then numbered options with their descriptions, the recommended one starred, and the write-in row.
 */
export function renderAskCard(view: AskView, state: CardState, theme: CardTheme, width: number): string[] {
	const w = Math.max(1, width);
	const lines: string[] = [];
	const add = (prefix: string, text: string): void => {
		const lead = truncateToWidth(prefix, Math.max(0, w - 1), "");
		const indent = visibleWidth(lead);
		wrapTextWithAnsi(text, Math.max(1, w - indent)).forEach((line, index) => {
			lines.push(`${index === 0 ? lead : " ".repeat(indent)}${line}`);
		});
	};
	// A card with a details block (a permission prompt) is compact until `tab`: one row per metadata line, the body's
	// preview with its remainder counted on its last row, one line saying why it asks, no blank row, and a description
	// only under the highlighted option.
	const compact = Boolean(view.notes?.length) && !state.expanded;
	const oneRow = (text: string): void => void lines.push(truncateToWidth(` ${text}`, w, "…"));
	for (const line of view.question.split(/\r\n|\r|\n/))
		add(" ", line ? theme.fg("accent", theme.bold(sanitizeTerminalText(line))) : "");
	if (compact && view.meta?.length)
		oneRow(theme.fg("dim", view.meta.map((line) => sanitizeTerminalText(line)).join(" · ")));
	else for (const line of view.meta ?? []) add(" ", theme.fg("dim", sanitizeTerminalText(line)));
	if (view.body) {
		if (view.body.label) add(" ", theme.fg("dim", sanitizeTerminalText(view.body.label)));
		const all = bodyLines(view, w);
		const limit = state.expanded ? all.length : previewOf(view);
		const rest = all.length - limit;
		all.slice(0, limit).forEach((line, index, shown) => {
			if (compact && rest > 0 && index === shown.length - 1) {
				const more = ` … +${rest} lines · tab`;
				const room = Math.max(1, w - visibleWidth(more) - 4);
				lines.push(`${truncateToWidth(` ${theme.fg("dim", "│")} ${line}`, room + 3, "…")}${theme.fg("dim", more)}`);
			} else lines.push(truncateToWidth(` ${theme.fg("dim", "│")} ${line}`, w, ""));
		});
		if (rest > 0 && !compact) add("   ", theme.fg("dim", `… +${rest} lines · tab show all`));
	}
	const notes = view.notes ?? [];
	if (notes.length && state.expanded)
		for (const note of notes)
			add(
				" ",
				theme.fg(note.tone === "warning" ? "warning" : "dim", `${GLYPH.note} ${sanitizeTerminalText(note.text)}`),
			);
	else if (notes.length) {
		const warn = notes.some((note) => note.tone === "warning");
		const asks = notes
			.map((note) => sanitizeTerminalText(note.text))
			.filter((text) => text.startsWith(WHY))
			.map((text) => text.slice(WHY.length))
			// The system's own reasons come before the mode's general one.
			.sort((a, b) => Number(a.endsWith(" mode asks)")) - Number(b.endsWith(" mode asks)")));
		const names = [...new Set(notes.map((note) => sanitizeTerminalText(note.text).split(":")[0]))].join(" · ");
		const summary = asks.length ? `asks: ${asks.join("; ")}` : names;
		const tail = " · tab details";
		const room = Math.max(1, w - visibleWidth(tail) - 3);
		lines.push(
			`${truncateToWidth(` ${GLYPH.note} ${summary}`, room + 3, "…").replace(/^(.*)$/, (m) => theme.fg(warn ? "warning" : "dim", m))}${theme.fg("dim", tail)}`,
		);
	}
	if (state.answer) add(" ", theme.fg("success", `Current answer: ${sanitizeTerminalText(state.answer)}`));
	if (!state.hideRows) {
		if (!compact) lines.push("");
		const write = writeInRow(view);
		view.options.forEach((option, index) => {
			const selected = index === state.cursor;
			const action = write >= 0 && index >= write;
			const box = view.multiSelect && !action ? (state.toggled?.has(index) ? "[x] " : "[ ] ") : "";
			const label = sanitizeTerminalText(option.label);
			const text =
				view.multiSelect && write >= 0 && index > write
					? `✓ ${label} (${state.toggled?.size ?? 0} selected)`
					: `${label}${index === write ? " ✎" : ""}`;
			const tone = selected ? "accent" : action ? "success" : option.tone === "danger" ? "error" : "text";
			const star = option.recommended ? theme.fg("accent", " ★") : "";
			const row = `${theme.fg(tone, `${index + 1}. ${box}${text}`)}${star}`;
			const description = option.description ? sanitizeTerminalText(option.description) : "";
			const lead = selected ? theme.fg("accent", "› ") : "  ";
			if (compact && (!selected || !description)) return add(lead, row);
			if (compact && visibleWidth(`  ${index + 1}. ${box}${text} ★ — ${description}`) <= w)
				return add(lead, `${row}${theme.fg("muted", ` — ${description}`)}`);
			add(lead, row);
			if (description) add("     ", theme.fg("muted", description));
		});
	}
	if (state.warning) {
		lines.push("");
		add(" ", theme.fg("warning", state.warning));
	}
	if (state.editor) {
		lines.push("");
		for (const line of state.editor) lines.push(truncateToWidth(` ${line}`, w, ""));
	}
	return lines;
}

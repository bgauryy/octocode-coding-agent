/**
 * The queued-messages list shown in place of the editor: one row per queued message in delivery order, single-key
 * actions on the selected row, and an embedded editor while a message is being edited. The caller owns the queue
 * and decides what each action does; this component only renders rows and reports keys.
 */

import {
	type Component,
	type Focusable,
	getKeybindings,
	GLYPH,
	type KeyId,
	matchesKey,
	truncateToWidth,
} from "@octocodeai/octocode-tui";
import { sanitizeTerminalText } from "../../../../../common/src/sanitize.ts";
import { ruleLine } from "../../../theme/dynamic-border.ts";
import { theme } from "../../../theme/theme.ts";
import { formatKeyText, moveHint, type RankedHint, renderHintLine } from "../../../theme/theme-tui-helpers.ts";

export interface QueueListRow {
	mode: "steer" | "followUp";
	text: string;
	/** Short notes shown after the preview, e.g. "1 attachment" or "extension". */
	notes: string[];
}

export type QueueListAction = "edit" | "remove" | "moveUp" | "moveDown" | "toggleMode";

const MODE_LABEL = { steer: "Next turn", followUp: "After run" } as const;
/** Rows shown at once; the window follows the selection. */
const MAX_VISIBLE = 8;

/** One line of a queued message: control characters and line breaks become spaces. */
function queuePreview(text: string): string {
	return sanitizeTerminalText(text)
		.replace(/[\n\t]+/g, " ")
		.trim();
}

export class QueueListComponent implements Component, Focusable {
	private rows: QueueListRow[] = [];
	private selected = 0;
	private editor: (Component & Focusable) | undefined;
	private _focused = false;
	private readonly onAction: (action: QueueListAction, index: number) => void;
	private readonly onClose: () => void;

	constructor(onAction: (action: QueueListAction, index: number) => void, onClose: () => void) {
		this.onAction = onAction;
		this.onClose = onClose;
	}

	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		if (this.editor) this.editor.focused = value;
	}

	get selectedIndex(): number {
		return this.selected;
	}

	get isEditing(): boolean {
		return this.editor !== undefined;
	}

	setRows(rows: QueueListRow[], selected = this.selected): void {
		this.rows = rows;
		this.selected = Math.max(0, Math.min(selected, rows.length - 1));
	}

	/** Show an editor in place of the rows; keys go to it until `hideEditor`. */
	showEditor(editor: Component & Focusable): void {
		this.editor = editor;
		editor.focused = this._focused;
	}

	hideEditor(): void {
		if (this.editor) this.editor.focused = false;
		this.editor = undefined;
	}

	invalidate(): void {
		this.editor?.invalidate();
	}

	handleInput(data: string): void {
		if (this.editor) {
			this.editor.handleInput?.(data);
			return;
		}
		const kb = getKeybindings();
		const key = (...ids: KeyId[]) => ids.some((id) => matchesKey(data, id));
		if (this.rows.length === 0) {
			if (kb.matches(data, "tui.select.cancel") || key("q")) this.onClose();
			return;
		}
		if (kb.matches(data, "tui.select.up")) this.selected = Math.max(0, this.selected - 1);
		else if (kb.matches(data, "tui.select.down")) this.selected = Math.min(this.rows.length - 1, this.selected + 1);
		else if (kb.matches(data, "tui.select.confirm")) this.onAction("edit", this.selected);
		else if (kb.matches(data, "tui.select.cancel")) this.onClose();
		else if (data === "K" || key("shift+up", "shift+k")) this.onAction("moveUp", this.selected);
		else if (data === "J" || key("shift+down", "shift+j")) this.onAction("moveDown", this.selected);
		else if (key("k")) this.selected = Math.max(0, this.selected - 1);
		else if (key("j")) this.selected = Math.min(this.rows.length - 1, this.selected + 1);
		else if (key("e")) this.onAction("edit", this.selected);
		else if (key("d", "delete", "backspace")) this.onAction("remove", this.selected);
		else if (key("s")) this.onAction("toggleMode", this.selected);
		else if (key("q")) this.onClose();
	}

	render(width: number): string[] {
		if (width <= 0) return [];
		if (this.editor) return this.editor.render(width);
		const border = ruleLine(Math.max(1, width));
		const fit = (line: string) => truncateToWidth(` ${line}`, width);
		const steer = this.rows.filter((row) => row.mode === "steer").length;
		const after = this.rows.length - steer;
		const lines = [
			border,
			fit(
				theme.fg("accent", theme.bold(width < 48 ? "Queued" : "Queued messages")) +
					theme.fg(
						"muted",
						width < 48 ? ` · ${steer} next · ${after} after` : ` · ${steer} next turn · ${after} after run`,
					),
			),
		];
		const start = Math.max(0, Math.min(this.selected - Math.floor(MAX_VISIBLE / 2), this.rows.length - MAX_VISIBLE));
		const end = Math.min(this.rows.length, start + MAX_VISIBLE);
		if (this.rows.length === 0) lines.push(fit(theme.fg("muted", "No queued messages")));
		if (start > 0) lines.push(fit(theme.fg("muted", `  … ${start} earlier`)));
		for (let index = start; index < end; index++) {
			const row = this.rows[index];
			const isSelected = index === this.selected;
			const label = theme.fg(row.mode === "steer" ? "accent" : "muted", MODE_LABEL[row.mode]);
			const notes = row.notes.length > 0 ? theme.fg("dim", ` (${row.notes.map(queuePreview).join(", ")})`) : "";
			const preview = queuePreview(row.text);
			const marker = isSelected ? theme.fg("accent", GLYPH.cursor) : " ";
			const text = isSelected ? theme.bold(preview) : theme.fg("text", preview);
			lines.push(fit(`${marker} ${theme.fg("dim", `${index + 1}.`)} ${label}  ${text}${notes}`));
		}
		if (end < this.rows.length) lines.push(fit(theme.fg("muted", `  … ${this.rows.length - end} more`)));
		const toggle = this.rows[this.selected]?.mode === "followUp" ? "next turn" : "after run";
		const kb = getKeybindings();
		const claimed = new Set(
			(["tui.select.up", "tui.select.down", "tui.select.confirm", "tui.select.cancel"] as const).flatMap((action) =>
				kb.getKeys(action),
			),
		);
		const editKey = formatKeyText(kb.getKeys("tui.select.confirm")[0] ?? "e");
		const closeKey = formatKeyText(kb.getKeys("tui.select.cancel")[0] ?? "q");
		const deleteKey = (["d", "delete", "backspace"] as const).find((key) => !claimed.has(key));
		const hints: RankedHint[] = [];
		if (this.rows.length > 1) hints.push(moveHint(5));
		if (this.rows.length > 0) {
			if (!claimed.has("shift+up") && !claimed.has("shift+down")) hints.push(["shift+↑↓", "reorder", 4]);
			if (kb.getKeys("tui.select.confirm").length > 0 || !claimed.has("e")) hints.push([editKey, "edit", 2]);
			if (!claimed.has("s")) hints.push(["s", toggle, 3]);
			if (deleteKey) hints.push([deleteKey, deleteKey === "d" ? "delete" : "remove", 1]);
		}
		if (this.rows.length === 0 || kb.getKeys("tui.select.cancel").length > 0 || !claimed.has("q"))
			hints.push([closeKey, "close", 0]);
		// A narrow terminal drops the least needed hints first, never the keys that delete and close.
		const hint = renderHintLine(hints, width, 1);
		lines.push(hint, border);
		return lines;
	}
}

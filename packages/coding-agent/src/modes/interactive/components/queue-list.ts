/**
 * The queued-messages list shown in place of the editor: one row per queued message in delivery order, single-key
 * actions on the selected row, and an embedded editor while a message is being edited. The caller owns the queue
 * and decides what each action does; this component only renders rows and reports keys.
 */

import {
	type Component,
	type Focusable,
	getKeybindings,
	type KeyId,
	matchesKey,
	stripTerminalSequences,
	truncateToWidth,
} from "@octocodeai/octocode-tui";
import { theme } from "../../../theme/theme.ts";
import { renderHintLine } from "../../../theme/theme-tui-helpers.ts";

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
	return stripTerminalSequences(text)
		.replace(/[\r\n\t\u2028\u2029]+/g, " ")
		.replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
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
		if (data === "K" || key("shift+up", "shift+k")) this.onAction("moveUp", this.selected);
		else if (data === "J" || key("shift+down", "shift+j")) this.onAction("moveDown", this.selected);
		else if (kb.matches(data, "tui.select.up") || key("k")) this.selected = Math.max(0, this.selected - 1);
		else if (kb.matches(data, "tui.select.down") || key("j"))
			this.selected = Math.min(this.rows.length - 1, this.selected + 1);
		else if (kb.matches(data, "tui.select.confirm") || key("e")) this.onAction("edit", this.selected);
		else if (key("d", "delete", "backspace")) this.onAction("remove", this.selected);
		else if (key("s")) this.onAction("toggleMode", this.selected);
		else if (kb.matches(data, "tui.select.cancel") || key("q")) this.onClose();
	}

	render(width: number): string[] {
		if (this.editor) return this.editor.render(width);
		const border = theme.fg("border", "─".repeat(Math.max(1, width)));
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
		if (start > 0) lines.push(fit(theme.fg("muted", `  … ${start} earlier`)));
		for (let index = start; index < end; index++) {
			const row = this.rows[index];
			const isSelected = index === this.selected;
			const label = theme.fg(row.mode === "steer" ? "accent" : "muted", MODE_LABEL[row.mode]);
			const notes = row.notes.length > 0 ? theme.fg("dim", ` (${row.notes.join(", ")})`) : "";
			const preview = queuePreview(row.text);
			const marker = isSelected ? theme.fg("accent", "›") : " ";
			const text = isSelected ? theme.bold(preview) : theme.fg("text", preview);
			lines.push(fit(`${marker} ${theme.fg("dim", `${index + 1}.`)} ${label}  ${text}${notes}`));
		}
		if (end < this.rows.length) lines.push(fit(theme.fg("muted", `  … ${this.rows.length - end} more`)));
		const toggle = this.rows[this.selected]?.mode === "followUp" ? "next turn" : "after run";
		// A narrow terminal drops the least needed hints first, never the keys that delete and close. The arrows that move
		// the cursor are not named: every list moves with them.
		const hint = renderHintLine(
			[
				["shift+↑↓", "reorder", 4],
				["enter", "edit", 2],
				["s", toggle, 3],
				["d", "delete", 1],
				["esc", "close", 0],
			],
			width,
			1,
		);
		lines.push(hint, border);
		return lines;
	}
}

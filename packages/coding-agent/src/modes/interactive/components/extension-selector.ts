/**
 * Generic selector component for extensions.
 * Displays a list of string options with keyboard navigation.
 */

import { Container, getKeybindings, GLYPH, Spacer, Text, type TUI } from "@octocodeai/octocode-tui";
import { theme } from "../../../theme/theme.ts";
import { CountdownTimer } from "./countdown-timer.ts";
import { DynamicBorder } from "../../../theme/dynamic-border.ts";
import { HintBar, renderHintLine } from "./hint-bar.ts";
import { keyText } from "./keybinding-hints.ts";
import { DETAILS_KEY, hasMore, renderAskCard, startRow, writeInRow } from "../../../octocode/ask/card.ts";
import type { AskView } from "../../../octocode/shared/ask-view.ts";

interface ExtensionSelectorOptions {
	tui?: TUI;
	timeout?: number;
	onToggleToolsExpanded?: () => void;
	description?: string;
	/**
	 * Text the user types while the dialog is open. When set, printable keys build a one-line message (Backspace edits
	 * it, Enter hands it to this callback, Esc clears it) instead of being dropped, and `j`/`k` no longer move the
	 * selection (the arrows still do). The dialog stays open: only the dialog's own Enter, with no message typed, selects.
	 */
	onSubmitText?: (text: string) => void;
	/**
	 * Draw the dialog as an ask card (`octocode/ask/card.ts`) instead of the plain title: used only when its option labels
	 * are exactly `options`. Its write-in row opens an inline editor; Enter there hands the note to `onWriteIn` and
	 * selects the row, Esc returns to the options.
	 */
	ask?: AskView;
	/** Receives the note typed in the card's write-in, just before the write-in row is selected. */
	onWriteIn?: (note: string) => void;
}

export class ExtensionSelectorComponent extends Container {
	private options: string[];
	private selectedIndex = 0;
	private listContainer: Container;
	private onSelectCallback: (option: string) => void;
	private onCancelCallback: () => void;
	private titleText: Text;
	private baseTitle: string;
	private tui: TUI | undefined;
	private countdown: CountdownTimer | undefined;
	private onToggleToolsExpanded: (() => void) | undefined;
	private onSubmitText: ((text: string) => void) | undefined;
	private draft = "";
	private draftText: Text | undefined;
	private readonly ask: AskView | undefined;
	private readonly onWriteIn: ((note: string) => void) | undefined;
	private expanded = false;
	/** The write-in's text while it is open. */
	private writing: string | undefined;
	private countdownLabel = "";

	constructor(
		title: string,
		options: string[],
		onSelect: (option: string) => void,
		onCancel: () => void,
		opts?: ExtensionSelectorOptions,
	) {
		super();

		this.options = options;
		this.tui = opts?.tui;
		this.onSelectCallback = onSelect;
		this.onCancelCallback = onCancel;
		this.onToggleToolsExpanded = opts?.onToggleToolsExpanded;
		this.onSubmitText = opts?.onSubmitText;
		this.baseTitle = title;
		const ask = opts?.ask;
		this.onWriteIn = opts?.onWriteIn;
		this.ask =
			ask && ask.options.length === options.length && ask.options.every((o, i) => o.label === options[i])
				? ask
				: undefined;
		if (this.ask) this.selectedIndex = startRow(this.ask);

		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));

		this.titleText = new Text(this.ask ? "" : theme.fg("accent", theme.bold(title)), 1, 0);
		if (this.ask) this.addChild({ render: (width: number) => this.renderCard(width), invalidate: () => {} });
		else this.addChild(this.titleText);
		if (opts?.description) {
			this.addChild(new Spacer(1));
			this.addChild(new Text(theme.fg("text", opts.description), 1, 0));
		}
		this.addChild(new Spacer(1));

		if (opts?.timeout && opts.timeout > 0 && opts.tui) {
			this.countdown = new CountdownTimer(
				opts.timeout,
				opts.tui,
				(s) => {
					this.countdownLabel = `${s}s left`;
					if (!this.ask) this.titleText.setText(theme.fg("accent", theme.bold(`${this.baseTitle} (${s}s)`)));
				},
				() => this.onCancelCallback(),
			);
		}

		this.listContainer = new Container();
		this.addChild(this.listContainer);
		this.addChild(new Spacer(1));
		if (this.onSubmitText) {
			this.draftText = new Text("", 1, 0);
			this.addChild(this.draftText);
			this.addChild(new Spacer(1));
			this.updateDraft();
		}
		if (!this.ask)
			this.addChild(
				new HintBar([
					[keyText("tui.select.confirm"), "select", 1],
					[keyText("tui.select.cancel"), "cancel", 0],
				]),
			);
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());

		this.updateList();
	}

	/** The ask card with its key hints (they depend on the width: `tab` is offered only when it reveals something). */
	private renderCard(width: number): string[] {
		const ask = this.ask as AskView;
		const editor =
			this.writing === undefined
				? undefined
				: [
						`${theme.fg("dim", `${(ask.writeIn || undefined)?.title ?? "Write"}: `)}${theme.fg("text", this.writing)}${theme.fg("accent", "▏")}`,
					];
		const lines = renderAskCard(
			ask,
			{ cursor: this.selectedIndex, expanded: this.expanded, ...(editor ? { editor } : {}) },
			theme,
			width - 2,
		).map((line) => ` ${line}`);
		const hints = renderHintLine(
			this.writing !== undefined
				? [
						[keyText("tui.select.confirm"), "send", 1],
						[keyText("tui.select.cancel"), "back", 0],
					]
				: [
						[`${keyText("tui.select.confirm")}/1-${Math.min(9, this.options.length)}`, "choose", 1],
						...(hasMore(ask, width - 2) ? [["tab", this.expanded ? "less" : "details", 2] as const] : []),
						[keyText("tui.select.cancel"), "cancel", 0],
					],
			width,
		);
		const after = this.countdownLabel ? ` ${theme.fg("dim", this.countdownLabel)}` : "";
		return [...lines, ...(after ? [after] : []), "", hints];
	}

	/** Ask mode's own keys: the write-in's editing, `tab`, and digits that move the cursor. True when the key was used. */
	private handleAskInput(keyData: string, kb: ReturnType<typeof getKeybindings>): boolean {
		const ask = this.ask;
		if (!ask) return false;
		if (this.writing !== undefined) {
			const typed = this.typedText(keyData);
			if (typed !== undefined) this.writing += typed;
			else if (keyData === "\x7f") this.writing = Array.from(this.writing).slice(0, -1).join("");
			else if (kb.matches(keyData, "tui.select.cancel")) this.writing = undefined;
			else if (kb.matches(keyData, "tui.select.confirm") || keyData === "\n") {
				const label = this.options[this.selectedIndex];
				this.onWriteIn?.(this.writing.trim());
				this.writing = undefined;
				if (label) this.onSelectCallback(label);
			}
			this.tui?.requestRender();
			return true;
		}
		if (keyData === DETAILS_KEY) this.expanded = !this.expanded;
		else if (!this.draft && /^[1-9]$/.test(keyData) && Number(keyData) <= this.options.length)
			this.selectedIndex = Number(keyData) - 1;
		else if (
			(kb.matches(keyData, "tui.select.confirm") || keyData === "\n") &&
			!this.draft &&
			this.selectedIndex === writeInRow(ask)
		)
			this.writing = "";
		else return false;
		this.tui?.requestRender();
		return true;
	}

	private updateList(): void {
		this.listContainer.clear();
		// The card draws its own option rows from the cursor.
		if (this.ask) {
			this.tui?.requestRender();
			return;
		}
		for (let i = 0; i < this.options.length; i++) {
			const isSelected = i === this.selectedIndex;
			const text = isSelected
				? theme.fg("accent", `${GLYPH.cursor} `) + theme.fg("accent", this.options[i])
				: `  ${theme.fg("text", this.options[i])}`;
			this.listContainer.addChild(new Text(text, 1, 0));
		}
	}

	private updateDraft(): void {
		this.draftText?.setText(
			this.draft
				? `${theme.fg("dim", "Message: ")}${theme.fg("text", this.draft)}${theme.fg("accent", "▏")}`
				: theme.fg("dim", "Type to message the agent; Enter sends it and does not select."),
		);
	}

	/** The text a key press types, or undefined for a control key or escape sequence. Bracketed paste carries its text. */
	private typedText(keyData: string): string | undefined {
		const pasted = /^\x1b\[200~([\s\S]*)\x1b\[201~$/.exec(keyData);
		const text = pasted ? pasted[1].replace(/\s*[\r\n]+\s*/g, " ") : keyData;
		// C0 controls, DEL and escape sequences are keys, not text.
		return text && !/[\x00-\x1f\x7f]/.test(text) ? text : undefined;
	}

	private handleDraftInput(keyData: string, kb: ReturnType<typeof getKeybindings>): boolean {
		const typed = this.typedText(keyData);
		if (typed !== undefined) {
			this.draft += typed;
		} else if (this.draft && keyData === "\x7f") {
			this.draft = Array.from(this.draft).slice(0, -1).join("");
		} else if (
			this.draft &&
			(kb.matches(keyData, "tui.select.cancel") || kb.matches(keyData, "tui.editor.deleteToLineStart"))
		) {
			this.draft = "";
		} else if (this.draft && (kb.matches(keyData, "tui.select.confirm") || keyData === "\n")) {
			const text = this.draft.trim();
			this.draft = "";
			if (text) this.onSubmitText?.(text);
		} else {
			return false;
		}
		this.updateDraft();
		this.tui?.requestRender();
		return true;
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		if (this.handleAskInput(keyData, kb)) return;
		if (this.onSubmitText && this.handleDraftInput(keyData, kb)) return;
		const vimKeys = !this.onSubmitText;
		if (kb.matches(keyData, "app.tools.expand")) {
			this.onToggleToolsExpanded?.();
		} else if (kb.matches(keyData, "tui.select.up") || (vimKeys && keyData === "k")) {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			this.updateList();
		} else if (kb.matches(keyData, "tui.select.down") || (vimKeys && keyData === "j")) {
			this.selectedIndex = Math.min(this.options.length - 1, this.selectedIndex + 1);
			this.updateList();
		} else if (kb.matches(keyData, "tui.select.confirm") || keyData === "\n") {
			const selected = this.options[this.selectedIndex];
			if (selected) this.onSelectCallback(selected);
		} else if (kb.matches(keyData, "tui.select.cancel")) {
			this.onCancelCallback();
		}
	}

	dispose(): void {
		this.countdown?.dispose();
	}
}

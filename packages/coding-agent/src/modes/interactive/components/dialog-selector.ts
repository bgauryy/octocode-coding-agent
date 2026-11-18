/**
 * The dialog of features (`ui.select`, confirmations): a title and its named answers on a `ListView`, numbered `1.`–`9.`,
 * or an ask card. A click selects an answer and a second click on it confirms, except in a confirmation (its safe
 * answer first) or a dialog marked destructive, which only the keyboard confirms. The wheel moves one answer.
 */

import {
	Container,
	CountdownTimer,
	getKeybindings,
	ListView,
	Spacer,
	type TUI,
	Text,
	type TuiMouseEvent,
} from "@octocodeai/octocode-tui";
import { theme } from "../../../theme/theme.ts";
import { DynamicBorder } from "../../../theme/dynamic-border.ts";
import { HintBar, keyText, renderHintLine } from "../../../theme/theme-tui-helpers.ts";
import { listTheme, numberedRow } from "./list-kit.ts";
import {
	CardPointer,
	clickMayConfirm,
	DETAILS_KEY,
	hasMore,
	renderAskCard,
	startRow,
	writeInRow,
} from "../../../octocode/ask/card.ts";
import type { AskView } from "../../../octocode/shared/ask-view.ts";

interface DialogSelectorOptions {
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
	/** The answers act on something that cannot be undone: a click only selects, Enter confirms. */
	destructive?: boolean;
}

export { clickMayConfirm };

interface Answer {
	label: string;
	index: number;
}

export class DialogSelectorComponent extends Container {
	private options: string[];
	private selectedIndex = 0;
	private readonly list: ListView<Answer>;
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
	private readonly clickConfirms: boolean;
	/** The card line of each option's first row, from the last render (`CardState.rowLines`). */
	private readonly cardRows: number[] = [];
	private readonly pointer = new CardPointer();

	constructor(
		title: string,
		options: string[],
		onSelect: (option: string) => void,
		onCancel: () => void,
		opts?: DialogSelectorOptions,
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
		this.clickConfirms = clickMayConfirm(options, opts?.destructive);

		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));

		this.titleText = new Text(this.ask ? "" : theme.fg("accent", theme.bold(title)), 1, 0);
		if (this.ask)
			this.addChild({
				render: (width: number) => this.renderCard(width),
				invalidate: () => {},
				handleMouse: (event: TuiMouseEvent) => this.cardMouse(event),
			});
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

		this.list = new ListView<Answer>({
			items: options.map((label, index) => ({ label, index })),
			maxRows: Math.max(1, Math.min(options.length, 12)),
			theme: listTheme(),
			empty: { message: "No answers" },
			clickConfirms: this.clickConfirms,
			row: (answer, state) => numberedRow(answer.label, answer.index, state),
		});
		this.list.onSelect = (answer) => this.onSelectCallback(answer.label);
		this.list.onSelectionChange = (answer) => {
			this.selectedIndex = answer.index;
			this.tui?.requestRender();
		};
		if (!this.ask) this.addChild(this.list);
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
			{
				cursor: this.selectedIndex,
				expanded: this.expanded,
				rowLines: this.cardRows,
				...(editor ? { editor } : {}),
			},
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
						[`1-${Math.min(9, this.options.length)}`, "pick", 3],
						[keyText("tui.select.confirm"), this.selectedIndex === writeInRow(ask) ? "write" : "confirm", 1],
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

	/** Point the list at the cursor; the card draws its own option rows from it. */
	private updateList(): void {
		if (!this.ask) this.list.setSelectedIndex(this.selectedIndex);
		this.tui?.requestRender();
	}

	/** Mouse on the answers; the wheel moves the ask card's cursor wherever the pointer is on the dialog. */
	override handleMouse(event: TuiMouseEvent): ReturnType<Container["handleMouse"]> {
		if (this.draft || this.writing !== undefined) return undefined;
		if (this.ask && event.type === "wheel") {
			const result = this.cardMouse(event);
			const origin = { originX: event.screenX - event.x, originY: event.screenY - event.y };
			return result && { ...result, target: { component: this, ...origin, width: event.width, height: event.height } };
		}
		return super.handleMouse(event);
	}

	/** The ask card's options under the mouse (`CardPointer`); a confirming click acts as Enter does. */
	private cardMouse(event: TuiMouseEvent): { handled: true; focus?: true } | undefined {
		const ask = this.ask;
		if (!ask) return undefined;
		const moved = this.pointer.handle(event, event.y, this.cardRows, this.selectedIndex, this.clickConfirms);
		if (!moved) return undefined;
		this.selectedIndex = moved.cursor;
		if (moved.confirm) this.confirmSelected(ask);
		this.tui?.requestRender();
		return event.type === "press" ? { handled: true, focus: true } : { handled: true };
	}

	/** Enter on the ask card: the write-in row opens its editor, any other answer is the dialog's answer. */
	private confirmSelected(ask: AskView): void {
		if (this.selectedIndex === writeInRow(ask)) this.writing = "";
		else {
			const label = this.options[this.selectedIndex];
			if (label) this.onSelectCallback(label);
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
		} else if (!this.ask && !this.draft && /^[1-9]$/.test(keyData) && Number(keyData) <= this.options.length) {
			this.selectedIndex = Number(keyData) - 1;
			this.updateList();
		} else if (
			!this.ask &&
			(["tui.select.pageUp", "tui.select.pageDown", "tui.select.home", "tui.select.end"] as const).some((id) =>
				kb.matches(keyData, id),
			)
		) {
			this.list.handleInput(keyData);
			this.selectedIndex = this.list.getSelectedIndex();
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

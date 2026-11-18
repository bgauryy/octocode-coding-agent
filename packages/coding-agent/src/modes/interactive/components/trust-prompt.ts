import { Container, getKeybindings, ListView, Spacer, Text } from "@octocodeai/octocode-tui";
import { theme } from "../../../theme/theme.ts";
import { DynamicBorder } from "../../../theme/dynamic-border.ts";
import { HintBar } from "../../../theme/theme-tui-helpers.ts";
import { clickMayConfirm } from "./dialog-selector.ts";
import { answerNumber, dialogHints, listTheme, numberedRow } from "./list-kit.ts";
import { plainText } from "./styled-line.ts";

/** One answer of a trust question: what it does, and the value it returns. */
export interface TrustPromptRow<T> {
	label: string;
	/** A muted phrase after the label: what happens next. */
	note?: string;
	value: T;
}

export interface TrustPromptOptions<T> {
	title: string;
	/** The folder the question is about, drawn under the title. */
	subject?: string;
	/** Paragraphs, each wrapped to the screen. */
	body: string[];
	/** A muted line under the body (the project file names found). */
	detail?: string;
	/** A muted line under the answers (why a choice is not offered). */
	footnote?: string;
	/** The answers, the safe one (`Not now`, `No`) first: it starts selected, so a bare Enter grants nothing. */
	rows: TrustPromptRow<T>[];
	/** Chosen by Esc. */
	onCancel: () => void;
	onChoose: (value: T) => void;
	/**
	 * Enter is ignored for this long after the question appears, so a key typed ahead (a second Enter after starting
	 * Octocode) cannot answer a question nobody looked at. Default 300.
	 */
	armDelayMs?: number;
}

/**
 * A short question about trust, drawn as a dialog: what is being decided, what it allows, and numbered answers with the
 * safe one first. A number key or the arrows move the cursor and Enter confirms; a click only selects, since the other
 * answers grant or record trust. Shared by the folder prompt and the worktree question. Every dynamic string is drawn
 * inert (`plainText`): a folder name can hold terminal controls, and this dialog decides trust.
 */
export class TrustPromptComponent<T> extends Container {
	private readonly list: ListView<TrustPromptRow<T>>;
	private readonly shownAt = Date.now();
	private settled = false;

	private readonly options: TrustPromptOptions<T>;

	constructor(options: TrustPromptOptions<T>) {
		super();
		this.options = options;
		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("accent", theme.bold(plainText(options.title))), 1, 0));
		if (options.subject) this.addChild(new Text(theme.bold(plainText(options.subject)), 1, 0));
		this.addChild(new Spacer(1));
		for (const paragraph of options.body) this.addChild(new Text(theme.fg("text", plainText(paragraph)), 1, 0));
		if (options.detail) {
			this.addChild(new Spacer(1));
			this.addChild(new Text(theme.fg("muted", plainText(options.detail)), 1, 0));
		}
		this.addChild(new Spacer(1));
		const rows = options.rows;
		this.list = new ListView<TrustPromptRow<T>>({
			items: rows,
			maxRows: Math.max(1, rows.length),
			theme: listTheme(),
			clickConfirms: clickMayConfirm(rows.map((row) => row.label)),
			row: (row, state) => numberedRow(row.label, rows.indexOf(row), state, row.note),
		});
		this.list.onSelect = (row) => this.answer(row);
		this.addChild(this.list);
		if (options.footnote) {
			this.addChild(new Spacer(1));
			this.addChild(new Text(theme.fg("muted", plainText(options.footnote)), 1, 0));
		}
		this.addChild(new Spacer(1));
		this.addChild(new HintBar(dialogHints("confirm")));
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());
	}

	/** The highlighted answer's value. */
	getSelected(): T | undefined {
		return this.list.getSelectedItem()?.value;
	}

	private answer(row: TrustPromptRow<T>): void {
		if (this.settled || Date.now() - this.shownAt < (this.options.armDelayMs ?? 300)) return;
		this.settled = true;
		this.options.onChoose(row.value);
	}

	handleInput(keyData: string): void {
		if (this.settled) return;
		const kb = getKeybindings();
		const picked = answerNumber(keyData, this.options.rows.length);
		if (picked !== undefined) this.list.setSelectedIndex(picked);
		else if (keyData === "\n") {
			const row = this.list.getSelectedItem();
			if (row) this.answer(row);
		} else if (kb.matches(keyData, "tui.select.cancel")) {
			this.settled = true;
			this.options.onCancel();
		} else this.list.handleInput(keyData);
	}
}

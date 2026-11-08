import { Container, getKeybindings, GLYPH, Spacer, Text } from "@octocodeai/octocode-tui";
import { theme } from "../../../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { HintBar } from "./hint-bar.ts";
import { keyText } from "./keybinding-hints.ts";
import { plainText } from "./styled-line.ts";

/** One answer of a trust question: a key to press, what it does, and the value it returns. */
export interface TrustPromptRow<T> {
	/** The key that chooses this row at once (`1`, `n`, `d`, `y`). */
	key: string;
	label: string;
	/** A dim phrase after the label: what happens next. */
	note?: string;
	value: T;
}

export interface TrustPromptOptions<T> {
	title: string;
	/** The folder the question is about, drawn under the title. */
	subject?: string;
	/** Paragraphs, each wrapped to the screen. */
	body: string[];
	/** A dim line under the body (the project file names found). */
	detail?: string;
	/** A dim line under the rows (why a choice is not offered). */
	footnote?: string;
	rows: TrustPromptRow<T>[];
	/** The highlighted row; Enter chooses it. */
	defaultIndex?: number;
	/** What Esc means, in the key line (default `not now`). */
	cancelLabel?: string;
	/** Chosen by Esc. */
	onCancel: () => void;
	onChoose: (value: T) => void;
	/**
	 * Enter is ignored for this long after the question appears, so a key typed ahead (a second Enter after starting
	 * Octocode) cannot trust a folder nobody looked at. Letters and digits always work. Default 300.
	 */
	armDelayMs?: number;
}

/**
 * A short question about trust: what is being decided, what it allows, and a few rows chosen by one key. Shared by the
 * folder prompt and the worktree question. Every dynamic string is drawn inert (`plainText`): a folder name can hold
 * terminal controls, and this dialog decides trust.
 */
export class TrustPromptComponent<T> extends Container {
	private selected: number;
	private readonly list = new Container();
	private readonly shownAt = Date.now();
	private settled = false;

	private readonly options: TrustPromptOptions<T>;

	constructor(options: TrustPromptOptions<T>) {
		super();
		this.options = options;
		this.selected = Math.min(Math.max(options.defaultIndex ?? 0, 0), Math.max(options.rows.length - 1, 0));
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
		this.addChild(this.list);
		if (options.footnote) {
			this.addChild(new Spacer(1));
			this.addChild(new Text(theme.fg("muted", plainText(options.footnote)), 1, 0));
		}
		this.addChild(new Spacer(1));
		const keys = options.rows.map((row) => row.key).join("/");
		this.addChild(
			new HintBar([
				[keys, "choose", 1],
				[keyText("tui.select.confirm"), "confirm", 2],
				[keyText("tui.select.cancel"), options.cancelLabel ?? "not now", 0],
			]),
		);
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());
		this.draw();
	}

	private draw(): void {
		this.list.clear();
		this.options.rows.forEach((row, index) => {
			const on = index === this.selected;
			const cursor = on ? theme.fg("accent", `${GLYPH.cursor} `) : "  ";
			const key = theme.fg(on ? "accent" : "muted", `[${row.key}]`);
			const label = on ? theme.fg("accent", plainText(row.label)) : theme.fg("text", plainText(row.label));
			const note = row.note ? `  ${theme.fg("muted", plainText(row.note))}` : "";
			this.list.addChild(new Text(`${cursor}${key} ${label}${note}`, 1, 0));
		});
	}

	private choose(value: T): void {
		if (this.settled) return;
		this.settled = true;
		this.options.onChoose(value);
	}

	handleInput(keyData: string): void {
		if (this.settled) return;
		const kb = getKeybindings();
		const byKey = this.options.rows.find((row) => row.key === keyData.toLowerCase());
		if (byKey) return this.choose(byKey.value);
		if (kb.matches(keyData, "tui.select.up") || keyData === "k") {
			this.selected = Math.max(0, this.selected - 1);
			this.draw();
		} else if (kb.matches(keyData, "tui.select.down") || keyData === "j") {
			this.selected = Math.min(this.options.rows.length - 1, this.selected + 1);
			this.draw();
		} else if (kb.matches(keyData, "tui.select.confirm") || keyData === "\n") {
			if (Date.now() - this.shownAt < (this.options.armDelayMs ?? 300)) return;
			const row = this.options.rows[this.selected];
			if (row) this.choose(row.value);
		} else if (kb.matches(keyData, "tui.select.cancel")) {
			if (this.settled) return;
			this.settled = true;
			this.options.onCancel();
		}
	}
}

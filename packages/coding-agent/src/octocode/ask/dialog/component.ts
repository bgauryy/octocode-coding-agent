import {
	type Editor,
	type KeybindingsManager,
	truncateToWidth,
	type TuiMouseEvent,
	visibleWidth,
	wrapTextWithAnsi,
} from "@octocodeai/octocode-tui";
import type { Question, Reply } from "@octocodeai/octocode-contracts";
import { ruleLine } from "../../../theme/dynamic-border.ts";
import { fitHints, hintText } from "../../../theme/theme-tui-helpers.ts";
import { Breath } from "./marks.ts";
import { type AskAnswer, answerOf } from "./answers.ts";
import { renderReview, tabsLine } from "./tabs.ts";
import { questionView } from "./view.ts";
import { CardPointer, clickMayConfirm, DETAILS_KEY, hasMore, renderAskCard, startRow } from "../card.ts";
import type { AskView } from "../../shared/ask-view.ts";
import type { DialogTheme } from "./theme.ts";
import { askHints } from "./hints.ts";
import { autoReplies, autoSeconds, Countdown, recommendedLabels } from "../countdown.ts";
import { countdownText } from "../../shared/ask-view.ts";

/** The dialog's state and keys; `tab === questions.length` is the Submit tab. */
export class AskDialog {
	private readonly keybindings: KeybindingsManager;
	private readonly isMulti: boolean;
	private readonly answers = new Map<number, AskAnswer>();
	private readonly replies = new Map<number, Reply>();
	private readonly toggled = new Map<number, Set<number>>();
	private readonly drafts = new Map<number, string>();
	private tab = 0;
	private cursor = 0;
	private expanded = false;
	private typing = false;
	private finished = false;
	private warning = "";
	private cache: string[] | undefined;
	private cacheWidth = 0;
	/** Where the card starts in the last frame and its option rows (`CardState.rowLines`), for the mouse. */
	private cardStart = 0;
	private readonly cardRows: number[] = [];
	private readonly pointer = new CardPointer();
	/** askUser's `timeout`: running until any key, click or wheel, an answer or the dialog's end. */
	private readonly countdown: Countdown | undefined;
	/** A confirmation's expiry: shown as a countdown that no key stops; when it ends every question times out. */
	private readonly expiry: { countdown: Countdown; label: string } | undefined;
	private readonly onAbort = () => this.finish();
	/** The unanswered tabs' `◇` breathes while any question waits. */
	private readonly breath = new Breath(() => this.repaint());

	readonly theme: DialogTheme;
	private readonly questions: readonly Question[];
	private readonly views: AskView[];
	private readonly editor: Editor;
	private readonly requestRender: () => void;
	private readonly done: (replies: Reply[]) => void;
	private readonly signal?: AbortSignal;
	constructor(
		questions: readonly Question[],
		keybindings: KeybindingsManager,
		theme: DialogTheme,
		editor: Editor,
		requestRender: () => void,
		done: (replies: Reply[]) => void,
		signal?: AbortSignal,
		expiry?: { seconds: number; label: string },
	) {
		this.questions = questions;
		this.views = questions.map(questionView);
		this.cursor = this.views[0] ? startRow(this.views[0]) : 0;
		this.keybindings = keybindings;
		this.theme = theme;
		this.editor = editor;
		this.requestRender = requestRender;
		this.done = done;
		this.signal = signal;

		this.isMulti = questions.length > 1;
		const seconds = autoSeconds(questions);
		if (seconds !== undefined) this.countdown = new Countdown(seconds, this.repaint, this.expire);
		if (expiry)
			this.expiry = { countdown: new Countdown(expiry.seconds, this.repaint, this.timeOut), label: expiry.label };
		this.breath.sync(this.isMulti);
		this.typing = questions[0]?.type === "text";
		editor.onSubmit = (value) => this.submitTyped(value);
		// The run was aborted (e.g. the user interrupted the agent) while the dialog was open.
		if (signal?.aborted) queueMicrotask(this.onAbort);
		else signal?.addEventListener("abort", this.onAbort, { once: true });
	}

	// Focusable: pass focus through to the editor so it emits the cursor marker (hardware cursor, IME placement).
	get focused(): boolean {
		return this.editor.focused;
	}

	set focused(value: boolean) {
		// The cached frame holds the cursor marker (or not): a focus change redraws.
		if (this.editor.focused !== value) this.cache = undefined;
		this.editor.focused = value;
	}

	invalidate(): void {
		this.cache = undefined;
		this.editor.invalidate();
	}

	dispose(): void {
		this.signal?.removeEventListener("abort", this.onAbort);
		this.countdown?.stop();
		this.expiry?.countdown.stop();
		this.breath.dispose();
	}

	/** A remote client started answering: the same hand-over to the person as a key press, so nothing is auto-taken. */
	hold(): void {
		if (this.countdown?.stop()) this.repaint();
	}

	private readonly repaint = (): void => {
		this.cache = undefined;
		this.requestRender();
	};

	/** The time ran out with nothing touched: every question takes its recommended options. */
	private readonly expire = (): void => {
		autoReplies(this.questions).forEach((reply, index) => this.replies.set(index, reply));
		this.finish();
	};

	private readonly timeOut = (): void => {
		this.questions.forEach((q, index) => this.replies.set(index, { id: q.id, cancelled: "timeout" }));
		this.finish();
	};

	private refresh(): void {
		this.breath.sync(this.isMulti && this.answers.size < this.questions.length);
		this.repaint();
	}

	private finish(): void {
		if (this.finished) return;
		this.finished = true;
		this.dispose();
		const why = this.signal?.aborted ? "aborted" : "declined";
		this.done(this.questions.map((q, index): Reply => this.replies.get(index) ?? { id: q.id, cancelled: why }));
	}

	/** Records question `index`'s answer from the option rows picked (their indexes) and the text typed, then moves on. */
	private answer(index: number, picked: number[], text?: string): void {
		const q = this.questions[index];
		const options = q.options ?? [];
		const rows = [...picked].sort((a, b) => a - b).map((at) => options[at]);
		this.answers.set(
			index,
			answerOf(
				q.question,
				rows.map((option) => option.label),
				text,
			),
		);
		this.replies.set(index, { id: q.id, picks: rows.map((option) => option.id), ...(text ? { text } : {}) });
		if (!this.isMulti) {
			this.finish();
			return;
		}
		this.tab = index < this.questions.length - 1 ? index + 1 : this.questions.length;
		this.cursor = this.views[this.tab] ? startRow(this.views[this.tab]) : 0;
		this.typing = this.questions[this.tab]?.type === "text";
		this.editor.setText(this.drafts.get(this.tab) ?? "");
		this.refresh();
	}

	private submitTyped(value: string): void {
		const text = value.trim();
		this.typing = false;
		this.editor.setText("");
		if (!text) {
			this.refresh();
			return;
		}
		this.drafts.set(this.tab, text);
		this.answer(this.tab, [...(this.toggled.get(this.tab) ?? [])], text);
	}

	private moveTab(step: number): void {
		this.tab = (this.tab + step + this.questions.length + 1) % (this.questions.length + 1);
		this.cursor = this.views[this.tab] ? startRow(this.views[this.tab]) : 0;
		this.warning = "";
		// A free-text question opens its editor (with the saved draft) however it is reached.
		this.typing = this.questions[this.tab]?.type === "text";
		this.editor.setText(this.typing ? (this.drafts.get(this.tab) ?? "") : "");
		this.refresh();
	}

	handleInput(data: string): void {
		if (this.finished) return;
		// Any key, click or wheel hands the dialog to the person: it never takes a half-given answer.
		if (this.countdown?.stop()) this.repaint();
		if (this.typing) {
			if (this.keybindings.matches(data, "tui.select.cancel")) {
				// Expanded: the editor's paste markers do not survive the `setText` that reopens this draft.
				this.drafts.set(this.tab, this.editor.getExpandedText());
				this.typing = false;
				this.editor.setText("");
			} else this.editor.handleInput(data);
			this.refresh();
			return;
		}
		if (this.isMulti && this.keybindings.matches(data, "app.ask.next")) {
			this.moveTab(1);
			return;
		}
		if (this.isMulti && this.keybindings.matches(data, "app.ask.previous")) {
			this.moveTab(-1);
			return;
		}
		if (this.keybindings.matches(data, "tui.select.cancel")) {
			this.finish();
			return;
		}
		if (this.tab === this.questions.length) {
			if (this.keybindings.matches(data, "tui.select.confirm") && this.answers.size === this.questions.length)
				this.finish();
			return;
		}
		this.questionKey(this.questions[this.tab], data);
	}

	private questionKey(q: Question, data: string): void {
		const count = this.views[this.tab].options.length;
		this.warning = "";
		if (this.keybindings.matches(data, "tui.select.up")) this.cursor = Math.max(0, this.cursor - 1);
		else if (this.keybindings.matches(data, "tui.select.down")) this.cursor = Math.min(count - 1, this.cursor + 1);
		// Number keys only move the cursor, so a stray digit never answers or toggles.
		else if (/^[1-9]$/.test(data) && Number(data) <= count) this.cursor = Number(data) - 1;
		// One question: tab shows a forwarded body whole (several questions move between tabs with it instead).
		else if (!this.isMulti && data === DETAILS_KEY) this.expanded = !this.expanded;
		else if (
			q.type === "multi" &&
			this.keybindings.matches(data, "app.ask.toggle") &&
			this.cursor < (q.options?.length ?? 0)
		)
			this.toggle();
		else if (this.keybindings.matches(data, "tui.select.confirm")) {
			this.choose(q);
			return;
		} else return;
		this.refresh();
	}

	handleMouse(event: TuiMouseEvent): { handled: true; focus?: true } | undefined {
		if (this.finished) return undefined;
		if (event.type === "press" || event.type === "click" || event.type === "wheel")
			if (this.countdown?.stop()) this.repaint();
		if (this.typing || this.tab === this.questions.length) return undefined;
		const options = this.views[this.tab].options;
		const mayConfirm = clickMayConfirm(
			options.map((option) => option.label),
			options.some((option) => option.tone === "danger"),
		);
		const moved = this.pointer.handle(event, event.y - this.cardStart, this.cardRows, this.cursor, mayConfirm);
		if (!moved) return undefined;
		this.warning = "";
		this.cursor = moved.cursor;
		if (moved.confirm) this.choose(this.questions[this.tab]);
		else this.refresh();
		return event.type === "press" ? { handled: true, focus: true } : { handled: true };
	}

	private toggle(): void {
		const set = this.toggled.get(this.tab) ?? new Set<number>();
		if (set.has(this.cursor)) set.delete(this.cursor);
		else set.add(this.cursor);
		this.toggled.set(this.tab, set);
	}

	private choose(q: Question): void {
		const count = q.options?.length ?? 0;
		if (this.cursor === count) {
			this.typing = true;
			this.editor.setText(this.drafts.get(this.tab) ?? "");
			this.refresh();
			return;
		}
		if (q.type !== "multi") {
			this.answer(this.tab, [this.cursor]);
			return;
		}
		// Multi-select: Enter on an option toggles it; only the Submit row answers.
		if (this.cursor < count) {
			this.toggle();
			this.refresh();
			return;
		}
		const set = this.toggled.get(this.tab);
		if (!set?.size) {
			this.warning = "Select at least one option, or write an answer";
			this.refresh();
			return;
		}
		this.answer(this.tab, [...set]);
	}

	render(width: number): string[] {
		if (this.cache && this.cacheWidth === width) return this.cache;
		const { theme, questions } = this;
		const w = Math.max(1, width);
		const lines: string[] = [];
		this.cardRows.splice(0);
		const add = (prefix: string, text: string) => {
			const lead = truncateToWidth(prefix, Math.max(0, w - 1), "");
			const indent = visibleWidth(lead);
			const wrapped = wrapTextWithAnsi(text, Math.max(1, w - indent));
			wrapped.forEach((line, index) => {
				lines.push(`${index === 0 ? lead : " ".repeat(indent)}${line}`);
			});
		};
		lines.push(ruleLine(w, (text) => theme.fg("border", text)));
		if (this.isMulti) {
			add(" ", tabsLine(theme, questions, this.answers, this.tab));
			lines.push("");
		}
		if (this.tab === questions.length) renderReview(add, lines, this.theme, questions, this.answers, this.keybindings);
		else this.renderQuestion(add, lines, w);
		lines.push("");
		const q = questions[this.tab];
		const hints = askHints(this.keybindings, {
			typing: this.typing,
			multi: this.isMulti,
			question: q?.type,
			more: q !== undefined && hasMore(this.views[this.tab], w),
			expanded: this.expanded,
		});
		add(" ", theme.fg("dim", hintText(fitHints(hints, Math.max(1, w - 1)))));
		lines.push(ruleLine(w, (text) => theme.fg("border", text)));
		this.cache = lines;
		this.cacheWidth = width;
		return lines;
	}

	private renderQuestion(add: (prefix: string, text: string) => void, lines: string[], width: number): void {
		const q = this.questions[this.tab];
		add(
			" ",
			this.theme.fg(
				"muted",
				`Question ${this.tab + 1} of ${this.questions.length}${q.type === "multi" ? " · Choose one or more, then Submit selection" : " · Choose one"}`,
			),
		);
		this.cardStart = lines.length;
		const card = renderAskCard(
			this.views[this.tab],
			{
				cursor: this.cursor,
				// Several questions use tab to move between them: their bodies show whole.
				expanded: this.expanded || this.isMulti,
				toggled: this.toggled.get(this.tab) ?? new Set<number>(),
				...(this.answers.get(this.tab) ? { answer: this.answers.get(this.tab)?.answer } : {}),
				...(this.warning ? { warning: this.warning } : {}),
				...(this.typing ? { editor: this.editor.render(Math.max(1, width - 2)) } : {}),
				hideRows: q.type === "text" && this.typing,
				...(this.countdown?.running
					? { countdown: countdownText(recommendedLabels(q), this.countdown.remaining()) }
					: this.expiry?.countdown.running
						? { countdown: countdownText([this.expiry.label], this.expiry.countdown.remaining()) }
						: {}),
				rowLines: this.cardRows,
			},
			this.theme,
			width,
		);
		lines.push(...card);
	}
}

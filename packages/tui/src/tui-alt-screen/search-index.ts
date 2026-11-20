import { Input } from "../components/input.ts";
import { getKeybindings } from "../keybindings.ts";
import type { Component, Focusable } from "../tui.ts";
import { truncateToWidth } from "../utils/truncate.ts";
import { visibleWidth } from "../utils/width.ts";
import { SearchCorpus } from "./search-corpus.ts";
import { type AltScreenSearchMatch, SearchMatcher } from "./search-matches.ts";

export type { AltScreenSearchMatch } from "./search-matches.ts";

function normalizeQuery(query: string): string {
	return query.normalize("NFC").replace(/\s+/gu, " ").trim();
}

interface AltScreenSearchResult {
	matches: AltScreenSearchMatch[];
	/** The matches differ from the last complete result: new rows or a new query. */
	changed: boolean;
	/** Every row is indexed and every match found; until then `matches` is empty. */
	complete: boolean;
	/** How much of the work is done, from 0 to 1. */
	progress: number;
	/** Some rows stand for collapsed content, whose text is not in the rows and so was not searched. */
	folded: boolean;
}

/** The empty result when collapsed blocks hold text the rows do not; shown only where the input keeps half the room. */
const NO_MATCHES_FOLDED = "No matches · collapsed blocks not searched";

/** Rows indexed between two clock reads. */
const ROWS_PER_CLOCK_READ = 64;

/**
 * The search over the rendered transcript. The rows are indexed once and kept: when rows change, the index is rebuilt
 * from the first changed row and the matches before it are kept. Work stops at a deadline and resumes on the next
 * call, so a long transcript never blocks a key; the result is then incomplete and holds no matches.
 */
export class AltScreenSearchIndex {
	/** The rows the index is for: a copy, so a caller's array changing in place cannot go unnoticed. */
	private readonly source: (string | undefined)[] = [];
	private readonly corpus = new SearchCorpus();
	private normalizedQuery: string | undefined;
	private matcher: SearchMatcher | undefined;
	private matches: AltScreenSearchMatch[] = [];
	/** Rows or the query changed since the last complete result. */
	private stale = true;

	search(lines: readonly string[], query: string, budgetMs = Number.POSITIVE_INFINITY): AltScreenSearchResult {
		this.sync(lines);
		const normalizedQuery = normalizeQuery(query);
		if (normalizedQuery !== this.normalizedQuery) {
			this.normalizedQuery = normalizedQuery;
			this.matcher = normalizedQuery ? new SearchMatcher(normalizedQuery) : undefined;
			this.stale = true;
		}
		return this.result(this.work(performance.now() + budgetMs));
	}

	/** Continue indexing and matching for up to `budgetMs`; returns whether the result is complete. */
	continue(budgetMs: number): boolean {
		return this.work(performance.now() + budgetMs);
	}

	private result(complete: boolean): AltScreenSearchResult {
		const folded = this.corpus.folds > 0;
		if (!complete) return { matches: [], changed: false, complete, progress: this.progress(), folded };
		const changed = this.stale;
		if (changed) this.matches = this.matcher?.matches ?? [];
		this.stale = false;
		return { matches: this.matches, changed, complete, progress: 1, folded };
	}

	private progress(): number {
		const rows = this.source.length === 0 ? 1 : this.corpus.rows / this.source.length;
		if (rows < 1) return 0.9 * rows;
		return 0.9 + 0.1 * (this.matcher?.progress(this.corpus) ?? 1);
	}

	/** Take the rows from the first one that changed. */
	private sync(lines: readonly string[]): void {
		const source = this.source;
		const limit = Math.min(source.length, lines.length);
		let first = 0;
		while (first < limit && source[first] === lines[first]) first++;
		if (first === lines.length && first === source.length) return;
		source.length = first;
		for (let row = first; row < lines.length; row++) source.push(lines[row]);
		const from = Math.min(first, this.corpus.rows);
		this.corpus.truncate(from);
		this.matcher?.invalidateFrom(this.corpus.textStartOfRow(from));
		this.stale = true;
	}

	private work(deadline: number): boolean {
		const { corpus, source } = this;
		while (corpus.rows < source.length) {
			corpus.appendRow(source[corpus.rows]);
			if (corpus.rows % ROWS_PER_CLOCK_READ === 0 && performance.now() >= deadline) return false;
		}
		return this.matcher?.step(corpus, deadline) ?? true;
	}
}

export function findAltScreenSearchMatches(lines: readonly string[], query: string): AltScreenSearchMatch[] {
	return new AltScreenSearchIndex().search(lines, query).matches;
}

export function getAltScreenSearchMatchKey(match: AltScreenSearchMatch): string {
	const first = match.segments[0];
	const last = match.segments[match.segments.length - 1];
	return first && last ? `${first.row}:${first.startCol}:${last.row}:${last.endCol}` : "";
}

export class AltScreenSearchComponent implements Component, Focusable {
	private readonly input = new Input({
		prompt: " ",
		placeholder: "Find in transcript",
		placeholderStyle: (text) => `\x1b[2m${text}\x1b[22m`,
	});
	private readonly onQueryChange: (query: string) => void;
	private readonly navigationButtonStyle: (text: string, hovered: boolean) => string;
	private resultCount = 0;
	private resultIndex = -1;
	/** The transcript has collapsed blocks, so a search without matches says their text was not searched. */
	private resultFolded = false;
	/** Indexing a long transcript: how far it got, from 0 to 1, or "pending" while the layout has no exact rows yet. */
	private searching: number | "pending" | undefined;
	private previousButtonStart = -1;
	private previousButtonEnd = -1;
	private nextButtonStart = -1;
	private nextButtonEnd = -1;
	private hoveredNavigationDirection: -1 | 1 | undefined;
	private _focused = false;

	constructor(
		onQueryChange: (query: string) => void,
		navigationButtonStyle: (text: string, hovered: boolean) => string = (text) => text,
	) {
		this.onQueryChange = onQueryChange;
		this.navigationButtonStyle = navigationButtonStyle;
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.input.focused = value;
	}

	setResult(index: number, count: number, folded = false): void {
		this.resultIndex = index;
		this.resultCount = count;
		this.resultFolded = folded;
		this.searching = undefined;
	}

	/** Show that the search is still running, `progress` from 0 to 1, instead of a result. */
	setSearching(progress: number | "pending"): void {
		this.searching = progress;
	}

	getNavigationDirectionAt(row: number, column: number): -1 | 1 | undefined {
		if (row !== 2) return undefined;
		if (column >= this.previousButtonStart && column < this.previousButtonEnd) return -1;
		if (column >= this.nextButtonStart && column < this.nextButtonEnd) return 1;
		return undefined;
	}

	setHoveredNavigationDirection(direction: -1 | 1 | undefined): boolean {
		if (direction === this.hoveredNavigationDirection) return false;
		this.hoveredNavigationDirection = direction;
		return true;
	}

	handleInput(data: string): void {
		const previous = this.input.getValue();
		this.input.handleInput(data);
		const query = this.input.getValue();
		if (query !== previous) this.onQueryChange(query);
	}

	invalidate(): void {
		this.input.invalidate();
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		const innerWidth = Math.max(0, safeWidth - 2);
		const formatKey = (key: string | undefined): string =>
			key
				? key
						.split("+")
						.map((part) => {
							if (process.platform === "darwin" && part.toLowerCase() === "alt") return "Option";
							return part.charAt(0).toUpperCase() + part.slice(1);
						})
						.join("+")
				: "Unbound";
		const keybindings = getKeybindings();
		const previousKey = formatKey(keybindings.getKeys("tui.altScreen.searchPrevious")[0]);
		const nextKey = formatKey(keybindings.getKeys("tui.altScreen.searchNext")[0]);
		const query = this.input.getValue();
		const result = !query.trim()
			? ""
			: this.searching !== undefined
				? this.searching === "pending"
					? "Searching…"
					: `Searching ${Math.floor(this.searching * 100)}%`
				: this.resultCount === 0
					? this.resultFolded && visibleWidth(NO_MATCHES_FOLDED) + 2 <= innerWidth / 2
						? NO_MATCHES_FOLDED
						: "No matches"
					: `${this.resultIndex + 1}/${this.resultCount}`;
		const resultSpace = Math.max(0, innerWidth - 3);
		const visibleResult = truncateToWidth(result, resultSpace, "");
		const resultText = visibleResult ? `\x1b[2m ${visibleResult} \x1b[22m` : "";
		const inputWidth = Math.max(0, innerWidth - visibleWidth(resultText));
		const inputLine = truncateToWidth(this.input.render(Math.max(1, inputWidth))[0] ?? "", inputWidth, "");
		const inputPadding = " ".repeat(Math.max(0, inputWidth - visibleWidth(inputLine)));
		const content = `${inputLine}${inputPadding}${resultText}`;

		let previousButton = `↑ ${previousKey}`;
		let nextButton = `↓ ${nextKey}`;
		let separator = " · ";
		const outerGapWidth = 1;
		const availableControlsWidth = Math.max(0, innerWidth - outerGapWidth * 2 - 1);
		let controlsWidth = visibleWidth(previousButton) + visibleWidth(separator) + visibleWidth(nextButton);
		if (controlsWidth > availableControlsWidth) {
			previousButton = "↑";
			nextButton = "↓";
			separator = " ";
			controlsWidth = visibleWidth(previousButton) + visibleWidth(separator) + visibleWidth(nextButton);
		}
		const showButtons = controlsWidth <= availableControlsWidth;
		const renderedButtons = showButtons
			? this.navigationButtonStyle(previousButton, this.hoveredNavigationDirection === -1) +
				separator +
				this.navigationButtonStyle(nextButton, this.hoveredNavigationDirection === 1)
			: "";
		const outerGapsWidth = showButtons ? outerGapWidth * 2 : 0;
		const rightRuleWidth = renderedButtons && innerWidth > controlsWidth + outerGapsWidth ? 1 : 0;
		const leftRuleWidth = Math.max(0, innerWidth - (showButtons ? controlsWidth : 0) - outerGapsWidth - rightRuleWidth);
		const previousStart = 1 + leftRuleWidth + outerGapWidth;
		this.previousButtonStart = showButtons ? previousStart : -1;
		this.previousButtonEnd = showButtons ? previousStart + visibleWidth(previousButton) : -1;
		this.nextButtonStart = showButtons ? this.previousButtonEnd + visibleWidth(separator) : -1;
		this.nextButtonEnd = showButtons ? this.nextButtonStart + visibleWidth(nextButton) : -1;

		if (safeWidth === 1) return ["┌", "│", "└"];
		const scope = innerWidth >= 19 ? " Loaded transcript " : "";
		return [
			`┌${scope}${"─".repeat(innerWidth - scope.length)}┐`,
			`│${content}│`,
			`└${"─".repeat(leftRuleWidth)}${renderedButtons ? " " : ""}${renderedButtons}${renderedButtons ? " " : ""}${"─".repeat(rightRuleWidth)}┘`,
		];
	}
}

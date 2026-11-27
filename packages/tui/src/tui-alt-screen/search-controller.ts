import {
	type AltScreenSearchMatch,
	AltScreenSearchComponent,
	AltScreenSearchIndex,
	getAltScreenSearchMatchKey,
} from "./search-index.ts";
import type { ScrollView } from "../components/scroll-view.ts";
import type { LayoutFrame } from "../layout/types.ts";
import { getScrollViewBox } from "../layout.ts";
import type { Component, OverlayHandle, OverlayOptions } from "../tui.ts";
import { applySearchHighlights, applySearchTextHighlight, pickSearchSelection } from "./search.ts";
import type { ActiveSearch, SgrMouseEvent } from "./types.ts";

/** Time a frame spends indexing and matching; the rest runs between frames, in slices that yield to input. */
const FRAME_SEARCH_BUDGET_MS = 10;
const SLICE_MS = 8;
/** While a long search runs between frames, its progress is repainted at most this often. */
const PROGRESS_REPAINT_MS = 100;

/** How search draws its navigation buttons and its matches; each has a default. */
export interface AltScreenSearchStyles {
	navigationButton?: (text: string, hovered: boolean) => string;
	match?: (text: string) => string;
	currentMatch?: (text: string) => string;
}

/** Alternate-screen state and operations the transcript search reads live. */
export interface AltScreenSearchHost {
	readonly implicitScrollView: ScrollView;
	getPrimaryScrollView(): ScrollView;
	showOverlay(component: Component, options: OverlayOptions): OverlayHandle;
	requestRender(): void;
}

/** Transcript search: the search overlay, its query and match navigation. */
export class AltScreenSearchController {
	activeSearch?: ActiveSearch;
	private readonly host: AltScreenSearchHost;
	/** The search whose index is being built between frames. */
	private indexing: ActiveSearch | undefined;
	/** A query without a selected match starts from the viewport once its row positions are exact. */
	private pendingAnchor: ActiveSearch | undefined;
	private readonly searchNavigationButtonStyle: (text: string, hovered: boolean) => string;
	private readonly matchStyle: (text: string) => string;
	private readonly currentMatchStyle: (text: string) => string;

	constructor(host: AltScreenSearchHost, styles: AltScreenSearchStyles = {}) {
		this.host = host;
		this.searchNavigationButtonStyle = styles.navigationButton ?? ((text) => text);
		this.matchStyle = styles.match ?? ((text) => `\x1b[4m${text}\x1b[24m`);
		this.currentMatchStyle = styles.currentMatch ?? ((text) => `\x1b[1;7m${text}\x1b[22;27m`);
	}

	/** Mark the active search's matches on a composed frame; the selected match takes the current-match style. */
	highlight(screen: string[], layout: LayoutFrame, width: number): string[] {
		return applySearchHighlights(
			screen,
			layout,
			this.activeSearch,
			this.host.implicitScrollView,
			width,
			(text, current) => applySearchTextHighlight(text, current ? this.currentMatchStyle : this.matchStyle),
		);
	}

	/** Open transcript search, or return focus to the open one. */
	openSearch(): void {
		if (this.activeSearch) this.activeSearch.overlay?.focus();
		else this.toggleSearch();
	}

	toggleSearch(): void {
		if (this.activeSearch) {
			this.closeSearch();
			return;
		}
		const component = new AltScreenSearchComponent(
			(query) => this.updateSearchQuery(query),
			this.searchNavigationButtonStyle,
		);
		// Opening an empty search must not measure the entire transcript. The first query settles its anchor below.
		const search: ActiveSearch = {
			component,
			index: new AltScreenSearchIndex(),
			query: "",
			matches: [],
			selectedIndex: -1,
			anchorRow: this.host.getPrimaryScrollView().scrollTop,
			selectionMode: "query",
		};
		this.activeSearch = search;
		search.overlay = this.host.showOverlay(component, {
			anchor: "top-right",
			width: "40%",
			minWidth: 32,
			margin: 1,
		});
	}

	closeSearch(): void {
		const search = this.activeSearch;
		if (!search) return;
		this.activeSearch = undefined;
		this.pendingAnchor = undefined;
		search.overlay?.hide();
		this.host.requestRender();
	}

	private updateSearchQuery(query: string): void {
		const search = this.activeSearch;
		if (!search || query === search.query) return;
		const selected = search.matches[search.selectedIndex];
		this.pendingAnchor = !selected && query.trim() ? search : undefined;
		search.anchorRow = selected?.segments[0]?.row ?? this.host.getPrimaryScrollView().scrollTop;
		search.query = query;
		search.selectionMode = "query";
		search.component.setResult(-1, 0);
		this.host.requestRender();
	}

	navigateSearch(direction: -1 | 1): void {
		const search = this.activeSearch;
		if (!search?.query) return;
		search.selectionMode = direction < 0 ? "previous" : "next";
		this.host.requestRender();
	}

	private getSearchNavigationDirectionAt(x: number, y: number): -1 | 1 | undefined {
		const search = this.activeSearch;
		const bounds = search?.overlay?.getBounds();
		if (!search || !bounds) return undefined;
		if (x < bounds.col || x >= bounds.col + bounds.width || y < bounds.row || y >= bounds.row + bounds.height) {
			return undefined;
		}
		return search.component.getNavigationDirectionAt(y - bounds.row, x - bounds.col);
	}

	handleSearchMouseEvent(event: SgrMouseEvent): boolean {
		const search = this.activeSearch;
		if (!search) return false;
		const direction = this.getSearchNavigationDirectionAt(event.x, event.y);
		if (search.component.setHoveredNavigationDirection(direction)) this.host.requestRender();
		if (direction === undefined || event.release || (event.button & 32) !== 0 || (event.button & 3) !== 0) {
			return false;
		}
		this.navigateSearch(direction);
		return true;
	}

	/** Build the index between frames in short slices; repaint with progress, and when done. */
	private indexBetweenFrames(search: ActiveSearch): void {
		if (this.indexing === search) return;
		this.indexing = search;
		let lastRepaint = performance.now();
		const slice = (): void => {
			if (this.activeSearch !== search || this.indexing !== search) {
				if (this.indexing === search) this.indexing = undefined;
				return;
			}
			const done = search.index.continue(SLICE_MS);
			if (done || performance.now() - lastRepaint >= PROGRESS_REPAINT_MS) {
				lastRepaint = performance.now();
				this.host.requestRender();
			}
			if (done) this.indexing = undefined;
			else setImmediate(slice);
		};
		setImmediate(slice);
	}

	refreshSearch(layout: LayoutFrame): boolean {
		const search = this.activeSearch;
		if (!search) return false;
		const scrollView = layout.primaryScrollView ?? this.host.implicitScrollView;
		const box = getScrollViewBox(layout, scrollView);
		if (search.query.trim() && !scrollView.isContentSettled) {
			// Layout already measures hidden rows in yielding slices and requests a frame when their positions are exact.
			// The last complete matches stay highlighted until then.
			search.component.setSearching("pending");
			return false;
		}
		// Reading virtual scrollContentLines materializes every row, even when there is no query to search.
		const lines = search.query.trim() ? box?.scrollContentLines : undefined;
		if (!lines) {
			search.matches = [];
			search.selectedIndex = -1;
			search.selectedKey = undefined;
			search.selectionMode = "retain";
			search.component.setResult(-1, 0);
			return false;
		}
		if (this.pendingAnchor === search) {
			search.anchorRow = scrollView.scrollTop;
			this.pendingAnchor = undefined;
		}

		const shouldRevealSelection = search.selectionMode !== "retain";
		const result = search.index.search(lines, search.query, FRAME_SEARCH_BUDGET_MS);
		if (!result.complete) {
			// The last complete matches stay highlighted until every match is known: matches of the rows indexed so far
			// would sit at rows that a later change may move. The selection and its mode stay, so the finished search
			// selects and reveals as asked.
			search.component.setSearching(result.progress);
			this.indexBetweenFrames(search);
			return false;
		}
		const matches = result.matches;
		search.matches = matches;
		if (!result.changed && search.selectionMode === "retain") return false;

		const exactIndex = result.changed
			? search.selectedKey
				? findMatchByKey(matches, search.selectedKey)
				: -1
			: search.selectedIndex;
		const selectedIndex = pickSearchSelection(search, matches, exactIndex);

		search.selectedIndex = selectedIndex;
		search.selectedKey = selectedIndex >= 0 ? getAltScreenSearchMatchKey(matches[selectedIndex]) : undefined;
		search.selectionMode = "retain";
		search.component.setResult(selectedIndex, matches.length, result.folded);
		if (!shouldRevealSelection) return false;

		const selected = matches[selectedIndex];
		const firstSegment = selected?.segments[0];
		const lastSegment = selected?.segments[selected.segments.length - 1];
		if (!box || !firstSegment || !lastSegment || scrollView.viewportHeight <= 0) return false;
		const before = scrollView.scrollTop;
		const visibleBottom = before + scrollView.viewportHeight - 1;
		// Viewport rows the overlay covers: a match drawn there is not visible, and the match is placed below them.
		const bounds = search.overlay?.getBounds();
		const coveredStart = bounds ? Math.max(0, bounds.row - box.rect.y) : 0;
		const coveredEnd = bounds ? Math.max(0, bounds.row + bounds.height - box.rect.y) : 0;
		const underOverlay = (row: number): boolean => row - before >= coveredStart && row - before < coveredEnd;
		let target = before;
		if (
			firstSegment.row < before ||
			lastSegment.row > visibleBottom ||
			selected.segments.some((segment) => underOverlay(segment.row))
		) {
			target = firstSegment.row - Math.max(Math.floor(scrollView.viewportHeight / 3), coveredEnd);
		}
		scrollView.scrollTo(target, { disableFollow: true });
		return scrollView.scrollTop !== before;
	}
}

/**
 * The index of the match with `key` (`getAltScreenSearchMatchKey`), or -1. Matches are in text order, so their first
 * rows ascend: only the matches starting on the key's row are compared.
 */
function findMatchByKey(matches: readonly AltScreenSearchMatch[], key: string): number {
	const row = Number.parseInt(key, 10);
	let low = 0;
	let high = matches.length;
	while (low < high) {
		const middle = (low + high) >> 1;
		if ((matches[middle].segments[0]?.row ?? -1) < row) low = middle + 1;
		else high = middle;
	}
	for (let index = low; index < matches.length && (matches[index].segments[0]?.row ?? -1) <= row; index++)
		if (getAltScreenSearchMatchKey(matches[index]) === key) return index;
	return -1;
}

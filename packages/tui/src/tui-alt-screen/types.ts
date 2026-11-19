import type { AltScreenSearchComponent, AltScreenSearchIndex, AltScreenSearchMatch } from "./search-index.ts";
import type { ScrollView } from "../components/scroll-view.ts";
import type { ScrollbarGeometry } from "../layout/types.ts";
import type { OverlayHandle } from "../tui.ts";
import type { WheelScrollLines } from "../wheel-scroll.ts";

export interface CachedKittyImage {
	transmissionGeneration: number;
	transmissionBytes: number;
	estimatedDecodedBytes: number;
}

export interface SelectionPoint {
	row: number;
	col: number;
	scrollView?: ScrollView;
	/** Whether this point lies between terminal cells rather than on a cell. */
	boundary?: boolean;
}

export interface SelectionRange {
	start: SelectionPoint;
	end: SelectionPoint;
}

export type SelectionGranularity = "character" | "word" | "line";

export interface ClickTarget {
	timestamp: number;
	count: number;
	row: number;
	scrollView?: ScrollView;
	wordStart: number;
	wordEnd: number;
}

export interface SgrMouseEvent {
	button: number;
	x: number;
	y: number;
	release: boolean;
}

export interface WheelEvent {
	direction: -1 | 1;
	x: number;
	y: number;
	button: number;
}

export interface ScrollbarDrag {
	scrollView: ScrollView;
	grabOffset: number;
}

export interface ScrollbarTarget {
	scrollView: ScrollView;
	geometry: ScrollbarGeometry;
}

export interface ScrollToEndIndicatorRect {
	row: number;
	column: number;
	width: number;
}

type SearchSelectionMode = "query" | "retain" | "next" | "previous";

export interface ActiveSearch {
	component: AltScreenSearchComponent;
	index: AltScreenSearchIndex;
	overlay?: OverlayHandle;
	query: string;
	matches: AltScreenSearchMatch[];
	selectedIndex: number;
	selectedKey?: string;
	anchorRow: number;
	selectionMode: SearchSelectionMode;
}

export interface SearchHighlightRange {
	startCol: number;
	endCol: number;
	current: boolean;
}

export interface TuiAltScreenOptions {
	/**
	 * Logical lines moved for each mouse-wheel event (default: 1). `"auto"` accelerates fast wheel
	 * spins on terminals that send one event per notch. Alt+wheel moves five times as far.
	 */
	wheelScrollLines?: WheelScrollLines;
	/** Capture mouse events for viewport scrolling and application-owned text selection. */
	mouse?: boolean;
	searchMatchStyle?: (text: string) => string;
	searchCurrentMatchStyle?: (text: string) => string;
	searchNavigationButtonStyle?: (text: string, hovered: boolean) => string;
	/**
	 * Render a clickable jump-to-end label. It is centered on the last row of a follow-end
	 * primary scroll view while that view is scrolled away from its end. `percent` (0-100) is the reader's position
	 * in the transcript, so the position shows at rest without a scrollbar.
	 */
	scrollToEndIndicator?: (rowsBelow: number, percent: number) => string;
	/** Open an OSC 8 hyperlink activated with a primary-button click. */
	openUrl?: (url: string) => void;
	/** Handle an unmodified secondary-button press for clipboard paste. Currently enabled on Windows only. */
	onRightClickPaste?: () => void;
	/** Automatically copy selected text to the clipboard on mouse release (default: true). */
	copyOnSelect?: boolean;
	/**
	 * Copy selected text to the system clipboard. Return `true` on success, an error message to
	 * display on failure, or `false` for a generic error. When omitted, the selection is copied
	 * via an OSC 52 write.
	 */
	copySelection?: (text: string) => Promise<boolean | string>;
}

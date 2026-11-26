import type { ScrollView } from "../components/scroll-view.ts";
import type { LayoutFrame } from "../layout/types.ts";
import { OSC133_ZONE_PREFIX } from "../terminal/sequences.ts";
import type { FinishedLines } from "../tui/clip.ts";
import { compositeFlashLines } from "./compose.ts";
import type { ScrollToEndIndicator } from "./end-indicator.ts";
import { budgetImageRows } from "./images.ts";
import type { AltScreenSearchController } from "./search-controller.ts";
import type { AltScreenSelection } from "./selection-controller.ts";

/** What one frame's decoration passes read from the screen that owns them. */
export interface AltScreenComposeParts {
	resolveFakeCursors(lines: string[]): string[];
	compositeOverlays(lines: string[], width: number, height: number): string[];
	extractCursorPosition(lines: string[], height: number): { row: number; col: number } | null;
	search: AltScreenSearchController;
	endIndicator: ScrollToEndIndicator;
	implicitScrollView: ScrollView;
	/** Absent when text selection is off. */
	selection: AltScreenSelection | undefined;
	flashLines(width: number): string[];
	finishedLines: FinishedLines;
	frameOutputCap: number | undefined;
}

/** Turn a layout frame's rows into the screen to write: row marks stripped, then every decoration, in paint order. */
export function composeAltScreen(
	parts: AltScreenComposeParts,
	layout: LayoutFrame,
	width: number,
	height: number,
): { screen: string[]; cursorPos: { row: number; col: number } | null } {
	const rawLines = layout.lines.some((line) => line.includes("\x1b]133;"))
		? layout.lines.map((line) => line.replace(OSC133_ZONE_PREFIX, ""))
		: layout.lines;
	let screen = parts.resolveFakeCursors(rawLines);
	screen = parts.search.highlight(screen, layout, width);
	screen = parts.endIndicator.composite(screen, layout, width, parts.implicitScrollView);
	screen = parts.compositeOverlays(screen, width, height);
	if (screen.length > height) screen = screen.slice(screen.length - height);
	if (parts.selection) screen = parts.selection.applySelection(screen, layout);
	screen = compositeFlashLines(screen, parts.flashLines(width).slice(-height), width, height);
	const cursorPos = parts.extractCursorPosition(screen, height);
	screen = parts.finishedLines.apply(screen, width);
	screen = budgetImageRows(screen, width, parts.frameOutputCap);
	return { screen, cursorPos };
}

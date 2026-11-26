import type { ImageProtocol } from "../terminal-image/types.ts";
import { getKittyImagePlacementRows } from "../terminal-image/kitty-metadata.ts";
import { deleteAllKittyPlacements, isImageLine } from "../terminal-image.ts";
import { BEGIN_SYNCHRONIZED_OUTPUT, END_SYNCHRONIZED_OUTPUT } from "../terminal/sequences.ts";
import { DISABLE_AUTOWRAP, DISABLE_MOUSE, ENABLE_AUTOWRAP, EXIT_ALT_SCREEN } from "./constants.ts";
import { mapRowsReusing } from "../tui/row-arrays.ts";
import { eraseAndWriteRow } from "../tui/row-text.ts";
import { sameRowAfterErase } from "../tui/trailing-blanks.ts";
import { deleteKittyImagesFor, prepareKittyScreen } from "./kitty-cache.ts";
import { planScrollShift, type ScrollShift, type TrimmedRowsMemo } from "./scroll-shift.ts";
import type { CachedKittyImage } from "./types.ts";

/** The last frame's rows and which of them hold images, so a frame scans only the rows that changed. */
export class ImageRowsMemo {
	rows: readonly string[] = [];
	images: readonly boolean[] = [];

	/** `isImageLine` of each row, reused for a row equal to the one at the same index last time. */
	scan(rows: readonly string[]): readonly boolean[] {
		if (rows === this.rows) return this.images;
		const known = this.rows;
		const images = mapRowsReusing(rows, known, this.images, isImageLine);
		this.rows = rows;
		this.images = images;
		return images;
	}
}

/**
 * Where the last frame left the hardware cursor. A frame that rewrites no row and leaves the cursor as it was writes
 * nothing: a render the screen asked for without a visible change (a token streamed below a reader scrolled up, a
 * pointer move) costs the terminal no write and no wakeup. A forced repaint resets it.
 */
export class FrameCursorMemo {
	last: string | undefined;

	reset(): void {
		this.last = undefined;
	}
}

/** What one alternate-screen frame write depends on. */
interface AltScreenFrame {
	screen: string[];
	/** What each row holds before this frame writes: the previous screen, after any in-place scroll. */
	previousScreen: string[];
	/** Scrolls a block of rows in place so the frame rewrites only the rows the scroll does not explain. */
	shift: ScrollShift | undefined;
	/** Which rows of `screen` hold images. */
	imageRows: readonly boolean[];
	/** The terminal confirmed synchronized output: wrap the frame in begin/end markers. */
	synchronized: boolean;
	preparedKittyScreen: { lines: string[]; evictedImageDeletion: string };
	imageProtocol: ImageProtocol;
	fullRedraw: boolean;
	imagesNeedRedraw: boolean;
	redrawImages: boolean;
	hadUploadedKittyImages: boolean;
	isWezTerm: boolean;
	width: number;
	height: number;
	cursorPos: { row: number; col: number } | null;
	showHardwareCursor: boolean;
	cursorMemo: FrameCursorMemo;
}

/**
 * The rows a frame rewrites, in write order. After a scroll every row of the region shows its source row, so a cell
 * that does not move with the text (the scrollbar thumb, a row's live mark) sits one shift away from where it belongs
 * until its row is rewritten. A terminal without synchronized output may paint at any byte, so those corrections come
 * first, right after the scroll, and the rows the scroll left blank and the rows outside it follow.
 */
function rowWriteOrder(
	screen: readonly string[],
	basis: readonly string[],
	height: number,
	shift: ScrollShift | undefined,
	all: boolean,
): number[] {
	const changed: number[] = [];
	for (let row = 0; row < height; row++) {
		if (all || !sameRowAfterErase(screen[row] ?? "", basis[row] ?? "")) changed.push(row);
	}
	if (!shift || all) return changed;
	const shifted = (row: number) => row >= shift.top && row <= shift.bottom && (basis[row] ?? "") !== "";
	return [...changed.filter(shifted), ...changed.filter((row) => !shifted(row))];
}

/** Build the output that clears, redraws changed rows and places the cursor, in one write. */
function buildAltScreenFrame(frame: AltScreenFrame): string {
	const {
		screen,
		previousScreen,
		shift,
		imageRows,
		synchronized,
		preparedKittyScreen,
		imageProtocol,
		fullRedraw,
		imagesNeedRedraw,
		redrawImages,
		hadUploadedKittyImages,
		isWezTerm,
		width,
		height,
		cursorPos,
		showHardwareCursor,
		cursorMemo,
	} = frame;
	const begin = synchronized ? BEGIN_SYNCHRONIZED_OUTPUT : "";
	let buffer = begin;
	if (fullRedraw) {
		const clearImages =
			imageProtocol === "kitty" && hadUploadedKittyImages
				? deleteAllKittyPlacements()
				: deleteKittyImagesFor(imageProtocol);
		// Every row is rewritten below with its own erase: the screen clear only matters for image cleanup, and
		// without synchronized output it shows as a blank flash.
		const imagesOnScreen = imageProtocol !== null || hadUploadedKittyImages;
		buffer += imagesOnScreen ? `${clearImages}\x1b[2J` : clearImages;
	} else if (imagesNeedRedraw) {
		if (imageProtocol === "iterm2") buffer += "\x1b[2J";
		else if (imageProtocol === "kitty") buffer += deleteAllKittyPlacements();
	}
	buffer += preparedKittyScreen.evictedImageDeletion;
	buffer += shift?.sequence ?? "";

	// WezTerm erases intersecting Kitty image cells when a later row write touches a covered row.
	// Draw image placements after every clear and text write so nothing later intersects them; preserve
	// the existing interleaved output for text-only frames and every other terminal.
	const drawKittyImagesLast = redrawImages && imageProtocol === "kitty" && imageRows.includes(true) && isWezTerm;
	if (drawKittyImagesLast) {
		for (let row = 0; row < height; row++) {
			if (!fullRedraw && !imagesNeedRedraw && screen[row] === previousScreen[row]) continue;
			buffer += `\x1b[${row + 1};1H\x1b[2K`;
		}
		for (let row = 0; row < height; row++) {
			if (!fullRedraw && !imagesNeedRedraw && screen[row] === previousScreen[row]) continue;
			if (isImageLine(preparedKittyScreen.lines[row] ?? "")) continue;
			buffer += `\x1b[${row + 1};1H${preparedKittyScreen.lines[row] ?? ""}`;
		}
		for (let row = 0; row < height; row++) {
			if (!fullRedraw && !imagesNeedRedraw && screen[row] === previousScreen[row]) continue;
			if (!isImageLine(preparedKittyScreen.lines[row] ?? "")) continue;
			buffer += `\x1b[${row + 1};1H${preparedKittyScreen.lines[row] ?? ""}`;
		}
	} else {
		const prepared = preparedKittyScreen.lines !== screen;
		for (const row of rowWriteOrder(screen, previousScreen, height, shift, fullRedraw || imagesNeedRedraw)) {
			const line = preparedKittyScreen.lines[row] ?? "";
			const image = prepared ? isImageLine(line) : (imageRows[row] ?? false);
			buffer += `\x1b[${row + 1};1H${eraseAndWriteRow(line, image)}`;
		}
	}

	const cursor = cursorPos
		? `\x1b[${cursorPos.row + 1};${Math.min(width, cursorPos.col) + 1}H${showHardwareCursor ? "\x1b[?25h" : "\x1b[?25l"}`
		: "\x1b[?25l";
	if (buffer.length === begin.length && cursor === cursorMemo.last) return "";
	cursorMemo.last = cursor;
	buffer += cursor;
	if (synchronized) buffer += END_SYNCHRONIZED_OUTPUT;
	return buffer;
}

/** What a frame must redraw: the whole screen after a resize or first frame, and image rows that changed. */
function planAltScreenRedraw(options: {
	screen: string[];
	previousScreen: string[];
	previousScreenWidth: number;
	previousScreenHeight: number;
	width: number;
	height: number;
	imageProtocol: ImageProtocol;
	imageRows: readonly boolean[];
	previousImageRows: readonly boolean[];
}): { fullRedraw: boolean; imagesNeedRedraw: boolean; redrawImages: boolean; isWezTerm: boolean } {
	const { screen, previousScreen, previousScreenWidth, previousScreenHeight, width, height, imageProtocol } = options;
	const fullRedraw = previousScreen.length === 0 || previousScreenWidth !== width || previousScreenHeight !== height;
	const changedRows = screen.map((line, row) => line !== previousScreen[row]);
	const imageAnchorsNeedRedraw = screen.some(
		(_line, row) => changedRows[row] && (options.imageRows[row] || options.previousImageRows[row]),
	);
	const isWezTerm = Boolean(process.env.WEZTERM_PANE) || process.env.TERM_PROGRAM?.toLowerCase() === "wezterm";
	const imageCellsNeedRedraw =
		!imageAnchorsNeedRedraw &&
		isWezTerm &&
		imageProtocol === "kitty" &&
		changedRows.some(Boolean) &&
		screen.some((line, row) => {
			const placementRows = getKittyImagePlacementRows(line);
			if (placementRows === undefined) return false;
			for (let coveredRow = row; coveredRow < row + placementRows; coveredRow++) {
				if (changedRows[coveredRow]) return true;
			}
			return false;
		});
	const imagesNeedRedraw = imageAnchorsNeedRedraw || imageCellsNeedRedraw;
	const redrawImages = fullRedraw || imagesNeedRedraw;
	return { fullRedraw, imagesNeedRedraw, redrawImages, isWezTerm };
}

/**
 * Plan the redraw, re-send or place Kitty images and build the frame output.
 * `uploadedKittyImages` is updated when images are redrawn.
 */
export function renderAltScreenOutput(options: {
	screen: string[];
	previousScreen: string[];
	previousScreenWidth: number;
	previousScreenHeight: number;
	width: number;
	height: number;
	imageProtocol: ImageProtocol;
	uploadedKittyImages: Map<number, CachedKittyImage>;
	cursorPos: { row: number; col: number } | null;
	showHardwareCursor: boolean;
	/** The screen's own trimmed-row memo for the scroll-shift planner. */
	trimmedRows?: TrimmedRowsMemo;
	/** The screen's own image-row memo: rows the last frame already scanned are not scanned again. */
	imageRowsMemo?: ImageRowsMemo;
	/** The terminal confirmed synchronized output (DECRQM 2026). */
	synchronized?: boolean;
	/** The screen's own cursor memo: a frame with nothing to change writes nothing. */
	cursorMemo?: FrameCursorMemo;
}): { buffer: string; fullRedraw: boolean; imagesRedrawn: boolean } {
	const { screen, imageProtocol, uploadedKittyImages } = options;
	const memo = options.imageRowsMemo ?? new ImageRowsMemo();
	const previousImageRows = memo.scan(options.previousScreen);
	const imageRows = memo.scan(screen);
	const { fullRedraw, imagesNeedRedraw, redrawImages, isWezTerm } = planAltScreenRedraw({
		...options,
		imageRows,
		previousImageRows,
	});
	const hadUploadedKittyImages = uploadedKittyImages.size > 0;
	const hasImages = imageRows.includes(true) || previousImageRows.includes(true);
	const shift =
		!fullRedraw && !redrawImages
			? planScrollShift(screen, options.previousScreen, options.trimmedRows, hasImages)
			: undefined;
	const preparedKittyScreen =
		redrawImages && imageProtocol === "kitty"
			? prepareKittyScreen(uploadedKittyImages, screen)
			: { lines: screen, evictedImageDeletion: "" };
	const buffer = buildAltScreenFrame({
		screen,
		previousScreen: shift?.basis ?? options.previousScreen,
		shift,
		imageRows,
		synchronized: options.synchronized === true,
		preparedKittyScreen,
		imageProtocol,
		fullRedraw,
		imagesNeedRedraw,
		redrawImages,
		hadUploadedKittyImages,
		isWezTerm,
		width: options.width,
		height: options.height,
		cursorPos: options.cursorPos,
		showHardwareCursor: options.showHardwareCursor,
		cursorMemo: options.cursorMemo ?? new FrameCursorMemo(),
	});
	return { buffer, fullRedraw, imagesRedrawn: redrawImages };
}

/** What stopping writes before the screen is left: images deleted, mouse off, autowrap on. */
export function buildAltScreenStop(deleteImages: string, mouseEnabled: boolean): string {
	return `${BEGIN_SYNCHRONIZED_OUTPUT}${deleteImages}${mouseEnabled ? DISABLE_MOUSE : ""}${ENABLE_AUTOWRAP}${END_SYNCHRONIZED_OUTPUT}`;
}

/** What a process that ends without stopping the UI must still write: mouse off, autowrap on, leave the alternate screen, show the cursor. */
export function buildAltScreenForcedExit(mouseEnabled: boolean): string {
	return `${mouseEnabled ? DISABLE_MOUSE : ""}${ENABLE_AUTOWRAP}${EXIT_ALT_SCREEN}\x1b[?25h`;
}

/** Leave the alternate screen and print the final document into the normal screen's scrollback. */
export function buildAltScreenExit(lastDocument: string[]): string {
	let buffer = `${BEGIN_SYNCHRONIZED_OUTPUT}${EXIT_ALT_SCREEN}${DISABLE_AUTOWRAP}`;
	for (let row = 0; row < lastDocument.length; row++) {
		if (row > 0) buffer += "\r\n";
		buffer += `\r\x1b[2K${lastDocument[row] ?? ""}`;
	}
	buffer += `\x1b[0m${ENABLE_AUTOWRAP}\r\n\x1b[?25h${END_SYNCHRONIZED_OUTPUT}`;
	return buffer;
}

import type { ImageProtocol } from "../terminal-image/types.ts";
import { getKittyImagePlacementRows } from "../terminal-image/kitty-metadata.ts";
import { deleteAllKittyPlacements, isImageLine } from "../terminal-image.ts";
import {
	BEGIN_SYNCHRONIZED_OUTPUT,
	DISABLE_AUTOWRAP,
	ENABLE_AUTOWRAP,
	END_SYNCHRONIZED_OUTPUT,
	EXIT_ALT_SCREEN,
} from "./constants.ts";
import { deleteKittyImagesFor, prepareKittyScreen } from "./kitty-cache.ts";
import type { CachedKittyImage } from "./types.ts";

/** What one alternate-screen frame write depends on. */
interface AltScreenFrame {
	screen: string[];
	previousScreen: string[];
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
}

/** Build the synchronized output that clears, redraws changed rows and places the cursor. */
function buildAltScreenFrame(frame: AltScreenFrame): string {
	const {
		screen,
		previousScreen,
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
	} = frame;
	let buffer = BEGIN_SYNCHRONIZED_OUTPUT;
	if (fullRedraw) {
		const clearImages =
			imageProtocol === "kitty" && hadUploadedKittyImages
				? deleteAllKittyPlacements()
				: deleteKittyImagesFor(imageProtocol);
		buffer += `${clearImages}\x1b[2J`;
	} else if (imagesNeedRedraw) {
		if (imageProtocol === "iterm2") buffer += "\x1b[2J";
		else if (imageProtocol === "kitty") buffer += deleteAllKittyPlacements();
	}
	buffer += preparedKittyScreen.evictedImageDeletion;

	// WezTerm erases intersecting Kitty image cells when a later row write touches a covered row.
	// Draw image placements after every clear and text write so nothing later intersects them; preserve
	// the existing interleaved output for text-only frames and every other terminal.
	const drawKittyImagesLast = redrawImages && imageProtocol === "kitty" && screen.some(isImageLine) && isWezTerm;
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
		for (let row = 0; row < height; row++) {
			if (!fullRedraw && !imagesNeedRedraw && screen[row] === previousScreen[row]) continue;
			buffer += `\x1b[${row + 1};1H\x1b[2K${preparedKittyScreen.lines[row] ?? ""}`;
		}
	}

	if (cursorPos) {
		buffer += `\x1b[${cursorPos.row + 1};${Math.min(width, cursorPos.col) + 1}H`;
		buffer += showHardwareCursor ? "\x1b[?25h" : "\x1b[?25l";
	} else {
		buffer += "\x1b[?25l";
	}
	buffer += END_SYNCHRONIZED_OUTPUT;
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
}): { fullRedraw: boolean; imagesNeedRedraw: boolean; redrawImages: boolean; isWezTerm: boolean } {
	const { screen, previousScreen, previousScreenWidth, previousScreenHeight, width, height, imageProtocol } = options;
	const fullRedraw = previousScreen.length === 0 || previousScreenWidth !== width || previousScreenHeight !== height;
	const changedRows = screen.map((line, row) => line !== previousScreen[row]);
	const imageAnchorsNeedRedraw = screen.some(
		(line, row) => changedRows[row] && (isImageLine(line) || isImageLine(previousScreen[row] ?? "")),
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
}): { buffer: string; fullRedraw: boolean } {
	const { screen, imageProtocol, uploadedKittyImages } = options;
	const { fullRedraw, imagesNeedRedraw, redrawImages, isWezTerm } = planAltScreenRedraw(options);
	const hadUploadedKittyImages = uploadedKittyImages.size > 0;
	const preparedKittyScreen =
		redrawImages && imageProtocol === "kitty"
			? prepareKittyScreen(uploadedKittyImages, screen)
			: { lines: screen, evictedImageDeletion: "" };
	const buffer = buildAltScreenFrame({
		screen,
		previousScreen: options.previousScreen,
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
	});
	return { buffer, fullRedraw };
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

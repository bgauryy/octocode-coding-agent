import { homedir } from "node:os";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { wrapTmuxPassthrough } from "./multiplexer.ts";
import { getCapabilities, getCellDimensions, kittyPlaceholderMode } from "./terminal-image/capabilities.ts";
import { KITTY_PREFIX, registerKittyImageMetadata } from "./terminal-image/kitty-metadata.ts";
import {
	isKittyPlaceholderLine,
	kittyPlaceholderRows,
	kittyPlaceholdersFit,
} from "./terminal-image/kitty-placeholder.ts";
import type { CellDimensions, ImageCellSize, ImageDimensions, ImageRenderOptions } from "./terminal-image/types.ts";

const ITERM2_PREFIX = "\x1b]1337;File=";

export function isImageLine(line: string): boolean {
	// Fast path: sequence at line start (single-row images)
	if (line.startsWith(KITTY_PREFIX) || line.startsWith(ITERM2_PREFIX)) {
		return true;
	}
	// Slow path: sequence elsewhere (multi-row images have cursor-up prefix)
	if (line.includes(KITTY_PREFIX) || line.includes(ITERM2_PREFIX)) return true;
	// Placeholder rows are cells, not sequences; they only count where tmux placeholders are in use.
	return isKittyPlaceholderLine(line) && kittyPlaceholderMode();
}

/** Emit one Kitty APC, wrapped in tmux passthrough when images run under tmux. */
function kittyOut(sequence: string): string {
	return kittyPlaceholderMode() ? wrapTmuxPassthrough(sequence) : sequence;
}

/**
 * Largest escaped payload put in one tmux passthrough envelope. tmux drops a single escape sequence longer than its
 * input buffer: `input-buffer-size`, whose default and minimum is `INPUT_BUF_DEFAULT_SIZE` (1048576 bytes, tmux.h).
 * This leaves room for the `ESC P tmux;` envelope.
 */
export const TMUX_PASSTHROUGH_LIMIT = 1_000_000;

function escapedLength(sequence: string): number {
	return sequence.length + sequence.split("\x1b").length - 1;
}

/**
 * Emit the APCs of one chunked transmission. Under tmux they share passthrough envelopes: tmux forwards each envelope
 * to the client as one write but may put another pane's output between envelopes, and the terminal keeps only one
 * chunked load in progress, so chunks of two panes' uploads interleaved at the client lose both images. An upload
 * whose escaped size exceeds `TMUX_PASSTHROUGH_LIMIT` needs several envelopes and can still be interleaved there.
 */
function kittyOutChunks(sequences: string[]): string {
	if (!kittyPlaceholderMode()) return sequences.join("");
	const envelopes: string[] = [];
	let group = "";
	let groupLength = 0;
	for (const sequence of sequences) {
		const length = escapedLength(sequence);
		if (group && groupLength + length > TMUX_PASSTHROUGH_LIMIT) {
			envelopes.push(wrapTmuxPassthrough(group));
			group = "";
			groupLength = 0;
		}
		group += sequence;
		groupLength += length;
	}
	if (group) envelopes.push(wrapTmuxPassthrough(group));
	return envelopes.join("");
}

/**
 * Generate a random image ID for Kitty graphics protocol.
 * Uses random IDs to avoid collisions between different module instances
 * (e.g., main app vs extensions).
 */
export function allocateImageId(): number {
	// Use random ID in range [1, 0xffffffff] to avoid collisions. Placeholder cells carry the id in a 24-bit
	// foreground colour; a larger id would need a third diacritic per cell, which tmux redraws one mark at a time.
	const limit = kittyPlaceholderMode() ? 0xffffff : 0xffffffff;
	return Math.floor(Math.random() * (limit - 1)) + 1;
}

export function encodeKitty(
	base64Data: string,
	options: {
		columns?: number;
		rows?: number;
		imageId?: number;
		/** Whether Kitty should apply its default cursor movement after placement. Default: true. */
		moveCursor?: boolean;
		/** Create a virtual placement for Unicode placeholders (`U=1`) instead of drawing at the cursor. */
		virtual?: boolean;
	} = {},
): string {
	const CHUNK_SIZE = 4096;

	const params: string[] = ["a=T", "f=100", "q=2"];

	if (options.moveCursor === false && !options.virtual) params.push("C=1");
	if (options.virtual) params.push("U=1");
	if (options.columns) params.push(`c=${options.columns}`);
	if (options.rows) params.push(`r=${options.rows}`);
	if (options.imageId) params.push(`i=${options.imageId}`);

	if (base64Data.length <= CHUNK_SIZE) {
		return kittyOut(`\x1b_G${params.join(",")};${base64Data}\x1b\\`);
	}

	const chunks: string[] = [];
	let offset = 0;
	let isFirst = true;

	while (offset < base64Data.length) {
		const chunk = base64Data.slice(offset, offset + CHUNK_SIZE);
		const isLast = offset + CHUNK_SIZE >= base64Data.length;

		if (isFirst) {
			chunks.push(`\x1b_G${params.join(",")},m=1;${chunk}\x1b\\`);
			isFirst = false;
		} else if (isLast) {
			chunks.push(`\x1b_Gm=0;${chunk}\x1b\\`);
		} else {
			chunks.push(`\x1b_Gm=1;${chunk}\x1b\\`);
		}

		offset += CHUNK_SIZE;
	}

	return kittyOutChunks(chunks);
}

/**
 * Delete a Kitty graphics image by ID.
 * Uses uppercase 'I' to also free the image data.
 */
export function deleteKittyImage(imageId: number): string {
	return kittyOut(`\x1b_Ga=d,d=I,i=${imageId},q=2\x1b\\`);
}

/**
 * Delete all visible Kitty graphics images.
 * Uses uppercase 'A' to also free the image data.
 */
export function deleteAllKittyImages(): string {
	return kittyOut("\x1b_Ga=d,d=A,q=2\x1b\\");
}

/** Delete all visible Kitty placements while retaining their uploaded image data. */
export function deleteAllKittyPlacements(): string {
	return kittyOut("\x1b_Ga=d,d=a,q=2\x1b\\");
}

export function encodeITerm2(
	base64Data: string,
	options: {
		width?: number | string;
		height?: number | string;
		name?: string;
		preserveAspectRatio?: boolean;
		inline?: boolean;
	} = {},
): string {
	const params: string[] = [
		`inline=${options.inline !== false ? 1 : 0}`,
		`size=${Buffer.byteLength(base64Data, "base64")}`,
	];

	if (options.width !== undefined) params.push(`width=${options.width}`);
	if (options.height !== undefined) params.push(`height=${options.height}`);
	if (options.name) {
		const nameBase64 = Buffer.from(options.name).toString("base64");
		params.push(`name=${nameBase64}`);
	}
	if (options.preserveAspectRatio === false) {
		params.push("preserveAspectRatio=0");
	}

	return `\x1b]1337;File=${params.join(";")}:${base64Data}\x07`;
}

function chooseLessDistortedCellCount(upperCount: number, idealCount: number): number {
	if (upperCount <= 1) return upperCount;

	const lowerCount = upperCount - 1;
	const upperDistortion = Math.max(upperCount / idealCount, idealCount / upperCount);
	const lowerDistortion = Math.max(lowerCount / idealCount, idealCount / lowerCount);
	return lowerDistortion < upperDistortion ? lowerCount : upperCount;
}

function calculateImageCellSize(
	imageDimensions: ImageDimensions,
	maxWidthCells: number,
	maxHeightCells?: number,
	cellDimensions: CellDimensions = { widthPx: 9, heightPx: 18 },
	optimizeAspectRatio = false,
): ImageCellSize {
	const maxWidth = Math.max(1, Math.floor(maxWidthCells));
	const maxHeight = maxHeightCells === undefined ? undefined : Math.max(1, Math.floor(maxHeightCells));
	const imageWidth = Math.max(1, imageDimensions.widthPx);
	const imageHeight = Math.max(1, imageDimensions.heightPx);

	const widthScale = (maxWidth * cellDimensions.widthPx) / imageWidth;
	const heightScale = maxHeight === undefined ? widthScale : (maxHeight * cellDimensions.heightPx) / imageHeight;
	const scale = Math.min(widthScale, heightScale);

	const scaledWidthPx = imageWidth * scale;
	const scaledHeightPx = imageHeight * scale;
	let columns = Math.max(1, Math.min(maxWidth, Math.ceil(scaledWidthPx / cellDimensions.widthPx)));
	const heightRows = scaledHeightPx / cellDimensions.heightPx;
	let rows = Math.max(1, Math.ceil(heightRows));
	if (maxHeight !== undefined) {
		rows = Math.min(maxHeight, rows);
	}

	if (!optimizeAspectRatio) {
		return { columns, rows };
	}

	if (widthScale <= heightScale) {
		const idealRows = (columns * cellDimensions.widthPx * imageHeight) / (imageWidth * cellDimensions.heightPx);
		rows = chooseLessDistortedCellCount(rows, idealRows);
	} else {
		const idealColumns = (rows * cellDimensions.heightPx * imageWidth) / (imageHeight * cellDimensions.widthPx);
		columns = chooseLessDistortedCellCount(columns, idealColumns);
	}

	return { columns, rows };
}

export function calculateImageRows(
	imageDimensions: ImageDimensions,
	targetWidthCells: number,
	cellDimensions: CellDimensions = { widthPx: 9, heightPx: 18 },
): number {
	return calculateImageCellSize(imageDimensions, targetWidthCells, undefined, cellDimensions).rows;
}

export function renderImage(
	base64Data: string,
	imageDimensions: ImageDimensions,
	options: ImageRenderOptions = {},
): { sequence: string; columns: number; rows: number; imageId?: number; lines?: string[] } | null {
	const caps = getCapabilities();

	if (!caps.images) {
		return null;
	}

	const maxWidth = options.maxWidthCells ?? 80;
	// Reduce Kitty's cell-aligned distortion without shrinking iTerm2 reservations.
	const size = calculateImageCellSize(
		imageDimensions,
		maxWidth,
		options.maxHeightCells,
		getCellDimensions(),
		caps.images === "kitty",
	);

	if (caps.images === "kitty" && kittyPlaceholderMode()) {
		// tmux does not track placements, so show the image as placeholder cells that tmux stores and redraws.
		if (!kittyPlaceholdersFit(size.columns, size.rows)) return null;
		const imageId = options.imageId ?? allocateImageId();
		const sequence = encodeKitty(base64Data, { columns: size.columns, rows: size.rows, imageId, virtual: true });
		const lines = kittyPlaceholderRows(imageId, size.columns, size.rows);
		lines[0] = sequence + lines[0];
		return { sequence, columns: size.columns, rows: size.rows, imageId, lines };
	}

	if (caps.images === "kitty") {
		if (options.imageId !== undefined) {
			registerKittyImageMetadata({
				imageId: options.imageId,
				columns: size.columns,
				rows: size.rows,
				widthPx: imageDimensions.widthPx,
				heightPx: imageDimensions.heightPx,
			});
		}
		const sequence = encodeKitty(base64Data, {
			columns: size.columns,
			rows: size.rows,
			imageId: options.imageId,
			moveCursor: options.moveCursor,
		});
		return { sequence, columns: size.columns, rows: size.rows, imageId: options.imageId };
	}

	if (caps.images === "iterm2") {
		const sequence = encodeITerm2(base64Data, {
			width: size.columns,
			height: "auto",
			preserveAspectRatio: options.preserveAspectRatio ?? true,
		});
		return { sequence, columns: size.columns, rows: size.rows };
	}

	return null;
}

/**
 * Wrap text in an OSC 8 hyperlink sequence.
 * The text is rendered as a clickable hyperlink in terminals that support OSC 8
 * (Ghostty, Kitty, WezTerm, iTerm2, VSCode, and others).
 * In terminals that do not support OSC 8, the escape sequences are ignored
 * and only the plain text is displayed.
 *
 * @param text - The visible text to display
 * @param url - The URL to link to
 */
export function hyperlink(text: string, url: string): string {
	return `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;
}

/** Shorten home-prefixed absolute paths to ~/... for compact display. */
function shortenImagePath(filename: string): string {
	const home = homedir();
	if (home && (filename === home || filename.startsWith(`${home}/`) || filename.startsWith(`${home}\\`))) {
		return `~${filename.slice(home.length)}`;
	}
	return filename;
}

/**
 * Text fallback when the terminal cannot render inline images.
 * Absolute paths are shown shortened (~/...) and, when OSC 8 hyperlinks are
 * available, linked to file:// so the full path remains openable.
 */
export function imageFallback(mimeType: string, dimensions?: ImageDimensions, filename?: string): string {
	const parts: string[] = [];
	if (filename) {
		const display = shortenImagePath(filename);
		if (getCapabilities().hyperlinks && isAbsolute(filename)) {
			parts.push(hyperlink(display, pathToFileURL(filename).href));
		} else {
			parts.push(display);
		}
	}
	parts.push(`[${mimeType}]`);
	if (dimensions) parts.push(`${dimensions.widthPx}x${dimensions.heightPx}`);
	return `[Image: ${parts.join(" ")}]`;
}

import type { ImageCellSize } from "./types.ts";

export const KITTY_PREFIX = "\x1b_G";

/**
 * A Kitty command outside tmux passthrough, with its control keys captured. Under passthrough the escape is doubled
 * (`ESC ESC _ G`); those sequences belong to placeholder rows, which the placement and crop logic must leave alone.
 */
const KITTY_COMMAND = /(?<!\x1b)\x1b_G([^;]*);/;

interface KittyImageMetadata extends ImageCellSize {
	imageId: number;
	widthPx: number;
	heightPx: number;
}

interface RegisteredKittyImageMetadata extends KittyImageMetadata {
	transmissionGeneration: number;
}

interface KittyImagePlacement {
	imageId: number;
	transmissionGeneration: number;
	transmissionBytes: number;
	estimatedDecodedBytes: number;
	rows: number;
	sequence: string;
	replacementLine: string;
}

const kittyImageMetadata = new Map<number, RegisteredKittyImageMetadata>();
let kittyTransmissionGeneration = 0;

export function registerKittyImageMetadata(metadata: KittyImageMetadata): void {
	kittyTransmissionGeneration += 1;
	kittyImageMetadata.delete(metadata.imageId);
	kittyImageMetadata.set(metadata.imageId, { ...metadata, transmissionGeneration: kittyTransmissionGeneration });
	if (kittyImageMetadata.size > 1000) {
		const oldestImageId = kittyImageMetadata.keys().next().value;
		if (oldestImageId !== undefined) kittyImageMetadata.delete(oldestImageId);
	}
}

function getRegisteredKittyImageMetadataFromControls(controls: string): RegisteredKittyImageMetadata | undefined {
	const imageId = /(?:^|,)i=(\d+)(?:,|$)/.exec(controls)?.[1];
	return imageId === undefined ? undefined : kittyImageMetadata.get(Number.parseInt(imageId, 10));
}

function getRegisteredKittyImageMetadata(line: string): RegisteredKittyImageMetadata | undefined {
	const controls = KITTY_COMMAND.exec(line)?.[1];
	return controls === undefined ? undefined : getRegisteredKittyImageMetadataFromControls(controls);
}

function getExplicitKittyImageRows(controls: string): number | undefined {
	const value = /(?:^|,)r=(\d+)(?:,|$)/.exec(controls)?.[1];
	if (value === undefined) return undefined;
	const rows = Number.parseInt(value, 10);
	return rows > 0 ? rows : undefined;
}

function getKittyImageRowsFromControls(controls: string, fallbackRows: number): number {
	return getExplicitKittyImageRows(controls) ?? fallbackRows;
}

export function getKittyImageMetadata(line: string): KittyImageMetadata | undefined {
	const metadata = getRegisteredKittyImageMetadata(line);
	if (!metadata) return undefined;
	return {
		imageId: metadata.imageId,
		columns: metadata.columns,
		rows: metadata.rows,
		widthPx: metadata.widthPx,
		heightPx: metadata.heightPx,
	};
}

const KITTY_PLACEMENT_CONTROL_KEYS = new Set([
	"i",
	"p",
	"x",
	"y",
	"w",
	"h",
	"X",
	"Y",
	"c",
	"r",
	"C",
	"U",
	"z",
	"P",
	"Q",
	"H",
	"V",
]);

/** Read the number of rows covered by an image placement without scanning its payload. */
export function getKittyImagePlacementRows(line: string): number | undefined {
	const controls = KITTY_COMMAND.exec(line)?.[1];
	if (controls === undefined) return undefined;
	const explicitRows = getExplicitKittyImageRows(controls);
	if (explicitRows !== undefined) return explicitRows;
	return getRegisteredKittyImageMetadataFromControls(controls)?.rows;
}

/** Build a placement-only command for an image line emitted by {@link renderImage}. */
export function getKittyImagePlacement(line: string): KittyImagePlacement | undefined {
	const match = KITTY_COMMAND.exec(line);
	if (!match) return undefined;
	const metadata = getRegisteredKittyImageMetadataFromControls(match[1]);
	if (!metadata) return undefined;

	let commandStart = match.index;
	let commandControls = match[1];
	let transmissionEnd: number;
	while (true) {
		const terminator = line.indexOf("\x1b\\", commandStart + KITTY_PREFIX.length);
		if (terminator === -1) return undefined;
		transmissionEnd = terminator + 2;
		if (!/(?:^|,)m=1(?:,|$)/.test(commandControls)) break;
		commandStart = transmissionEnd;
		if (!line.startsWith(KITTY_PREFIX, commandStart)) return undefined;
		const controlsEnd = line.indexOf(";", commandStart + KITTY_PREFIX.length);
		if (controlsEnd === -1) return undefined;
		commandControls = line.slice(commandStart + KITTY_PREFIX.length, controlsEnd);
	}

	const controls = match[1]
		.split(",")
		.filter((control) => KITTY_PLACEMENT_CONTROL_KEYS.has(control.split("=", 1)[0] ?? ""));
	const sequence = `\x1b_Ga=p,q=2,${controls.join(",")}\x1b\\`;
	return {
		imageId: metadata.imageId,
		transmissionGeneration: metadata.transmissionGeneration,
		transmissionBytes: transmissionEnd - match.index,
		estimatedDecodedBytes: metadata.widthPx * metadata.heightPx * 4,
		rows: getKittyImageRowsFromControls(match[1], metadata.rows),
		sequence,
		replacementLine: `${line.slice(0, match.index)}${sequence}${line.slice(transmissionEnd)}`,
	};
}

export function cropKittyImageLine(line: string, hiddenRows: number, visibleRows: number): string {
	const metadata = getKittyImageMetadata(line);
	const match = KITTY_COMMAND.exec(line);
	if (!metadata || !match || hiddenRows < 0 || hiddenRows >= metadata.rows || visibleRows <= 0) return line;
	const croppedRows = Math.min(visibleRows, metadata.rows - hiddenRows);
	if (hiddenRows === 0 && croppedRows === metadata.rows) return line;
	const sourceY = Math.floor((metadata.heightPx * hiddenRows) / metadata.rows);
	const sourceEnd = Math.ceil((metadata.heightPx * (hiddenRows + croppedRows)) / metadata.rows);
	const sourceHeight = Math.max(1, Math.min(metadata.heightPx, sourceEnd) - sourceY);
	const controls = match[1].split(",").filter((control) => !/^[yhr]=/.test(control));
	controls.push(`y=${sourceY}`, `h=${sourceHeight}`, `r=${croppedRows}`);
	return `${line.slice(0, match.index)}\x1b_G${controls.join(",")};${line.slice(match.index + match[0].length)}`;
}

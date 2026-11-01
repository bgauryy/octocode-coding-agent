import type { OverlayAnchor, OverlayOptions, SizeValue } from "./overlay-types.ts";

/** The number in a percentage string like "50%" (50), or undefined when the string is not one. */
function parsePercent(value: string): number | undefined {
	const match = value.match(/^(\d+(?:\.\d+)?)%$/);
	return match ? parseFloat(match[1]) : undefined;
}

/** Parse a SizeValue into absolute value given a reference size; undefined when absent or not a percentage. */
function parseSizeValue(value: SizeValue | undefined, referenceSize: number): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value === "number") return value;
	const percent = parsePercent(value);
	return percent === undefined ? undefined : Math.floor((referenceSize * percent) / 100);
}

/**
 * Resolve an overlay row or column: an absolute number, or a percentage of the free space
 * (0% = start, 100% = end, so the overlay stays within bounds) offset by the start margin.
 * Undefined for a string that is not a percentage; the caller then centers the overlay.
 */
function parseOverlayPosition(value: SizeValue, freeSpace: number, startMargin: number): number | undefined {
	if (typeof value === "number") return value;
	const percent = parsePercent(value);
	return percent === undefined ? undefined : startMargin + Math.floor(freeSpace * (percent / 100));
}

/**
 * Resolve overlay layout from options.
 * Returns { width, row, col, maxHeight } for rendering.
 */
export function resolveOverlayLayout(
	options: OverlayOptions | undefined,
	overlayHeight: number,
	termWidth: number,
	termHeight: number,
): { width: number; row: number; col: number; maxHeight: number | undefined } {
	const opt = options ?? {};

	// Parse margin (clamp to non-negative)
	const margin =
		typeof opt.margin === "number"
			? { top: opt.margin, right: opt.margin, bottom: opt.margin, left: opt.margin }
			: (opt.margin ?? {});
	const marginTop = Math.max(0, margin.top ?? 0);
	const marginRight = Math.max(0, margin.right ?? 0);
	const marginBottom = Math.max(0, margin.bottom ?? 0);
	const marginLeft = Math.max(0, margin.left ?? 0);

	// Available space after margins
	const availWidth = Math.max(1, termWidth - marginLeft - marginRight);
	const availHeight = Math.max(1, termHeight - marginTop - marginBottom);

	// === Resolve width ===
	let width = parseSizeValue(opt.width, termWidth) ?? Math.min(80, availWidth);
	// Apply minWidth
	if (opt.minWidth !== undefined) {
		width = Math.max(width, opt.minWidth);
	}
	// Clamp to available space
	width = Math.max(1, Math.min(width, availWidth));

	// === Resolve maxHeight ===
	let maxHeight = parseSizeValue(opt.maxHeight, termHeight);
	// Clamp to available space
	if (maxHeight !== undefined) {
		maxHeight = Math.max(1, Math.min(maxHeight, availHeight));
	}

	// Effective overlay height (may be clamped by maxHeight)
	const effectiveHeight = maxHeight !== undefined ? Math.min(overlayHeight, maxHeight) : overlayHeight;

	// === Resolve position ===
	// An explicit row or column wins over the anchor; an invalid one centers (default anchor: center).
	const anchor = opt.anchor ?? "center";
	const rowAnchor = opt.row === undefined ? anchor : "center";
	const colAnchor = opt.col === undefined ? anchor : "center";
	let row =
		(opt.row === undefined
			? undefined
			: parseOverlayPosition(opt.row, Math.max(0, availHeight - effectiveHeight), marginTop)) ??
		resolveAnchorRow(rowAnchor, effectiveHeight, availHeight, marginTop);
	let col =
		(opt.col === undefined ? undefined : parseOverlayPosition(opt.col, Math.max(0, availWidth - width), marginLeft)) ??
		resolveAnchorCol(colAnchor, width, availWidth, marginLeft);

	// Apply offsets
	if (opt.offsetY !== undefined) row += opt.offsetY;
	if (opt.offsetX !== undefined) col += opt.offsetX;

	// Clamp to terminal bounds (respecting margins)
	row = Math.max(marginTop, Math.min(row, termHeight - marginBottom - effectiveHeight));
	col = Math.max(marginLeft, Math.min(col, termWidth - marginRight - width));

	return { width, row, col, maxHeight };
}

function resolveAnchorRow(anchor: OverlayAnchor, height: number, availHeight: number, marginTop: number): number {
	switch (anchor) {
		case "top-left":
		case "top-center":
		case "top-right":
			return marginTop;
		case "bottom-left":
		case "bottom-center":
		case "bottom-right":
			return marginTop + availHeight - height;
		case "left-center":
		case "center":
		case "right-center":
			return marginTop + Math.floor((availHeight - height) / 2);
	}
}

function resolveAnchorCol(anchor: OverlayAnchor, width: number, availWidth: number, marginLeft: number): number {
	switch (anchor) {
		case "top-left":
		case "left-center":
		case "bottom-left":
			return marginLeft;
		case "top-right":
		case "right-center":
		case "bottom-right":
			return marginLeft + availWidth - width;
		case "top-center":
		case "center":
		case "bottom-center":
			return marginLeft + Math.floor((availWidth - width) / 2);
	}
}

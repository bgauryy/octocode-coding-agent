import { truncateToWidth, visibleWidth } from "@octocodeai/octocode-tui/text";
import type { Theme } from "../../../theme/theme.ts";

export type FooterPaint = Pick<Theme, "fg" | "bold">;

/** Smaller priorities shorten first. Kept parts only give way after the others. */
export interface FooterPart {
	text: string;
	priority: number;
	keep?: boolean;
	short?: string;
	/** This part has session details available through /status. */
	details?: boolean;
}

/** Fit independently of the caller's parts, so adding a details hint can fit them again. */
export function fitFooterLine(left: FooterPart[], right: FooterPart[], theme: FooterPaint, width: number) {
	const leftParts = left.map((part) => ({ ...part }));
	const rightParts = right.map((part) => ({ ...part }));
	const dot = theme.fg("dim", " · ");
	let parts = [...leftParts, ...rightParts].filter((part) => part.text !== "");
	const full = new Map(parts.map((part) => [part, part.text]));
	const render = () => {
		const l = leftParts
			.filter((part) => parts.includes(part))
			.map((part) => part.text)
			.join(dot);
		const r = rightParts
			.filter((part) => parts.includes(part))
			.map((part) => part.text)
			.join(dot);
		return r ? `${l}${" ".repeat(Math.max(2, width - visibleWidth(l) - visibleWidth(r)))}${r}` : l;
	};
	while (visibleWidth(render()) > width) {
		const next = parts
			.filter((part) => !part.keep || part.short !== undefined)
			.sort((a, b) => a.priority - b.priority)[0];
		if (!next) break;
		if (next.short !== undefined) {
			next.text = next.short;
			delete next.short;
		} else parts = parts.filter((part) => part !== next);
	}
	while (visibleWidth(render()) > width && parts.length > 1) {
		const next = [...parts].sort((a, b) => a.priority - b.priority)[0];
		const room = visibleWidth(next.text) - (visibleWidth(render()) - width);
		if (room > 1) next.text = truncateToWidth(next.text, room, theme.fg("dim", "…"));
		else parts = parts.filter((part) => part !== next);
	}
	for (const part of [...parts].sort((a, b) => b.priority - a.priority)) {
		const short = part.text;
		part.text = full.get(part)!;
		if (visibleWidth(render()) > width) part.text = short;
	}
	const line = truncateToWidth(render(), Math.max(0, width), theme.fg("dim", "…"));
	const detailsHidden = [...full].some(
		([part, text]) => part.details && (!parts.includes(part) || !line.includes(text)),
	);
	return { line, detailsHidden };
}

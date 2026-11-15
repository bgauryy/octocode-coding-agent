import { truncateToWidth, visibleWidth } from "@octocodeai/octocode-tui/text";
import type { Theme } from "../../../theme/theme.ts";

export type FooterPaint = Pick<Theme, "fg" | "bold">;

/** Smaller priorities shorten first. Kept parts only give way after the others. */
export interface FooterPart {
	text: string;
	priority: number;
	keep?: boolean;
	/** A form between `text` and `short`, tried first (a path with its middle elided). */
	middle?: string;
	short?: string;
	/** This part has session details available through /status. */
	details?: boolean;
	/** Shown in rows of its own when it does not fit here: dropped whole rather than cut. */
	spills?: boolean;
}

/** Fit independently of the caller's parts, so adding a details hint can fit them again. */
export function fitFooterLine(left: FooterPart[], right: FooterPart[], theme: FooterPaint, width: number) {
	const leftParts = left.map((part) => ({ ...part }));
	const rightParts = right.map((part) => ({ ...part }));
	const dot = theme.fg("dim", " · ");
	let parts = [...leftParts, ...rightParts].filter((part) => part.text !== "");
	const full = new Map(parts.map((part) => [part, part.text]));
	const floored = new Set<FooterPart>();
	// Every form of a part, widest first: the last pass picks the widest that still fits.
	const forms = new Map(
		parts.map((part) => [part, [part.text, part.middle, part.short].filter((form) => form !== undefined)]),
	);
	const render = () => {
		const l = leftParts
			.filter((part) => parts.includes(part))
			.map((part) => part.text)
			.join(dot);
		const r = rightParts
			.filter((part) => parts.includes(part))
			.map((part) => part.text)
			.join(dot);
		return r ? `${l}${" ".repeat(Math.max(l ? 2 : 0, width - visibleWidth(l) - visibleWidth(r)))}${r}` : l;
	};
	while (visibleWidth(render()) > width) {
		const next = parts
			.filter((part) => !part.keep || part.short !== undefined || part.middle !== undefined)
			.sort((a, b) => a.priority - b.priority)[0];
		if (!next) break;
		if (next.middle !== undefined) {
			next.text = next.middle;
			delete next.middle;
		} else if (next.short !== undefined) {
			next.text = next.short;
			delete next.short;
			floored.add(next);
		} else parts = parts.filter((part) => part !== next);
	}
	while (visibleWidth(render()) > width && parts.length > 1) {
		// A part already at its short form (the cwd's basename) is not cut while an alert, which has rows of its own, can
		// leave instead.
		const order = [...parts].sort((a, b) => a.priority - b.priority);
		const next = floored.has(order[0]) ? (order.find((part) => part.spills) ?? order[0]) : order[0];
		const room = visibleWidth(next.text) - (visibleWidth(render()) - width);
		if (room > 1 && !next.spills) next.text = truncateToWidth(next.text, room, theme.fg("dim", "…"));
		else parts = parts.filter((part) => part !== next);
	}
	// Grow back by priority: each part, dropped ones too, takes its widest form that fits, so a dropped part returns
	// when shortening a higher one freed the room, and a lower part never takes room a higher one could use.
	for (const part of [...full.keys()].sort((a, b) => b.priority - a.priority)) {
		const shown = parts.includes(part) ? part.text : undefined;
		if (shown === undefined) parts = [...parts, part];
		let fitted = false;
		for (const form of forms.get(part)!) {
			part.text = form;
			if (form === shown || visibleWidth(render()) <= width) {
				fitted = true;
				break;
			}
		}
		if (fitted) continue;
		if (shown === undefined) parts = parts.filter((kept) => kept !== part);
		else part.text = shown;
	}
	const line = truncateToWidth(render(), Math.max(0, width), theme.fg("dim", "…"));
	const detailsHidden = [...full].some(
		([part, text]) => part.details && (!parts.includes(part) || !line.includes(text)),
	);
	return { line, detailsHidden };
}

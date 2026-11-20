import { truncateToWidth, visibleWidth } from "@octocodeai/octocode-tui/text";
import type { Theme } from "../../../theme/theme.ts";

export type FooterPaint = Pick<Theme, "fg" | "bold">;

/**
 * One part of a footer line. Its forms, widest first, are `text`, `middle`, `short` and `bare`; each step to a narrower form, and
 * for a part that is not `keep` the step out of the line, happens in priority order across every zone: the smallest
 * priority gives way first.
 */
export interface FooterPart {
	text: string;
	/** The priority of the first step (to the next form, or out of the line when there is none). */
	priority: number;
	/** The priority of every later step: a part whose narrow form matters more holds it longer. Default `priority`. */
	later?: number;
	/** The order of the last pass, which cuts or drops what is left when every step was taken. Default the last step's priority. */
	floor?: number;
	/** Never steps out of the line; only the last pass cuts it, when the line is too narrow even at every short form. */
	keep?: boolean;
	/** A form between `text` and `short`, tried first (a path with its middle elided). */
	middle?: string;
	short?: string;
	/** The narrowest form, after `short` (a location without its branch), so a floor of another zone keeps its room. */
	bare?: string;
	/** This part has session details available through /status. */
	details?: boolean;
	/** Shown in rows of its own when it does not fit here: dropped whole rather than cut. */
	spills?: boolean;
	/** The last pass drops it whole rather than cut it: a cut figure (`ctx 4…` for 42%) would misread. */
	whole?: boolean;
}

/** A line's zones: `left` starts at column 0, `right` ends at the last column, `center` is centered between them. */
export interface FooterZones {
	left?: FooterPart[];
	center?: FooterPart[];
	right?: FooterPart[];
}

/** The least space between two zones. Zones have no separator glyph: the space is the separator. */
const ZONE_GAP = 2;

/**
 * Lays out three zone texts in `width` columns: the left at column 0, the right ending at the last column, the center in
 * the middle of the free space between them, at least `ZONE_GAP` from each neighbour. A line that does not fit gets the
 * least gaps, so the caller sees by how much it overflows.
 */
function layout(left: string, center: string, right: string, width: number): string {
	const [l, c, r] = [left, center, right].map((text) => visibleWidth(text));
	if (!center) return right ? `${left}${" ".repeat(Math.max(left ? ZONE_GAP : 0, width - l - r))}${right}` : left;
	const minLeft = left ? ZONE_GAP : 0;
	const minRight = right ? ZONE_GAP : 0;
	const free = width - l - c - r;
	if (free < minLeft + minRight) return `${left}${" ".repeat(minLeft)}${center}${" ".repeat(minRight)}${right}`;
	let gapLeft = Math.max(minLeft, Math.floor(free / 2));
	if (free - gapLeft < minRight) gapLeft = free - minRight;
	// Nothing on the right: the center ends the line, with no trailing spaces.
	const gapRight = right ? free - gapLeft : 0;
	return `${left}${" ".repeat(gapLeft)}${center}${" ".repeat(gapRight)}${right}`;
}

/**
 * Fits the zones' parts into `width` columns in one pass over all of them: steps are taken lowest priority first until the
 * line fits, then the parts still too wide are cut, then every step is undone, highest priority first, where the room
 * allows. A dropped part thus returns when shortening a higher one freed room, and a lower part never takes room a
 * higher one could use. `detailsHidden` says a `details` part is not shown in full; `partlyHidden` says one is shown
 * shortened or cut, and `dropped` lists those out of the line whole.
 */
export function fitFooterZones(zones: FooterZones, theme: FooterPaint, width: number) {
	const dot = theme.fg("dim", " · ");
	const lists = [zones.left ?? [], zones.center ?? [], zones.right ?? []].map((list) =>
		list.filter((part) => part.text !== ""),
	);
	const all = lists.flat();
	const forms = new Map(
		all.map((part) => [part, [part.text, part.middle, part.short, part.bare].filter((form) => form !== undefined)]),
	);
	/** The index of the form a part shows; its number of forms means it is out of the line. */
	const at = new Map(all.map((part) => [part, 0]));
	const cut = new Map<FooterPart, string>();
	const formsOf = (part: FooterPart) => forms.get(part) ?? [];
	const shown = (part: FooterPart): string | undefined => {
		const index = at.get(part) ?? 0;
		return index < formsOf(part).length ? (cut.get(part) ?? formsOf(part)[index]) : undefined;
	};
	const zoneText = (list: FooterPart[]) =>
		list
			.map(shown)
			.filter((text) => text !== undefined)
			.join(dot);
	const render = () => layout(zoneText(lists[0]), zoneText(lists[1]), zoneText(lists[2]), width);
	const over = () => visibleWidth(render()) - width;
	const stepPriority = (part: FooterPart, step: number) => (step === 0 ? part.priority : (part.later ?? part.priority));
	/** The steps the shrink pass may take: to each narrower form, and out of the line unless `keep`. */
	const steps = (part: FooterPart) => formsOf(part).length - (part.keep ? 1 : 0);

	while (over() > 0) {
		let next: FooterPart | undefined;
		for (const part of all) {
			const step = at.get(part) ?? 0;
			if (step >= steps(part)) continue;
			if (!next || stepPriority(part, step) < stepPriority(next, at.get(next) ?? 0)) next = part;
		}
		if (!next) break;
		at.set(next, (at.get(next) ?? 0) + 1);
	}
	const visible = () => all.filter((part) => shown(part) !== undefined);
	while (over() > 0 && visible().length > 1) {
		// Nothing is cut while an alert, which has rows of its own, can leave instead.
		const rank = (part: FooterPart) => part.floor ?? stepPriority(part, at.get(part) ?? 0);
		const order = visible().sort((a, b) => rank(a) - rank(b));
		const next = order.find((part) => part.spills) ?? order[0];
		const text = shown(next) ?? "";
		const room = visibleWidth(text) - over();
		if (room > 1 && !next.spills && !next.whole) cut.set(next, truncateToWidth(text, room, theme.fg("dim", "…")));
		else at.set(next, formsOf(next).length);
	}
	// Undo steps highest priority first; within one part the later (narrower) step comes back first.
	const undo = all
		.flatMap((part) => formsOf(part).map((_, step) => ({ part, step, priority: stepPriority(part, step) })))
		.sort((a, b) => b.priority - a.priority || b.step - a.step);
	for (const { part, step } of undo) {
		if (at.get(part) !== step + 1 || cut.has(part)) continue;
		at.set(part, step);
		if (over() > 0) at.set(part, step + 1);
	}
	const line = truncateToWidth(render(), Math.max(0, width), theme.fg("dim", "…"));
	const hidden = all.filter(
		(part) => part.details && (at.get(part) !== 0 || cut.has(part) || !line.includes(part.text)),
	);
	/** `details` parts out of the line whole, which another line may show instead. */
	const dropped = hidden.filter((part) => shown(part) === undefined);
	return { line, detailsHidden: hidden.length > 0, partlyHidden: hidden.length > dropped.length, dropped };
}

/** A two-zone line: `left` from column 0, `right` ending at the last column. */
export function fitFooterLine(left: FooterPart[], right: FooterPart[], theme: FooterPaint, width: number) {
	return fitFooterZones({ left, right }, theme, width);
}

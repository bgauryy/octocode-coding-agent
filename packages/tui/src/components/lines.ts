import type { Component } from "../tui/component.ts";
import { renderChanged, trackRenderChanges } from "../tui/render-signal.ts";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "../utils/text.ts";

/**
 * One drawn row. `lead` (such as the `⎿` gutter) prefixes its first line only; a wrapped row's continuation lines take
 * `indent`, so the lead is drawn once per block and the text hangs under itself.
 */
export interface Row {
	text: string;
	wrap?: boolean;
	indent?: string;
	lead?: string;
	/**
	 * Parts drawn after `text` on a row that does not wrap, each with its own separator (` · 14 tool calls`). Like a
	 * header's meta, a part is drawn whole or not at all: the last ones drop first, before `text` is cut.
	 */
	meta?: readonly string[];
}

/** The parts of a header row: `left` (mark and name), the `summary` drawn in parentheses, `meta`, then `right` (time). */
export interface Header {
	left: string;
	summary: string;
	right: string;
	meta?: string;
	/** The styled parentheses around the summary; plain ones by default. */
	parens?: readonly [open: string, close: string];
}

/** The rows of one content version and their lines at the last width they were drawn at. */
interface Version {
	rows: Row[];
	drawn: { width: number; lines: string[] } | undefined;
}

/** Versions kept per component: the collapsed and the expanded view, so ctrl+o back and forth re-wraps nothing. */
const VERSIONS_KEPT = 2;

function sameRows(a: readonly Row[], b: readonly Row[]): boolean {
	if (a === b) return true;
	if (a.length !== b.length) return false;
	for (let index = 0; index < a.length; index++) {
		const x = a[index];
		const y = b[index];
		if (x.text !== y.text || x.wrap !== y.wrap || x.indent !== y.indent || x.lead !== y.lead) return false;
		if (x.meta !== y.meta && (x.meta?.join("\0") ?? "") !== (y.meta?.join("\0") ?? "")) return false;
	}
	return true;
}

function sameHeader(a: Header | undefined, b: Header | undefined): boolean {
	return (
		a === b ||
		(!!a &&
			!!b &&
			a.left === b.left &&
			a.summary === b.summary &&
			a.right === b.right &&
			a.meta === b.meta &&
			a.parens?.[0] === b.parens?.[0] &&
			a.parens?.[1] === b.parens?.[1])
	);
}

/** The leading `parts` that fit `room` columns whole, joined: meta is drawn whole or not at all, the last part dropping first. */
function wholeParts(parts: readonly string[], room: number): string {
	let shown = "";
	let left = room;
	for (const part of parts) {
		left -= visibleWidth(part);
		if (left < 0) break;
		shown += part;
	}
	return shown;
}

/** Columns a summary that is cut anyway keeps at least before meta may stay beside it. */
const SUMMARY_SHARE = 2 / 3;
/** The fewest summary columns worth drawing inside parentheses. */
const MIN_SUMMARY = 4;

/**
 * One row: `left(summary)meta right`. The mark, name and time are always kept, and meta is drawn whole or not at all.
 * Meta drops before the summary is cut: a summary that fits once meta is gone shows whole. A summary too long for the
 * row even alone keeps meta only while it still gets its share of the room. The summary is drawn with its parentheses
 * as one unit or not at all.
 */
function headerLine({ left, summary, right, meta = "", parens = ["(", ")"] }: Header, width: number): string {
	const room = width - visibleWidth(left) - visibleWidth(right);
	const summaryWidth = summary ? visibleWidth(summary) + 2 : 0;
	const metaWidth = visibleWidth(meta);
	const besideMeta = room - metaWidth;
	const keepMeta =
		summaryWidth <= besideMeta ||
		(summaryWidth > room && besideMeta >= Math.max(Math.floor(room * SUMMARY_SHARE), MIN_SUMMARY + 2));
	const summaryRoom = Math.min(summaryWidth, keepMeta ? besideMeta : room);
	const unit =
		summary && summaryRoom >= Math.min(summaryWidth, MIN_SUMMARY + 2)
			? `${parens[0]}${truncateToWidth(summary, summaryRoom - 2, "…")}${parens[1]}`
			: "";
	const shownMeta = wholeParts([meta], room - visibleWidth(unit));
	return truncateToWidth(`${left}${unit}${shownMeta}${right}`, width, "…");
}

function drawRows(rows: readonly Row[], width: number): string[] {
	const out: string[] = [];
	for (const row of rows) {
		const lead = row.lead ?? "";
		if (!row.wrap) {
			const meta = row.meta ? wholeParts(row.meta, width - visibleWidth(lead) - visibleWidth(row.text)) : "";
			out.push(truncateToWidth(`${lead}${row.text}${meta}`, width, "…"));
			continue;
		}
		const indent = row.indent ?? "";
		const wrapped = wrapTextWithAnsi(row.text, Math.max(1, width - visibleWidth(indent)));
		// A width narrower than the indent still gets lines that fit: the indent and text are clipped together.
		(wrapped.length > 0 ? wrapped : [""]).forEach((line, index) => {
			out.push(truncateToWidth(`${index === 0 ? (row.lead ?? indent) : indent}${line}`, width, "…"));
		});
	}
	return out;
}

/**
 * A header and a list of lines clipped to the render width (`wrap` lines wrap instead). octocode-tui draws up to 60
 * frames a second and its Box compares a child's lines by identity, so the output is cached: the header per (text,
 * width), the rows per content version and width, for the last two versions. A `set` with the same content (a redraw of
 * an unchanged row, a clock tick in the header) keeps the drawn rows; `invalidate` (a theme change) drops everything.
 */
export class Lines implements Component {
	private header: Header | undefined;
	private versions: Version[] = [];
	private drawnHeader: { header: Header; width: number; line: string } | undefined;
	private output: { width: number; head: string | undefined; body: string[]; lines: string[] } | undefined;

	set(header: Header | undefined, rows: Row[]): this {
		this.header = header;
		const index = this.versions.findIndex((version) => sameRows(version.rows, rows));
		const version = index === -1 ? { rows, drawn: undefined } : this.versions.splice(index, 1)[0];
		this.versions.unshift(version);
		this.versions.length = Math.min(this.versions.length, VERSIONS_KEPT);
		renderChanged(this);
		return this;
	}

	render(width: number): string[] {
		const version = this.versions[0];
		let body: string[] = [];
		if (version) {
			if (version.drawn?.width !== width) version.drawn = { width, lines: drawRows(version.rows, width) };
			body = version.drawn.lines;
		}
		let head: string | undefined;
		if (this.header) {
			let drawn = this.drawnHeader;
			if (drawn?.width !== width || !sameHeader(drawn.header, this.header)) {
				drawn = { header: this.header, width, line: headerLine(this.header, width) };
				this.drawnHeader = drawn;
			}
			head = drawn.line;
		}
		const output = this.output;
		if (output && output.width === width && output.head === head && output.body === body) return output.lines;
		const lines = head === undefined ? body : [head, ...body];
		this.output = { width, head, body, lines };
		return lines;
	}

	invalidate(): void {
		// A look change restyles every row: older versions would never match again.
		this.versions.length = Math.min(this.versions.length, 1);
		for (const version of this.versions) version.drawn = undefined;
		this.drawnHeader = undefined;
		this.output = undefined;
		renderChanged(this);
	}
}
// Its rows read only what `set` stores (styled when set) and the width: a transcript keeps them between frames.
trackRenderChanges(Lines.prototype);

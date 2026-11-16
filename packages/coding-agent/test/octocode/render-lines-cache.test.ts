import { describe, expect, it } from "vitest";
import { type Header, Lines, type Row } from "@octocodeai/octocode-tui";

const header = (right: string): Header => ({ left: "✓ Read(", summary: "src/some/long/path/to/a/file.ts", right });
const collapsed = (): Row[] => [
	{ lead: "  ⎿  ", text: "Read 3 lines (ctrl+o to expand)" },
	{ text: "\x1b[31mfirst line\x1b[39m", lead: "     " },
];
const expanded = (): Row[] => [
	{ lead: "  ⎿  ", text: "Read 3 lines" },
	...["alpha beta gamma delta epsilon zeta eta theta iota kappa", "\x1b[32mlambda mu nu xi omicron pi rho\x1b[39m"].map(
		(text) => ({ text, wrap: true, indent: "     ", lead: "     " }),
	),
];

/** What a fresh component draws: the cache must never change the output. */
function fresh(head: Header | undefined, rows: Row[], width: number): string[] {
	return new Lines().set(head, rows).render(width);
}

describe("tool row lines cache", () => {
	it("keeps the drawn lines when a redraw sets the same content again", () => {
		const lines = new Lines().set(header(" · 1s"), expanded());
		const first = lines.render(30);
		expect(lines.set(header(" · 1s"), expanded()).render(30)).toBe(first);
		expect(first).toEqual(fresh(header(" · 1s"), expanded(), 30));
	});

	it("redraws only the header when only the header changes", () => {
		const lines = new Lines().set(header(" · 1s"), expanded());
		const first = lines.render(30);
		const next = lines.set(header(" · 2s"), expanded()).render(30);
		expect(next).not.toBe(first);
		expect(next).toEqual(fresh(header(" · 2s"), expanded(), 30));
		expect(next.slice(1)).toEqual(first.slice(1));
	});

	it("reuses the collapsed and the expanded view when toggled back and forth", () => {
		const lines = new Lines();
		const shortView = lines.set(undefined, collapsed()).render(24);
		const longView = lines.set(undefined, expanded()).render(24);
		expect(lines.set(undefined, collapsed()).render(24)).toBe(shortView);
		expect(lines.set(undefined, expanded()).render(24)).toBe(longView);
		expect(longView).toEqual(fresh(undefined, expanded(), 24));
	});

	it("redraws on a content change, a width change and an invalidate", () => {
		const lines = new Lines().set(undefined, expanded());
		const first = lines.render(24);
		const changed: Row[] = [...expanded(), { text: "one more row" }];
		const afterChange = lines.set(undefined, changed).render(24);
		expect(afterChange).toEqual(fresh(undefined, changed, 24));

		const narrower = lines.render(16);
		expect(narrower).toEqual(fresh(undefined, changed, 16));
		expect(lines.render(24)).toEqual(afterChange);

		const beforeInvalidate = lines.render(24);
		lines.invalidate();
		const afterInvalidate = lines.render(24);
		expect(afterInvalidate).not.toBe(beforeInvalidate);
		expect(afterInvalidate).toEqual(beforeInvalidate);
		expect(first).toEqual(fresh(undefined, expanded(), 24));
	});

	it("keeps at most two content versions", () => {
		const lines = new Lines();
		const a = lines.set(undefined, collapsed()).render(24);
		lines.set(undefined, expanded()).render(24);
		lines.set(undefined, [{ text: "third" }]).render(24);
		const again = lines.set(undefined, collapsed()).render(24);
		expect(again).not.toBe(a);
		expect(again).toEqual(a);
	});
});

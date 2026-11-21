import { visibleWidth, wrapTextWithAnsi } from "@octocodeai/octocode-tui";
import { describe, expect, it } from "vitest";
import { stripAnsi } from "../../src/utils/ansi.ts";
import { type InventoryItem, renderInventory } from "../../src/octocode/harness/inventory.ts";

const item = (index: number, host: InventoryItem["host"] = "skills"): InventoryItem => ({
	id: `skill:s${index}`,
	host,
	kind: "skill",
	depth: 0,
	label: `s${index}`,
	on: true,
	detail: `~/.octocode/agent/skills/very-long-skill-folder-${index}/references/nested/deeper/and-deeper/still-deeper/SKILL.md`,
});
const inventory = (items: InventoryItem[]) => ({ items, stale: [], ignored: [], notes: [] });

describe("renderInventory", () => {
	it("prints every row without a limit", () => {
		const items = Array.from({ length: 60 }, (_, index) => item(index));
		const text = renderInventory(inventory(items));
		expect(text).toContain("skill:s59");
		expect(text).not.toContain("more:");
	});

	it("stops at the limit and names the filter for the rest", () => {
		const items = Array.from({ length: 60 }, (_, index) => item(index));
		const text = renderInventory(inventory(items), undefined, 10);
		expect(text).toContain("skill:s9");
		expect(text).not.toContain("skill:s10 ");
		expect(text).toContain("… 50 more: /harness list <section or text>");
	});

	for (const width of [60, 100]) {
		it(`keeps every row within ${width} columns and the path characters in order`, () => {
			const text = renderInventory(inventory([item(1)]));
			const rows = text.split("\n").flatMap((line) => wrapTextWithAnsi(line, width));
			for (const row of rows) expect(visibleWidth(row)).toBeLessThanOrEqual(width);
			expect(text).toContain("skill:s1");
			expect(stripAnsi(rows.join("")).replaceAll(" ", "")).toContain(item(1).detail.replaceAll(" ", ""));
		});
	}
});

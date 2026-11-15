import assert from "node:assert";
import { describe, it } from "node:test";
import { Markdown } from "../src/components/markdown.ts";
import { resetCapabilitiesCache, setCapabilities } from "../src/terminal-image/capabilities.ts";
import { visibleWidth } from "../src/utils/width.ts";
import { defaultMarkdownTheme } from "./test-themes.ts";

function render(source: string, width: number): string[] {
	setCapabilities({ images: null, trueColor: false, hyperlinks: false });
	try {
		return new Markdown(source, 0, 0, defaultMarkdownTheme)
			.render(width)
			.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());
	} finally {
		resetCapabilitiesCache();
	}
}

const words = (lines: string[]) =>
	lines
		.join(" ")
		.replace(/[│├┤┌┐└┘┬┴┼─]/g, " ")
		.split(/\s+/)
		.filter(Boolean);

const status = `| Part | State | Next step |
| --- | --- | --- |
| footer | done | Restore dropped parts in priority order once shortening frees room on the row |
| tables | ongoing | Share spare columns fairly so short columns stay whole and prose splits the rest |`;

describe("markdown table widths", () => {
	it("keeps short columns whole and wraps only the prose column", () => {
		const lines = render(status, 60);
		for (const line of lines) assert.ok(visibleWidth(line) <= 60, `wider than 60: ${line}`);
		const cells = lines.filter((line) => line.startsWith("│")).map((line) => line.split("│").map((c) => c.trim()));
		assert.ok(cells.some((row) => row[1] === "footer" && row[2] === "done"));
		assert.ok(cells.some((row) => row[1] === "tables" && row[2] === "ongoing"));
		// A short column never continues on a wrapped row of the same record.
		assert.ok(cells.every((row) => !row[1] || ["Part", "footer", "tables"].includes(row[1])));
		assert.deepStrictEqual(
			words(lines),
			words(status.split("\n").filter((l) => !l.startsWith("| ---"))).filter((w) => w !== "|"),
		);
	});

	it("renders records instead of breaking words when the columns cannot fit side by side", () => {
		const source = `| Path | Owner | Purpose |
| --- | --- | --- |
| packages/coding-agent/src/octocode/ui | interactive | footer rendering |`;
		const lines = render(source, 36);
		for (const line of lines) assert.ok(visibleWidth(line) <= 36, `wider than 36: ${line}`);
		assert.ok(!lines.some((line) => line.includes("│")), `grid drawn: ${JSON.stringify(lines)}`);
		assert.ok(lines.some((line) => /^Owner: interactive$/.test(line)));
		assert.ok(lines.some((line) => /^Purpose: footer rendering$/.test(line)));
		// Each word stays whole except the path, which is wider than the row.
		for (const word of ["interactive", "footer", "rendering"]) assert.ok(words(lines).includes(word));
	});

	it("separates stacked records and keeps every row within width", () => {
		const lines = render(status, 22);
		for (const line of lines) assert.ok(visibleWidth(line) <= 22, `wider than 22: ${line}`);
		const starts = lines.filter((line) => line.startsWith("Part:"));
		assert.deepStrictEqual(starts, ["Part: footer", "Part: tables"]);
		const between = lines.slice(lines.indexOf("Part: footer") + 1, lines.indexOf("Part: tables"));
		assert.ok(
			between.some((line) => /^─+$/.test(line)),
			`no rule between records: ${JSON.stringify(lines)}`,
		);
	});

	it("keeps a multi-word short column on one row beside a long prose column", () => {
		const source = `| Part | State | Notes |
| --- | --- | --- |
| footer | in progress | ${"restore dropped parts once the row has room again ".repeat(2).trim()} |`;
		const lines = render(source, 50);
		for (const line of lines) assert.ok(visibleWidth(line) <= 50, `wider than 50: ${line}`);
		assert.ok(
			lines.some((line) => line.includes("│ in progress │")),
			JSON.stringify(lines),
		);
	});

	it("draws the natural widths when the table fits", () => {
		const lines = render("| A | B |\n| --- | --- |\n| one | two |", 80);
		assert.ok(lines.includes("│ one │ two │"), JSON.stringify(lines));
	});
});

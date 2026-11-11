import type { Component } from "@octocodeai/octocode-tui";
import { beforeAll, describe, expect, it } from "vitest";
import { createToolHtmlRenderer } from "../src/core/export-html/tool-renderer.ts";
import type { ToolDefinition } from "../src/core/features/types.ts";
import { purposeRows, reasonRow } from "../src/octocode/ui/reason-row.ts";
import { initTheme, theme } from "../src/theme/theme.ts";

const output: Component = { render: () => ["found 3 files"], invalidate: () => {} };
const tool = {
	name: "mcp__other__search",
	label: "search",
	description: "search",
	renderResult: () => output,
} as unknown as ToolDefinition;
const html = () => createToolHtmlRenderer({ getToolRenderers: () => tool, theme, cwd: "/tmp", reasonRow, purposeRows });

describe("the purpose block in an exported tool result", () => {
	beforeAll(() => initTheme("dark"));

	it("follows the result's output with each row's own goal and reasoning", () => {
		const structured = {
			content: [],
			structuredContent: {
				results: [
					{ index: 0, mainGoal: "find the loader", reasoning: "where it starts" },
					{ index: 1, mainGoal: "find the writer" },
				],
			},
		};
		const expanded = html().renderResult("c", "mcp__other__search", [], undefined, false, structured)?.expanded ?? "";
		const text = expanded.replace(/<[^>]+>/g, "|");
		expect(text.indexOf("found 3 files")).toBeGreaterThan(-1);
		// The first goal is the title's one-line reason, above the output; the block below does not repeat it.
		expect(text.indexOf("↳ find the loader")).toBeLessThan(text.indexOf("found 3 files"));
		expect(text.indexOf("#0 where it starts")).toBeGreaterThan(text.indexOf("found 3 files"));
		expect(text.indexOf("#1 find the writer")).toBeGreaterThan(text.indexOf("#0 where it starts"));
		expect(text.split("find the loader")).toHaveLength(2);
	});

	it("reads the rows from a result that is one JSON text, with no structured content", () => {
		const rows = { results: [{ index: 0, mainGoal: "find the loader", reasoning: "where it starts" }] };
		const content = [{ type: "text", text: JSON.stringify(rows) }];
		const expanded = html().renderResult("c", "mcp__other__search", content, undefined, false)?.expanded ?? "";
		const text = expanded.replace(/<[^>]+>/g, "|");
		expect(text).toContain("↳ find the loader");
		expect(text).toContain("where it starts");
		const prose = [{ type: "text", text: "mainGoal: find the loader" }];
		expect(html().renderResult("c", "mcp__other__search", prose, undefined, false)?.expanded).not.toContain("↳");
	});

	it("has no block for a result that states no purpose, and never reads the call's arguments", () => {
		const renderer = html();
		renderer.renderCall("c", "mcp__other__search", { queries: [{ mainGoal: "from the input" }] });
		const expanded = renderer.renderResult("c", "mcp__other__search", [], undefined, false, { results: [] })?.expanded;
		expect(expanded).toContain("found 3 files");
		expect(expanded).not.toContain("from the input");
		expect(expanded).not.toContain("◎");
	});
});

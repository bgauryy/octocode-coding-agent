import type { TUI } from "@octocodeai/octocode-tui";
import { visibleWidth } from "@octocodeai/octocode-tui";
import { beforeAll, describe, expect, test } from "vitest";

import type { ToolDefinition } from "../src/core/features/types.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { resultBlock, toolHeader } from "../src/octocode/render/tool.ts";
import { initTheme, theme } from "../src/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const WIDTHS = [20, 40, 60, 80, 120];
const ui = { requestRender() {} } as unknown as TUI;
const context = (over: Record<string, unknown> = {}) => ({
	isPartial: false,
	isError: false,
	expanded: false,
	state: {},
	durationMs: 1200,
	invalidate() {},
	...over,
});
const draw = (component: { render(width: number): string[] }, width: number) =>
	component.render(width).map((line) => stripAnsi(line));

beforeAll(() => initTheme("dark"));

describe("tool header at narrow widths", () => {
	test.each(WIDTHS)("fits %i columns, never shows empty parentheses and keeps the time", (width) => {
		const header = toolHeader(theme, context(), "Search", "render in src/very/long/path/to/a/file.ts", {
			meta: "background · timeout 30s",
		});
		const [line] = draw(header, width);
		expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		expect(line).not.toContain("()");
		expect(line).toMatch(/^ ?✓ Search/);
		if (width >= 40) expect(line).toContain("1.2s");
	});

	test("the summary outranks meta when the row is short", () => {
		const [line] = draw(
			toolHeader(theme, context(), "Search", "render in src", { meta: "background · timeout 30s" }),
			40,
		);
		expect(line).toContain("(render in src)");
	});

	test("a summary that cannot fit is left out with its parentheses", () => {
		const [line] = draw(toolHeader(theme, context(), "Search", "something long"), 14);
		expect(line).not.toMatch(/[()]/);
	});
});

describe("error text wrapping", () => {
	test.each([14, 20, 28])("a long path in an error leaves no empty row at %i columns", (width) => {
		const block = resultBlock(theme, context({ isError: true }), {
			summary: "ENOENT: no such file or directory, open 'src/very/long/path/file.ts'",
		});
		const lines = draw(block, width);
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			expect(line.trim()).not.toBe("");
		}
	});
});

describe("markdown results", () => {
	const table = "| name | value |\n|---|---|\n| alpha | a rather long cell value that needs room |\n| beta | short |";
	const definition = { display: {} } as unknown as ToolDefinition;
	const row = () => {
		const component = new ToolExecutionComponent("Agent", "m1", {}, {}, definition, ui, process.cwd());
		component.setDisplay({
			title: "Agent",
			summary: "report",
			blocks: [{ type: "markdown", text: table }],
		});
		component.updateResult({ content: [{ type: "text", text: "report" }], isError: false, durationMs: 10 });
		component.setExpanded(true);
		return component;
	};

	test.each(WIDTHS)("tables stay whole and inside %i columns", (width) => {
		const lines = draw(row(), width);
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		const text = lines.join("\n");
		// Every table border row is one row: a top and a bottom corner each appear once.
		expect(text.match(/┌/g)?.length ?? 0).toBeLessThanOrEqual(1);
		expect(text.match(/┐/g)?.length ?? 0).toBe(text.match(/┌/g)?.length ?? 0);
		const rows = lines.filter((line) => line.includes("│"));
		const starts = rows.map((line) => line.trimStart()[0]);
		expect(starts.every((char) => char === "│")).toBe(true);
	});

	test("a table uses the width the row has, not a fixed one", () => {
		const wide = draw(row(), 140).join("\n");
		expect(wide).toContain("a rather long cell value that needs room");
	});
});

describe("a tool without a renderer", () => {
	const definition = undefined;
	test.each(WIDTHS)("wears the native header and gutter at %i columns", (width) => {
		const component = new ToolExecutionComponent(
			"mcp__server__lookup",
			"g1",
			{ query: "needle", path: "src/very/long/path", flag: true },
			{},
			definition,
			ui,
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "first\nsecond" }], isError: false, durationMs: 1200 });
		const lines = draw(component, width).filter((line) => line.trim() !== "");
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		expect(lines[0]).toMatch(/^ ?✓ mcp__server/);
		expect(lines[0]).not.toContain("query=");
		expect(lines.slice(1).join("\n")).toContain("⎿");
		expect(lines.join("\n")).not.toContain("()");
	});
});

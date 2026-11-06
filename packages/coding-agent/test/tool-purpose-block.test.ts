import { Text, type TUI, visibleWidth } from "@octocodeai/octocode-tui";
import { Type } from "typebox";
import { beforeAll, describe, expect, it } from "vitest";
import type { ToolDefinition } from "../src/core/features/types.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import type { ToolExecutionResult } from "../src/modes/interactive/components/tool-execution/types.ts";
import { purposeBlock } from "../src/octocode/ui/purpose-block.ts";
import { purposeRows } from "../src/octocode/ui/reason-row.ts";
import { initTheme, theme } from "../src/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const ui = { requestRender: () => {} } as unknown as TUI;
const definition = (name: string): ToolDefinition => ({
	name,
	label: name,
	description: "test",
	parameters: Type.Any(),
	execute: async () => ({ content: [], details: {} }),
	renderCall: () => new Text(name, 0, 0),
});
const MCP = "mcp__other__search";
const returned = (results: Array<Record<string, string | number>>) => ({ content: [], structuredContent: { results } });
const resultRow = (
	name: string,
	args: unknown,
	structuredContent: ToolExecutionResult["structuredContent"],
	withRenderer: boolean,
) => {
	const component = new ToolExecutionComponent(
		name,
		"call-1",
		args,
		{},
		withRenderer ? definition(name) : undefined,
		ui,
		process.cwd(),
	);
	component.updateResult({ content: [{ type: "text", text: "found 3 files" }], structuredContent, isError: false });
	return component;
};
const text = (component: ToolExecutionComponent, width = 80) =>
	component
		.render(width)
		.map(stripAnsi)
		.map((line) => line.trimEnd())
		.filter((line) => line.trim());
const block = (structuredContent: unknown, width = 80, shown?: string) =>
	purposeBlock(structuredContent, shown)?.render(width).map(stripAnsi);

describe("the purpose block below a tool result", () => {
	beforeAll(() => initTheme("dark"));

	it("states a goal shared by every row once, with a numbered reasoning per row", () => {
		const structured = returned([
			{ index: 0, mainGoal: "map the parser", reasoning: "entry point" },
			{ index: 1, mainGoal: "map the parser", reasoning: "its callers" },
		]);
		for (const withRenderer of [true, false]) {
			const lines = text(resultRow(MCP, {}, structured, withRenderer));
			// The title's one-line reason already shows the goal, so only the rows follow the output.
			expect(
				lines.map((line) => line.trim()),
				String(withRenderer),
			).toEqual(expect.arrayContaining(["↳ map the parser", "· #0 entry point", "· #1 its callers"]));
			expect(lines.filter((line) => line.includes("map the parser"))).toHaveLength(1);
			const output = lines.findIndex((line) => line.includes("found 3 files"));
			expect(lines.findIndex((line) => line.includes("· #0"))).toBeGreaterThan(output);
		}
	});

	it("draws the shared goal line when the title shows another text", () => {
		const lines = block(
			{ results: [{ index: 0, mainGoal: "map the parser", reasoning: "entry point" }] },
			80,
			"elsewhere",
		);
		expect(lines).toEqual(["  ◎ map the parser", "    · entry point"]);
	});

	it("draws one line per row when the rows state different goals", () => {
		const lines = block({
			results: [
				{ index: 0, mainGoal: "find the loader", reasoning: "where it starts" },
				{ index: 1, mainGoal: "find the writer" },
				{ index: 2, reasoning: "just why" },
			],
		});
		expect(lines).toEqual(["  #0 find the loader — where it starts", "  #1 find the writer", "  #2 just why"]);
	});

	it("shows nothing before a result exists", () => {
		const component = new ToolExecutionComponent(MCP, "c", {}, {}, undefined, ui, process.cwd());
		expect(text(component).join("\n")).not.toContain("·");
	});

	it("is the same collapsed and expanded", () => {
		const component = resultRow(MCP, {}, returned([{ index: 0, mainGoal: "a goal", reasoning: "a reason" }]), false);
		const collapsed = text(component);
		component.setExpanded(true);
		expect(text(component).filter((line) => line.includes("a reason"))).toEqual(
			collapsed.filter((line) => line.includes("a reason")),
		);
		expect(collapsed.join("\n")).toContain("· a reason");
	});

	it("caps at six lines with the rest counted", () => {
		const rows = Array.from({ length: 9 }, (_, index) => ({ index, mainGoal: `goal ${index}`, reasoning: "why" }));
		const lines = block({ results: rows })!;
		expect(lines).toHaveLength(7);
		expect(lines[5]).toContain("#5 goal 5");
		expect(lines[6].trim()).toBe("… +3 more");
	});

	it("cuts each line to the width and strips escapes and line breaks", () => {
		const long = "trace why the build is slow ".repeat(8);
		for (const width of [12, 30, 60]) {
			for (const line of purposeBlock({ results: [{ index: 0, mainGoal: long, reasoning: `${long}!` }] })!.render(
				width,
			))
				expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
		const hostile = block({
			results: [{ mainGoal: "one\n\u001b]0;title\u0007two", reasoning: "a\r\nb" }, { mainGoal: "other" }],
		})!.join("\n");
		expect(hostile).toContain("#0 one two — a b");
		expect(hostile).not.toContain("title");
	});

	it("keeps the server's text whole in the stored result", () => {
		const structured = returned([{ index: 0, mainGoal: "  padded goal  ", reasoning: "line one\nline two" }]);
		const before = JSON.stringify(structured);
		text(resultRow(MCP, {}, structured, false));
		expect(JSON.stringify(structured)).toBe(before);
	});

	it("does not repeat the text of the title's one-line reason", () => {
		const lines = text(
			resultRow(MCP, {}, returned([{ index: 0, mainGoal: "find the loader", reasoning: "find the loader" }]), false),
		);
		expect(lines.filter((line) => line.includes("find the loader"))).toHaveLength(1);
	});

	it("never takes anything from a native tool's arguments", () => {
		const args = { command: "ls", reason: "list the folder", mainGoal: "from args", reasoning: "also from args" };
		for (const withRenderer of [true, false]) {
			const lines = text(resultRow("bash", args, undefined, withRenderer));
			expect(lines.join("\n")).toContain("↳ list the folder");
			// Below the result message nothing follows: the call's own arguments are not a purpose.
			expect(lines.slice(lines.findIndex((line) => line.includes("found 3 files")) + 1)).toEqual([]);
		}
		expect(purposeRows("bash", args, undefined)).toBeUndefined();
		expect(purposeRows(MCP, { queries: [{ mainGoal: "from args" }] }, { results: [] })).toBeUndefined();
	});

	it("uses the toolReason color, italic for reasoning, upright for a goal", () => {
		const rendered = purposeRows(MCP, undefined, { results: [{ mainGoal: "g", reasoning: "r" }] })!.render(40);
		expect(rendered[0]).toContain(theme.fg("toolReason", "◎ g"));
		expect(rendered[0]).not.toContain(theme.italic(theme.fg("toolReason", "◎ g")));
		expect(rendered[1]).toContain(theme.italic(theme.fg("toolReason", "  · r")));
	});
});

import type { TUI } from "@octocodeai/octocode-tui";
import { Type } from "typebox";
import { beforeAll, describe, expect, it } from "vitest";
import type { ToolDefinition } from "../../src/core/features/types.ts";
import { ToolExecutionComponent } from "../../src/modes/interactive/components/tool-execution.ts";
import { renderFileCall } from "../../src/octocode/files/render.ts";
import { initTheme } from "../../src/theme/theme.ts";
import { stripAnsi } from "../../src/utils/ansi.ts";

const ui = { requestRender: () => {} } as unknown as TUI;
const definition: ToolDefinition = {
	name: "file",
	label: "file",
	description: "test",
	parameters: Type.Any(),
	execute: async () => ({ content: [], details: {} }),
	renderCall: renderFileCall as unknown as ToolDefinition["renderCall"],
};
const rows = (args: unknown, expanded: boolean) => {
	const component = new ToolExecutionComponent("file", "call-1", args, {}, definition, ui, process.cwd());
	component.setExpanded(expanded);
	return component
		.render(100)
		.map((line) => stripAnsi(line).trimEnd())
		.filter((line) => line.trim());
};
const count = (lines: string[], text: string) => lines.join("\n").split(text).length - 1;
const change = (path: string, reason: string) => ({
	type: "edit",
	path,
	reason,
	edits: [{ oldText: "a", newText: "b" }],
});

describe("a file call states each reason once, through the shared purpose row", () => {
	beforeAll(() => initTheme("dark"));

	for (const expanded of [false, true]) {
		const mode = expanded ? "expanded" : "collapsed";

		it(`one change with a call reason (${mode})`, () => {
			const lines = rows({ reason: "Fix the file", queries: [change("a.ts", "Fix A")] }, expanded);
			expect(count(lines, "Fix the file")).toBe(1);
			expect(count(lines, "Fix A")).toBe(1);
			expect(lines.join("\n")).toContain("a.ts");
		});

		it(`one change whose call reason says nothing (${mode})`, () => {
			const lines = rows({ reason: "Edit", queries: [change("a.ts", "Fix A")] }, expanded);
			expect(count(lines, "Fix A")).toBe(1);
		});

		it(`two changes (${mode})`, () => {
			const lines = rows(
				{ reason: "Fix the two files", queries: [change("a.ts", "Fix A"), change("b.ts", "Fix B")] },
				expanded,
			);
			for (const text of ["Fix the two files", "Fix A", "Fix B"]) expect(count(lines, text), text).toBe(1);
			expect(lines.join("\n")).toContain("a.ts");
			expect(lines.join("\n")).toContain("b.ts");
			expect(lines.map((line) => line.trim())).toEqual(expect.arrayContaining(["↳ 1 · Fix A", "↳ 2 · Fix B"]));
		});
	}
});

import { Text, type TUI } from "@octocodeai/octocode-tui";
import { Type } from "typebox";
import { beforeAll, describe, expect, it } from "vitest";
import { createMcpToolRenderers } from "../../../mcp/src/tool-definition.ts";
import type { ToolDefinition } from "../../src/core/features/types.ts";
import { formatToolCallWithArgs } from "../../src/core/tools/render-utils.ts";
import { ToolExecutionComponent } from "../../src/modes/interactive/components/tool-execution.ts";
import { installMcpRenderPort } from "../../src/octocode/mcp-host/render.ts";
import { initTheme, theme } from "../../src/theme/theme.ts";
import { stripAnsi } from "../../src/utils/ansi.ts";

const ui = { requestRender: () => {} } as unknown as TUI;
const MCP = "mcp__octocode__localSearch";
const paint = (token: Parameters<typeof theme.fg>[0], text: string) => theme.fg(token, text);

describe("call arguments are coloured like JSON", () => {
	beforeAll(() => {
		initTheme("dark");
		installMcpRenderPort();
	});

	it("colours keys, strings, numbers and punctuation of an expanded value", () => {
		const out = formatToolCallWithArgs("tool", { filter: { name: "abc", limit: 5 } }, theme, true);
		expect(out).toContain(paint("syntaxVariable", '"name"'));
		expect(out).toContain(paint("syntaxString", '"abc"'));
		expect(out).toContain(paint("syntaxNumber", "5"));
		expect(out).toContain(paint("syntaxPunctuation", "{"));
		expect(stripAnsi(out)).toContain('"name": "abc"');
	});

	it("colours collapsed key=value pairs without changing their text", () => {
		const out = formatToolCallWithArgs("tool", { limit: 5, path: "src" }, theme, false);
		expect(out).toContain(paint("syntaxNumber", "5"));
		expect(out).toContain(paint("syntaxString", '"src"'));
		expect(stripAnsi(out)).toBe('tool limit=5 path="src"');
	});

	it("caps one expanded value near 4 KB with an ellipsis", () => {
		const big = { rows: Array.from({ length: 3000 }, (_, index) => `item-${index}`) };
		const shown = stripAnsi(formatToolCallWithArgs("tool", big, theme, true));
		// 4096 characters of value, plus the four-space continuation indent of each pretty-printed line.
		expect(shown.length).toBeLessThan(6000);
		expect(shown.endsWith("…")).toBe(true);
		const text = stripAnsi(formatToolCallWithArgs("tool", { body: "x".repeat(50_000) }, theme, true));
		expect(text.length).toBeLessThan(4300);
		expect(text).toContain("…");
	});

	it("colours the arguments of a generic tool row and an MCP row when expanded", () => {
		const generic = new ToolExecutionComponent("custom", "c", { limit: 7 }, {}, undefined, ui, process.cwd());
		generic.setExpanded(true);
		expect(generic.render(80).join("\n")).toContain(paint("syntaxNumber", "7"));
		const definition: ToolDefinition = {
			name: MCP,
			label: MCP,
			description: "t",
			parameters: Type.Any(),
			execute: async () => ({ content: [], details: {} }),
			renderCall: createMcpToolRenderers("octocode/localSearch").renderCall as ToolDefinition["renderCall"],
		};
		const row = new ToolExecutionComponent(MCP, "c", { queries: [{ limit: 7 }] }, {}, definition, ui, process.cwd());
		row.setExpanded(true);
		const rendered = row.render(80).join("\n");
		expect(rendered).toContain(paint("syntaxNumber", "7"));
		expect(rendered).toContain(paint("syntaxVariable", '"limit"'));
		void Text;
	});
});

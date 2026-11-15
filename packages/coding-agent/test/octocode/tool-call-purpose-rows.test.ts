import { Text, type TUI, visibleWidth } from "@octocodeai/octocode-tui";
import { Type } from "typebox";
import { beforeAll, describe, expect, it } from "vitest";
import { createMcpToolRenderers } from "../../../mcp/src/tool-definition.ts";
import type { ToolDefinition } from "../../src/core/features/types.ts";
import { ToolExecutionComponent } from "../../src/modes/interactive/components/tool-execution.ts";
import { installMcpRenderPort } from "../../src/octocode/mcp-host/render.ts";
import { renderAgentCall } from "../../src/octocode/subagents/render.ts";
import { initTheme } from "../../src/theme/theme.ts";
import { stripAnsi } from "../../src/utils/ansi.ts";

const ui = { requestRender: () => {} } as unknown as TUI;
const MCP = "mcp__octocode__localSearch";

const native = (name: string): ToolDefinition => ({
	name,
	label: name,
	description: "test",
	parameters: Type.Any(),
	execute: async () => ({ content: [], details: {} }),
	renderCall: () => new Text(`${name} title`, 0, 0),
});
const mcpTool = (name: string): ToolDefinition => ({
	...native(name),
	renderCall: createMcpToolRenderers("octocode/localSearch").renderCall as ToolDefinition["renderCall"],
});
const agentTool = (): ToolDefinition => ({
	...native("agent"),
	renderCall: renderAgentCall as unknown as ToolDefinition["renderCall"],
});
const rows = (name: string, args: unknown, definition: ToolDefinition | undefined, expanded = false, width = 100) => {
	const component = new ToolExecutionComponent(name, "call-1", args, {}, definition, ui, process.cwd());
	component.setExpanded(expanded);
	return component
		.render(width)
		.map((line) => stripAnsi(line).trimEnd())
		.filter((line) => line.trim());
};
const arrows = (lines: string[]) => lines.map((line) => line.trim()).filter((line) => line.startsWith("↳"));
const queries = (count: number) =>
	Array.from({ length: count }, (_, index) => ({
		keywords: [`word${index}`],
		path: "src",
		mainGoal: `Find owner ${index}`,
		reasoning: `Because reason ${index}`,
	}));

describe("one purpose line style for every tool call", () => {
	beforeAll(() => {
		initTheme("dark");
		installMcpRenderPort();
	});

	it("draws native, MCP with queries, MCP with one query and agent rows with the same ↳ line", () => {
		const lines = [
			rows("bash", { command: "ls", reason: "List the folder" }, native("bash")),
			rows(MCP, { queries: queries(2) }, mcpTool(MCP)),
			rows(MCP, { queries: queries(1) }, mcpTool(MCP)),
			rows("agent", { goal: "Audit it", reason: "Independent check" }, agentTool()),
		];
		for (const text of lines) expect(arrows(text).length).toBeGreaterThan(0);
		expect(arrows(lines[0])).toEqual(["↳ List the folder"]);
		expect(arrows(lines[1])).toEqual([
			"↳ 1 · Find owner 0 — Because reason 0",
			"↳ 2 · Find owner 1 — Because reason 1",
		]);
		expect(arrows(lines[2])).toEqual(["↳ Find owner 0 — Because reason 0"]);
		expect(arrows(lines[3])).toEqual(["↳ Independent check"]);
		for (const text of lines) {
			const joined = text.join("\n");
			expect(joined).not.toContain("Call");
			expect(joined).not.toContain("Query 1");
			expect(joined).not.toContain("Reason:");
		}
	});

	it("shows no purpose text twice, collapsed or expanded, with or without a renderer", () => {
		const args = { queries: queries(2), reason: "Whole call reason" };
		for (const expanded of [false, true])
			for (const definition of [mcpTool(MCP), undefined]) {
				const joined = rows(MCP, args, definition, expanded).join("\n");
				for (const text of ["Find owner 0", "Because reason 1", "Whole call reason"])
					expect(joined.split(text).length - 1, `${text} ${expanded} ${Boolean(definition)}`).toBe(1);
				expect(joined).not.toContain("mainGoal");
				expect(joined).not.toContain("reasoning");
			}
	});

	it("puts the generic path's purpose under the title, before the arguments", () => {
		const lines = rows("mcp", { intent: "list", reason: "Check server state" }, undefined, true).map((line) =>
			line.trim(),
		);
		const purpose = lines.findIndex((line) => line === "↳ Check server state");
		expect(purpose).toBe(1);
		expect(lines.findIndex((line) => line.includes("intent:"))).toBeGreaterThan(purpose);
	});

	it("counts +K more queries by query, not by display line", () => {
		const collapsed = rows(MCP, { queries: queries(8) }, mcpTool(MCP));
		expect(arrows(collapsed)).toHaveLength(3);
		expect(arrows(collapsed)[2]).toContain("3 · Find owner 2");
		expect(collapsed.join("\n")).toContain("+5 more queries");
		const expanded = rows(MCP, { queries: queries(8) }, mcpTool(MCP), true);
		expect(arrows(expanded)).toHaveLength(8);
		expect(expanded.join("\n")).not.toContain("more queries");
		expect(rows(MCP, { queries: queries(3) }, mcpTool(MCP)).join("\n")).not.toContain("more queries");
	});

	it("gives MCP calls the shared header: state mark, label and a short summary", () => {
		const [title] = rows(MCP, { queries: queries(2) }, mcpTool(MCP));
		expect(title.trim()).toMatch(/^\S+ octocode\/localSearch/);
		expect(title).not.toContain("queries=[");
		expect(title).not.toContain("mainGoal");
	});

	it("shows an agent's whole goal when expanded and the title clipped it", () => {
		const goal = "Audit the tool purpose display for every family and list each inconsistency with its evidence";
		const args = { goal, reason: "Independent check" };
		const collapsed = rows("agent", args, agentTool());
		expect(collapsed[0]).toContain("…");
		expect(collapsed.join("\n")).not.toContain(goal);
		expect(rows("agent", args, agentTool(), true).join(" ").replace(/\s+/g, " ")).toContain(goal);
		const short = rows("agent", { goal: "Audit it", reason: "Independent check" }, agentTool(), true);
		expect(short.join("\n").split("Audit it")).toHaveLength(2);
	});

	it("never exceeds the width", () => {
		for (const width of [20, 40, 100])
			for (const line of rows(MCP, { queries: queries(8) }, mcpTool(MCP), false, width))
				expect(visibleWidth(line)).toBeLessThanOrEqual(width);
	});
});

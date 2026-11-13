import type { Component } from "@octocodeai/octocode-tui";
import { beforeAll, describe, expect, it } from "vitest";
import { createToolHtmlRenderer } from "../src/core/export-html/tool-renderer.ts";
import type { ToolDefinition } from "../src/core/features/types.ts";
import { purposeRows, reasonRow } from "../src/octocode/ui/reason-row.ts";
import { initTheme, theme } from "../src/theme/theme.ts";
import { genericToolDisplay } from "../src/core/application/transcript-display.ts";

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
	it("keeps supplied and returned metadata for tools using structured displays", () => {
		const displayTool = { ...tool, display: () => genericToolDisplay(tool.name, "files", "Found files", "completed") };
		const renderer = createToolHtmlRenderer({
			getToolRenderers: () => displayTool,
			theme,
			cwd: "/tmp",
			reasonRow,
			purposeRows,
			width: 40,
		});
		const call =
			renderer.renderCall("display", tool.name, {
				queries: [{ mainGoal: "Find the provided owner", reasoning: "Read the provided path" }],
			}) ?? "";
		const callText = call.replace(/<[^>]+>/g, "").replace(/\s+/g, " ");
		expect(callText).toContain("Find the provided owner");
		expect(callText).toContain("Read the provided path");
		const returned =
			renderer.renderResult("display", tool.name, [], undefined, false, {
				queries: [{ mainGoal: "Confirm returned owner", reasoning: "Read the returned path" }],
			})?.expanded ?? "";
		const text = returned.replace(/<[^>]+>/g, "").replace(/\s+/g, " ");
		expect(text).toContain("Confirm returned owner");
		expect(text).toContain("Read the returned path");
	});
	it("does not duplicate a native reason already shown by a structured call display", () => {
		const displayTool = {
			...tool,
			name: "bash",
			display: () => ({ ...genericToolDisplay("bash", "files", "", "running"), reason: "Check lifecycle" }),
		};
		const renderer = createToolHtmlRenderer({
			getToolRenderers: () => displayTool,
			theme,
			cwd: "/tmp",
			reasonRow,
			purposeRows,
		});
		const shown =
			renderer.renderCall("native-display", "bash", { reason: "Check lifecycle", mainGoal: "Find owner" }) ?? "";
		const text = shown.replace(/<[^>]+>/g, "");
		expect(text.split("Check lifecycle")).toHaveLength(2);
		expect(text).toContain("Find owner");
	});
	it("keeps all long returned metadata in expanded HTML rather than its six-row preview", () => {
		const queries = Array.from({ length: 9 }, (_, index) => ({
			mainGoal: `Goal ${index} with a complete ending`,
			reasoning: `Reason ${index} with every supplied word retained`,
		}));
		const renderer = createToolHtmlRenderer({
			getToolRenderers: () => tool,
			theme,
			cwd: "/tmp",
			reasonRow,
			purposeRows,
			width: 30,
		});
		const rendered = renderer.renderResult("long", tool.name, [], undefined, false, { queries });
		const expanded = (rendered?.expanded ?? "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ");
		for (const query of queries) {
			expect(expanded).toContain(query.mainGoal);
			expect(expanded).toContain(query.reasoning);
		}
		expect(rendered?.collapsed).toContain("more");
	});

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
		const text = expanded.replace(/<[^>]+>/g, "");
		expect(text.indexOf("found 3 files")).toBeGreaterThan(-1);
		// Different goals retain their query association instead of promoting the first to an anonymous heading.
		expect(text).not.toContain("↳ find the loader");
		expect(text.indexOf("Query 1 · Goal: find the loader")).toBeGreaterThan(text.indexOf("found 3 files"));
		expect(text.indexOf("Query 2 · Goal: find the writer")).toBeGreaterThan(
			text.indexOf("Query 1 · Goal: find the loader"),
		);
		expect(text).toContain("where it starts");
		expect(text.split("find the loader")).toHaveLength(2);
	});

	it("reads the rows from a result that is one JSON text, with no structured content", () => {
		const rows = { results: [{ index: 0, mainGoal: "find the loader", reasoning: "where it starts" }] };
		const content = [{ type: "text", text: JSON.stringify(rows) }];
		const expanded = html().renderResult("c", "mcp__other__search", content, undefined, false)?.expanded ?? "";
		const text = expanded.replace(/<[^>]+>/g, "");
		expect(text).toContain("Query 1 · Goal: find the loader");
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

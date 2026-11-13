import { Text, type TUI, visibleWidth, setKeybindings, getKeybindings } from "@octocodeai/octocode-tui";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { reasonRow, purposeRows, toolArgsForDisplay } from "../src/octocode/ui/reason-row.ts";
import { initTheme } from "../src/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const MCP = "mcp__octocode__localSearch";
const originalKeybindings = getKeybindings();
const ui = { requestRender() {} } as unknown as TUI;
const plain = (component: { render(width: number): string[] } | undefined, width = 40) =>
	component?.render(width).map(stripAnsi).join("\n") ?? "";
const row = (args: unknown, custom = false) =>
	new ToolExecutionComponent(
		MCP,
		"purpose-call",
		args,
		{},
		custom ? { renderCall: () => new Text("Search", 0, 0) } : undefined,
		ui,
		process.cwd(),
	);

describe("provided tool purpose metadata", () => {
	beforeAll(() => initTheme("dark"));
	afterEach(() => setKeybindings(originalKeybindings));
	it("keeps non-string mechanical fields in the display copy", () => {
		const args = { mainGoal: "Find owner", reason: { code: 1 }, reasoning: 0 };
		expect(toolArgsForDisplay(MCP, args)).toEqual({ reason: { code: 1 }, reasoning: 0 });
	});
	it("numbers input queries by position without treating a mechanical index argument as result correlation", () => {
		const args = { queries: [{ index: 9, mainGoal: "Find owner" }] };
		expect(plain(reasonRow(MCP, args, undefined, true))).toContain("Query 1");
		expect(toolArgsForDisplay(MCP, args)).toEqual({ queries: [{ index: 9 }] });
	});

	it("shows every supplied query goal and reason before any result exists", () => {
		const args = {
			queries: [
				{ path: "src", mainGoal: "Find render stalls", reasoning: "Trace redraw work" },
				{ path: "db", mainGoal: "Find save delays", reason: "Trace queued writes" },
			],
		};
		for (const custom of [false, true]) {
			const component = row(args, custom);
			component.setExpanded(true);
			const shown = plain(component).replace(/\s+/g, " ");
			for (const query of args.queries) {
				expect(shown).toContain(query.mainGoal);
				expect(shown).toContain(query.reasoning ?? query.reason);
			}
			expect(shown).toContain("Query 1");
			expect(shown).toContain("Query 2");
		}
	});

	it("retains a top-level goal and distinct reason and reasoning without changing source data", () => {
		const args = { mainGoal: "Find the owner", reason: "Check its lifecycle", reasoning: "Avoid stale sessions" };
		const before = JSON.stringify(args);
		const shown = plain(reasonRow("bash", args, undefined, true), 80);
		for (const value of Object.values(args)) expect(shown).toContain(value);
		expect(JSON.stringify(args)).toBe(before);
	});
	it("does not turn a returned top-level goal into a numbered query", () => {
		const data = {
			mainGoal: "Overall goal",
			queries: [{ mainGoal: "First query goal" }, { mainGoal: "Second query goal" }],
		};
		const shown = plain(purposeRows(MCP, {}, data, true), 80);
		expect(shown.split("\n").find((line) => line.includes("Overall goal"))).not.toContain("Query");
		expect(shown).toContain("Query 1 · Goal: First query goal");
		expect(shown).toContain("Query 2 · Goal: Second query goal");
	});

	it("keeps returned query indices across out-of-order results and row.data", () => {
		const data = {
			results: [
				{ index: 2, data: { mainGoal: "Find writer", reasoning: "Trace the queue" } },
				{ index: 0, data: { mainGoal: "Find reader", reason: "Trace the snapshot" } },
			],
		};
		const shown = plain(purposeRows(MCP, {}, data, true), 80);
		expect(shown).toContain("Query 3 · Goal: Find writer");
		expect(shown).toContain("Query 1 · Goal: Find reader");
		expect(shown).toContain("Trace the queue");
		expect(shown).toContain("Trace the snapshot");
	});

	it("does not deduplicate identical purposes belonging to different queries", () => {
		const queries = [0, 1].map(() => ({ mainGoal: "Shared goal", reasoning: "Shared reason" }));
		const shown = plain(reasonRow(MCP, { queries }, undefined, true), 80);
		expect(shown).toContain("Query 1 · Reason: Shared reason");
		expect(shown).toContain("Query 2 · Reason: Shared reason");
	});

	it("deduplicates an echoed purpose only for its corresponding query", () => {
		const queries = [{ mainGoal: "Shared goal", reasoning: "Shared reason" }];
		expect(purposeRows(MCP, { queries }, { queries }, true)).toBeUndefined();
		const different = plain(purposeRows(MCP, { queries }, { results: [{ index: 2, ...queries[0] }] }, true), 80);
		expect(different).toContain("Shared goal");
		expect(different).toContain("Shared reason");
	});
	it("renders call metadata once across multiple result content blocks", () => {
		const component = row({
			queries: [{ mainGoal: "Keep the supplied purpose", reasoning: "Read both output blocks" }],
		});
		component.setExpanded(true);
		component.updateResult({
			content: [
				{ type: "text", text: "First block" },
				{ type: "text", text: "Second block" },
			],
			isError: false,
		});
		const shown = plain(component, 80);
		expect(shown.split("Keep the supplied purpose")).toHaveLength(2);
		expect(shown).toContain("First block");
		expect(shown).toContain("Second block");
	});

	it("sanitizes controls and never mines payloads, internal objects, or JSON strings", () => {
		const args = { queries: [{ mainGoal: "Find\n\x1b]0;bad-title\x07the owner", reasoning: "Check\r\nthe caller" }] };
		const shown = plain(reasonRow(MCP, args, undefined, true), 80);
		expect(shown).toContain("Find the owner");
		expect(shown).toContain("Check the caller");
		expect(shown).not.toContain("bad-title");
		for (const data of [
			{ payload: [{ mainGoal: "Private payload", reasoning: "Internal value" }] },
			{ internal: { mainGoal: "Private field", reasoning: "Internal value" } },
			JSON.stringify({ queries: [{ mainGoal: "JSON input" }] }),
		]) {
			expect(reasonRow(MCP, data)).toBeUndefined();
			expect(purposeRows(MCP, {}, data)).toBeUndefined();
		}
	});

	it("makes complete long metadata available through the supported expansion action", () => {
		const bindings = getKeybindings();
		setKeybindings(new KeybindingsManager());
		const queries = Array.from({ length: 9 }, (_, index) => ({
			mainGoal: `Goal ${index}`,
			reasoning: `Reason ${index} with every word retained at narrow widths`,
		}));
		const component = row({ queries });
		const collapsed = plain(component);
		expect(collapsed).toContain("more");
		expect(collapsed).toContain("ctrl+o");
		component.setExpanded(true);
		const expanded = plain(component).replace(/\s+/g, " ");
		for (const query of queries) {
			expect(expanded).toContain(query.mainGoal);
			expect(expanded).toContain(query.reasoning);
		}
		for (const line of component.render(40)) expect(visibleWidth(line)).toBeLessThanOrEqual(40);
		setKeybindings(bindings);
	});

	it("puts metadata before compact full arguments and output without duplicating argument purpose fields", () => {
		const args = {
			queries: [
				{ path: "src", matchString: ["render"], mainGoal: "Find render stalls", reasoning: "Trace redraw work" },
			],
		};
		const before = JSON.stringify(args);
		const component = row(args);
		component.setExpanded(true);
		component.updateResult({
			content: [{ type: "text", text: "Found files" }],
			structuredContent: { queries: [{ mainGoal: "Confirm ownership", reasoning: "Read scheduler" }] },
			isError: false,
		});
		const shown = plain(component, 100);
		expect(shown.indexOf("Find render stalls")).toBeGreaterThan(shown.indexOf("Arguments"));
		expect(shown).toContain("Call");
		expect(shown).toContain("Result");
		expect(shown.indexOf("Confirm ownership")).toBeLessThan(shown.indexOf("Found files"));
		expect(shown.split("Find render stalls")).toHaveLength(2);
		expect(shown).toContain('path="src"');
		expect(shown).toContain('matchString=["render"]');
		expect(JSON.stringify(args)).toBe(before);
	});

	it("reads one returned JSON content envelope through the existing result-purpose contract", () => {
		const component = row({});
		component.setExpanded(true);
		component.updateResult({
			content: [
				{
					type: "text",
					text: JSON.stringify({ queries: [{ mainGoal: "Find returned owner", reasoning: "Check returned row" }] }),
				},
			],
			isError: false,
		});
		const shown = plain(component, 80);
		expect(shown).toContain("Result");
		expect(shown).toContain("Query 1 · Goal: Find returned owner");
		expect(shown).toContain("Query 1 · Reason: Check returned row");
		expect(shown).toContain("Find returned owner");
		expect(shown).toContain("Check returned row");
	});
});

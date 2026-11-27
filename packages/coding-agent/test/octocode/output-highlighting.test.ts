/**
 * Output highlighting on rendered rows: colour codes sit on the right tokens, and text that is not code, JSON, a diff
 * or a shell message keeps the plain output colour.
 */
import type { TUI } from "@octocodeai/octocode-tui";
import { beforeAll, describe, expect, it } from "vitest";
import type { ToolDisplay } from "@octocodeai/octocode-contracts";
import { createMcpToolDefinition } from "../../../mcp/src/tool-definition.ts";
import { BashExecutionComponent } from "../../src/modes/interactive/components/bash-execution.ts";
import { displayRenderers } from "../../src/modes/interactive/components/tool-execution/display.ts";
import { installMcpUiPort } from "../../src/modes/interactive/mcp-ui.ts";
import { installMcpRenderPort } from "../../src/octocode/mcp-host/render.ts";
import { renderBashResult } from "../../src/octocode/files/render.ts";
import { withBuiltInRenderers } from "../../src/octocode/files/built-in-renderers.ts";
import { renderDiff } from "../../src/theme/diff.ts";
import { getMarkdownTheme, highlightCode, initTheme, theme } from "../../src/theme/theme.ts";
import { resolveLanguage } from "../../src/utils/syntax-highlight.ts";

beforeAll(() => {
	initTheme("dark");
	installMcpRenderPort();
	installMcpUiPort();
});

const ANSI = new RegExp(String.raw`\x1b\[[0-9;]*m`, "g");
const FG = new RegExp(String.raw`\x1b\[38;[0-9;]+m`, "g");
const plain = (text: string) => text.replace(ANSI, "");
/** The distinct foreground colours used in `text`. */
const colours = (text: string) => new Set(text.match(FG)).size;

const TS = ['import { a } from "./a";', "export function f(x: number): string {", "\treturn String(x) + 1;", "}"].join(
	"\n",
);

const mcp = createMcpToolDefinition({
	server: "s",
	tool: { name: "fetch", description: "Fetch.", inputSchema: { type: "object" } },
	name: "mcp__s__fetch",
	exposure: "direct",
	namespace: { name: "mcp__s" },
	timeoutMs: 1000,
	getClient: async () => ({ callTool: async () => ({ content: [] }) }),
});

/** The MCP result row for `text` of a call with `args`. */
function mcpRows(text: string, args: unknown, expanded: boolean, isError = false): string[] {
	return mcp.renderResult!(
		{ content: [{ type: "text", text }], details: { server: "s", tool: "fetch" } },
		{ expanded, isPartial: false },
		theme,
		{ args, isPartial: false, isError, showImages: false, lastComponent: undefined, expanded } as never,
	).render(200);
}

describe("code results are coloured by the file they came from", () => {
	it("colours a result whose call names a source file", () => {
		const rows = mcpRows(TS, { path: "src/a.ts" }, true).join("\n");
		expect(colours(rows)).toBeGreaterThanOrEqual(3);
		expect(plain(rows)).toContain("export function f(x: number): string {");
	});

	it("finds the file in a nested query and in fullPath", () => {
		expect(colours(mcpRows(TS, { queries: [{ path: "src/a.ts" }] }, true).join("\n"))).toBeGreaterThanOrEqual(3);
		expect(colours(mcpRows(TS, { fullPath: "/x/y/a.ts" }, true).join("\n"))).toBeGreaterThanOrEqual(3);
	});

	it("leaves a result plain when no file is named, the language is unknown, or the call failed", () => {
		const one = theme.fg("toolOutput", "x").match(FG)?.length ?? 0;
		expect(one).toBe(1);
		expect(colours(mcpRows(TS, {}, true).join("\n"))).toBe(1);
		expect(colours(mcpRows(TS, { path: "notes.unknownext" }, true).join("\n"))).toBe(1);
		expect(colours(mcpRows(TS, { path: "src/a.ts" }, true, true).join("\n"))).toBe(1);
	});

	it("leaves a result with a line over 4 KiB plain", () => {
		const long = `${TS}\nconst s = "${"x".repeat(5000)}";`;
		expect(colours(mcpRows(long, { path: "src/a.ts" }, true).join("\n"))).toBe(1);
	});

	it("colours only the lines a collapsed row shows", () => {
		const many = Array.from({ length: 400 }, (_, i) => `const v${i} = ${i}; // n`).join("\n");
		const collapsed = mcpRows(many, { path: "src/a.ts" }, false);
		const expanded = mcpRows(many, { path: "src/a.ts" }, true);
		expect(colours(collapsed.join("\n"))).toBeGreaterThanOrEqual(3);
		expect(collapsed.join("\n").match(FG)!.length).toBeLessThan(expanded.join("\n").match(FG)!.length / 10);
	});

	it("colours a unified diff result by its added and removed lines", () => {
		const rows = mcpRows("@@ -1,2 +1,2 @@\n ctx\n-old\n+new", {}, true).join("\n");
		expect(rows).toContain(theme.fg("toolDiffRemoved", "-"));
		expect(rows).toContain(theme.fg("toolDiffAdded", "+"));
	});
});

describe("unified diffs", () => {
	const DIFF = [
		"diff --git a/x.ts b/x.ts",
		"index 1..2 100644",
		"--- a/x.ts",
		"+++ b/x.ts",
		"@@ -1,3 +1,3 @@",
		" const keep = 1;",
		"-const a = 1;",
		"+const a = 2;",
	].join("\n");

	it("colours added and removed lines and the hunk head, and keeps every character", () => {
		const out = renderDiff(DIFF);
		expect(plain(out)).toBe(DIFF);
		const row = (text: string) => out.split("\n").find((line) => plain(line) === text)!;
		expect(row("-const a = 1;")).toContain(theme.fg("toolDiffRemoved", "-"));
		expect(row("+const a = 2;")).toContain(theme.fg("toolDiffAdded", "+"));
		expect(colours(row("@@ -1,3 +1,3 @@"))).toBe(1);
		expect(row("@@ -1,3 +1,3 @@")).not.toBe(theme.fg("toolDiffContext", "@@ -1,3 +1,3 @@"));
	});

	it("syntax-colours the code by the file named in the head", () => {
		const out = renderDiff(DIFF);
		const added = out.split("\n").find((line) => plain(line) === "+const a = 2;")!;
		expect(colours(added)).toBeGreaterThanOrEqual(2);
	});

	it("keeps the numbered form", () => {
		const out = renderDiff("-1 const a = 1;\n+1 const a = 2;");
		expect(out).toContain(theme.fg("toolDiffRemoved", "-1 "));
	});

	it("does not take a list or prose for a diff", () => {
		const text = "- one\n- two\n+ three";
		expect(plain(renderDiff(text))).toBe(text);
		expect(renderDiff(text)).not.toContain(theme.fg("toolDiffRemoved", "-"));
	});
});

describe("markdown display blocks", () => {
	it("render through the markdown theme", () => {
		const display: ToolDisplay = {
			title: "skill",
			blocks: [{ type: "markdown", text: "# Heading\n\nSome **bold** and `code`.\n\n```ts\nconst a = 1;\n```" }],
		};
		const renderers = displayRenderers({ display: () => display } as never, () => display)!;
		const rows = renderers.renderResult!(
			{ content: [{ type: "text", text: "x" }], details: undefined },
			{ expanded: true, isPartial: false },
			theme,
			{ isPartial: false, isError: false, expanded: true, args: {}, state: {} } as never,
		).render(80);
		const text = rows.join("\n");
		const md = getMarkdownTheme();
		expect(text).toContain(theme.getFgAnsi("mdHeading"));
		expect(plain(text)).toContain("Heading");
		expect(text).toContain(md.code("code"));
		expect(text).not.toContain("# Heading");
		expect(text).not.toContain("```");
		expect(colours(rows.find((row) => plain(row).includes("const a"))!)).toBeGreaterThanOrEqual(2);
	});
});

describe("fences", () => {
	it("knows jsonl, vue, hcl and tf", () => {
		for (const name of ["jsonl", "ndjson", "vue", "hcl", "tf", "terraform"])
			expect(resolveLanguage(name)).toBeDefined();
	});

	it("colours a fence with no language when it is JSON or a unified diff", () => {
		expect(colours(highlightCode('{"a": [1, true, "x"]}').join("\n"))).toBeGreaterThanOrEqual(3);
		const diff = highlightCode("@@ -1 +1 @@\n-a\n+b").join("\n");
		expect(diff).toContain(theme.fg("toolDiffRemoved", "-a"));
		expect(diff).toContain(theme.fg("toolDiffAdded", "+b"));
	});

	it("keeps other no-language blocks, and named but unknown languages, in the code-block colour", () => {
		const prose = "just some words\nand more words";
		expect(highlightCode(prose)).toEqual(prose.split("\n").map((line) => theme.fg("mdCodeBlock", line)));
		expect(highlightCode("{not json}")).toEqual([theme.fg("mdCodeBlock", "{not json}")]);
		expect(highlightCode('{"a":1}', "mermaid")).toEqual([theme.fg("mdCodeBlock", '{"a":1}')]);
	});
});

describe("shell output", () => {
	const OUTPUT = [
		"ERROR: build broke",
		"warning: unused variable",
		"src/a.ts:12:3 - something",
		"all fine here",
		"the error was handled",
	].join("\n");

	function expectClassified(rendered: string) {
		expect(rendered).toContain(theme.fg("error", "ERROR: build broke"));
		expect(rendered).toContain(theme.fg("warning", "warning: unused variable"));
		expect(rendered).toContain(theme.fg("mdCode", "src/a.ts:12:3"));
		expect(plain(rendered)).toContain("src/a.ts:12:3 - something");
	}

	it("colours error and warning lines and path heads in the bash tool row", () => {
		const context = { isPartial: false, isError: false, showImages: false, durationMs: 5, state: {}, expanded: true };
		const row = withBuiltInRenderers("bash", undefined)!.renderResult!(
			{ content: [{ type: "text", text: OUTPUT }], details: {} },
			{ expanded: true, isPartial: false },
			theme,
			context as never,
		)
			.render(100)
			.join("\n");
		expectClassified(row);
		expect(row).toContain(theme.fg("toolOutput", "all fine here"));
		expect(row).toContain(theme.fg("toolOutput", "the error was handled"));
	});

	it("colours them in the native bash result", () => {
		const context = { isPartial: false, isError: false, showImages: false, expanded: true, state: {}, args: {} };
		const row = renderBashResult(
			{ content: [{ type: "text", text: OUTPUT }], details: {} },
			{ expanded: true, isPartial: false },
			theme,
			context,
		)
			.render(100)
			.join("\n");
		expectClassified(row);
		expect(row).toContain(theme.fg("toolOutput", "all fine here"));
	});

	it("colours them in a `!` row", () => {
		const row = new BashExecutionComponent("make", { requestRender: () => {} } as unknown as TUI);
		row.appendOutput(`${OUTPUT}\n`);
		row.setComplete(0, false, undefined, undefined, undefined);
		row.setExpanded(true);
		const rendered = row.render(100).join("\n");
		expectClassified(rendered);
		expect(rendered).toContain(theme.fg("muted", "all fine here"));
	});
});

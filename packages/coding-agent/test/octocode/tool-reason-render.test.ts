import { Text, type TUI, visibleWidth } from "@octocodeai/octocode-tui";
import { Type } from "typebox";
import { beforeAll, describe, expect, it } from "vitest";
import { createToolHtmlRenderer } from "../../src/core/export-html/tool-renderer.ts";
import type { ToolDefinition } from "../../src/core/extensions/types.ts";
import { ToolExecutionComponent } from "../../src/modes/interactive/components/tool-execution.ts";
import { initTheme, theme } from "../../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../src/utils/ansi.ts";

const ui = { requestRender: () => {} } as unknown as TUI;
const definition = (name: string): ToolDefinition => ({
	name,
	label: name,
	description: "test",
	parameters: Type.Any(),
	execute: async () => ({ content: [], details: {} }),
	renderCall: (args) => new Text(`${name} ${String((args as { command?: string }).command)}`, 0, 0),
});
const row = (name: string, args: unknown, withRenderer = true) =>
	new ToolExecutionComponent(name, "call-1", args, {}, withRenderer ? definition(name) : undefined, ui, process.cwd());
const lines = (component: ToolExecutionComponent, width = 80) => component.render(width).map(stripAnsi);

describe("the reason line of a native tool row", () => {
	beforeAll(() => initTheme("dark"));

	it("sits right under the call header, collapsed or expanded", () => {
		const component = row("bash", { command: "ls", reason: "list the folder" });
		const text = lines(component).filter((line) => line.trim());
		expect(text.map((line) => line.trim())).toEqual(["bash ls", "↳ list the folder"]);
		component.setExpanded(true);
		expect(
			lines(component)
				.filter((line) => line.trim())
				.map((line) => line.trim()),
		).toEqual(["bash ls", "↳ list the folder"]);
	});

	it("is hidden without a reason, and for a tool that is not native", () => {
		expect(lines(row("bash", { command: "ls" })).join("\n")).not.toContain("↳");
		expect(lines(row("bash", { command: "ls", reason: "  " })).join("\n")).not.toContain("↳");
		expect(lines(row("custom_tool", { command: "ls", reason: "mine" })).join("\n")).not.toContain("mine");
	});

	it("is also shown for a native tool that has no call renderer of its own", () => {
		const text = lines(row("debug", { action: "launch", reason: "inspect the crash" }, false)).join("\n");
		expect(text).toContain("↳ inspect the crash");
	});

	it("is one line cut to the row's width, with terminal escapes and line breaks removed", () => {
		const long = "find out why the build is slow ".repeat(10);
		const reasonLines = (width: number) =>
			row("bash", { command: "ls", reason: long })
				.render(width)
				.filter((line) => stripAnsi(line).includes("↳"));
		for (const width of [20, 40, 80]) {
			const found = reasonLines(width);
			expect(found).toHaveLength(1);
			expect(visibleWidth(found[0])).toBeLessThanOrEqual(width);
		}
		const hostile = lines(row("bash", { command: "ls", reason: "one\n\u001b]0;title\u0007two" })).join("\n");
		expect(hostile).toContain("↳ one two");
		expect(hostile).not.toContain("title");
	});

	it("is the theme's muted, italic style, so each bundled theme colors it itself", () => {
		const reasonOf = (name: string) => {
			initTheme(name);
			const found = row("bash", { command: "ls", reason: "list the folder" })
				.render(80)
				.find((line) => stripAnsi(line).includes("↳"))!;
			return { found, expected: theme.italic(theme.fg("muted", "↳ list the folder")) };
		};
		const seen = new Set<string>();
		for (const name of ["dark", "light", "octocode-dark", "octocode-light"]) {
			const { found, expected } = reasonOf(name);
			expect(found, name).toContain(expected);
			seen.add(expected);
		}
		expect(seen.size).toBeGreaterThan(1);
		initTheme("dark");
	});
});

describe("the reason in an exported call", () => {
	it("follows the call's own rendering for a native tool and not for others", () => {
		initTheme("dark");
		const render = createToolHtmlRenderer({
			getToolRenderers: (name) => definition(name),
			theme,
			cwd: process.cwd(),
		}).renderCall;
		expect(render("c1", "bash", { command: "ls", reason: "list the folder" })).toContain("↳ list the folder");
		expect(render("c2", "bash", { command: "ls" })).not.toContain("↳");
		expect(render("c3", "custom_tool", { command: "ls", reason: "mine" })).not.toContain("mine");
	});
});

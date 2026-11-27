import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setCapabilityOverrides, Text, type TUI, visibleWidth } from "@octocodeai/octocode-tui";
import { Type } from "typebox";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { purposeRows, reasonRow } from "../../src/octocode/ui/reason-row.ts";
import { createToolHtmlRenderer } from "../../src/core/export-html/tool-renderer.ts";
import type { ToolDefinition } from "../../src/core/features/types.ts";
import { ToolExecutionComponent } from "../../src/modes/interactive/components/tool-execution.ts";
import { initTheme, loadThemeFromPath, setThemeInstance, theme } from "../../src/theme/theme.ts";
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

	it("hangs under the call's title, where the result gutter's `⎿` sits", () => {
		const text = lines(row("bash", { command: "ls", reason: "list the folder" })).filter((line) => line.trim());
		const gutter = "  ⎿  ";
		expect(text[1].indexOf("↳")).toBe(gutter.indexOf("⎿") + 1);
	});

	it("retains even a short supplied reason, while informative reasons keep the compact arrow row", () => {
		expect(lines(row("bash", { command: "ls", reason: "Edit" })).join("\n")).toContain("↳ Edit");
		expect(lines(row("bash", { command: "ls", reason: "Run tests" })).join("\n")).toContain("↳ Run tests");
		expect(lines(row("bash", { command: "ls", reason: "Edit hello to hi." })).join("\n")).toContain(
			"↳ Edit hello to hi.",
		);
	});

	it("is hidden without a reason, and for an extension tool whose own `reason` may mean something else", () => {
		expect(lines(row("bash", { command: "ls" })).join("\n")).not.toContain("↳");
		expect(lines(row("bash", { command: "ls", reason: "  " })).join("\n")).not.toContain("↳");
		expect(lines(row("bash", { command: "ls", reason: "" })).join("\n")).not.toContain("↳");
		expect(lines(row("custom_tool", { command: "ls", reason: "reject this pull request" })).join("\n")).not.toContain(
			"reject",
		);
	});

	it("shows supplied and returned MCP purpose with or without a renderer", () => {
		const args = { queries: [{ path: ".", mainGoal: "from the input" }], reason: "copied from a native tool" };
		const structuredContent = {
			content: [],
			structuredContent: { results: [{ data: { mainGoal: "find who calls the loader" } }] },
		};
		for (const withRenderer of [true, false]) {
			const component = row("mcp__octocode__localSearch", args, withRenderer);
			expect(lines(component).join("\n"), String(withRenderer)).toContain("from the input");
			component.updateResult({ content: [], structuredContent, isError: false });
			expect(lines(component).join("\n"), String(withRenderer)).toContain("find who calls the loader");
		}
		const silent = row("mcp__octocode__localSearch", args, false);
		silent.updateResult({ content: [], structuredContent: { results: [{ data: {} }] }, isError: false });
		// An empty result adds no purpose of its own: only the call's two supplied lines show.
		expect(lines(silent).filter((line) => line.includes("↳")).length).toBe(2);
	});

	it("appears as soon as the streamed arguments hold it, before the result", () => {
		const component = row("bash", { command: "ls" });
		expect(lines(component).join("\n")).not.toContain("↳");
		component.updateArgs({ command: "ls", reason: "list the folder" });
		expect(lines(component).join("\n")).toContain("↳ list the folder");
	});

	it("is also shown for a native tool that has no call renderer of its own", () => {
		const text = lines(row("compact", { reason: "inspect the crash" }, false)).join("\n");
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
		const hostile = lines(row("bash", { command: "ls", reason: "one\n\u001b]0;title\u0007two three" })).join("\n");
		expect(hostile).toContain("↳ one two three");
		expect(hostile).not.toContain("title");
	});

	it("is the theme's `toolReason` color in italics, a color of its own in every bundled theme", () => {
		vi.stubEnv("NO_COLOR", "");
		vi.stubEnv("TERM", "xterm-256color");
		const seen = new Set<string>();
		// The themes define truecolor values; a terminal without truecolor hints gets 256 colours, which may round two of
		// them to one palette entry, so the comparison pins truecolor.
		setCapabilityOverrides({ trueColor: true });
		for (const name of ["dark", "light", "octocode-dark", "octocode-light"]) {
			initTheme(name);
			const found = row("bash", { command: "ls", reason: "list the folder" })
				.render(80)
				.find((line) => stripAnsi(line).includes("↳"))!;
			const expected = theme.italic(theme.fg("toolReason", "↳ list the folder"));
			expect(found, name).toContain(expected);
			expect(theme.getFgAnsi("toolReason"), name).not.toBe(theme.getFgAnsi("muted"));
			expect(theme.getFgAnsi("toolReason"), name).not.toBe(theme.getFgAnsi("toolOutput"));
			seen.add(expected);
		}
		expect(seen.size).toBe(4);
		setCapabilityOverrides({});
		vi.unstubAllEnvs();
		initTheme("dark");
	});

	it("takes the muted color in a theme that does not define `toolReason`", () => {
		const dir = mkdtempSync(join(tmpdir(), "octocode-reason-theme-"));
		try {
			const json = JSON.parse(readFileSync(new URL("../../src/theme/dark.json", import.meta.url), "utf8"));
			json.name = "no-reason-color";
			delete json.colors.toolReason;
			const path = join(dir, "no-reason-color.json");
			writeFileSync(path, JSON.stringify(json));
			const custom = loadThemeFromPath(path, "truecolor");
			expect(custom.getFgAnsi("toolReason")).toBe(custom.getFgAnsi("muted"));
			setThemeInstance(custom);
			const found = row("bash", { command: "ls", reason: "list the folder" })
				.render(80)
				.find((line) => stripAnsi(line).includes("↳"))!;
			expect(found).toContain(theme.italic(theme.fg("muted", "↳ list the folder")));
		} finally {
			rmSync(dir, { recursive: true, force: true });
			initTheme("dark");
		}
	});
});

describe("the reason in an exported call", () => {
	it("follows the call's own rendering for a native tool and not for others", () => {
		initTheme("dark");
		const render = createToolHtmlRenderer({
			getToolRenderers: (name) => definition(name),
			theme,
			cwd: process.cwd(),
			reasonRow,
			purposeRows,
		}).renderCall;
		expect(render("c1", "bash", { command: "ls", reason: "list the folder" })).toContain("↳ list the folder");
		expect(render("c2", "bash", { command: "ls" })).not.toContain("↳");
		expect(render("c3", "custom_tool", { command: "ls", reason: "mine" })).not.toContain("mine");
	});
});

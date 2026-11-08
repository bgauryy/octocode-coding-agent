import type { JsonValue } from "@octocodeai/octocode-ai";
import { describe, expect, it } from "vitest";
import { toolDisplayText, type ToolDisplay } from "@octocodeai/octocode-contracts";
import { buildToolDisplay } from "../../src/core/application/transcript-display.ts";
import { displayCallHtml, displayResultHtml } from "../../src/core/export-html/display-html.ts";
import { createToolDisplayAttacher } from "../../src/modes/rpc/tool-display.ts";
import { bashDisplay, fileDisplay } from "../../src/octocode/files/display.ts";
import { octocodeToolDisplay } from "../../src/octocode/ui/tool-display.ts";

const text = (value: string) => ({ content: [{ type: "text" as const, text: value }] });

describe("tool displays", () => {
	it("draws a tool without its own display from its name, argument label and result text", () => {
		const display = buildToolDisplay(undefined, {
			toolName: "read",
			args: { path: "src/a.ts" },
			result: { ...text("one\ntwo"), details: undefined },
			text: "one\ntwo",
			status: "completed",
			hint: "src/a.ts",
		});
		expect(display).toEqual({
			title: "read",
			summary: "src/a.ts",
			outcome: { text: "one" },
			blocks: [{ type: "text", text: "one\ntwo" }],
		});
	});

	it("falls back to the generic display when a tool's display throws on an older result shape", () => {
		const display = buildToolDisplay(
			() => {
				throw new Error("old shape");
			},
			{ toolName: "web", args: {}, result: text("page"), text: "page", status: "completed" },
		);
		expect(display.title).toBe("web");
		expect(display.blocks).toEqual([{ type: "text", text: "page" }]);
	});

	it("states an MCP call's reason only from its returned data, and a native call's from its arguments", () => {
		const mcp = (structuredContent: JsonValue) =>
			octocodeToolDisplay("mcp__octocode__localFetch")({
				toolName: "mcp__octocode__localFetch",
				args: { reason: "Copied from a native tool" },
				result: { ...text("x"), details: undefined, structuredContent },
				status: "completed",
			}).reason;
		expect(mcp({ results: [{ data: {} }] })).toBeUndefined();
		expect(mcp({ results: [{ data: { mainGoal: "Trace the parser" } }] })).toBe("Trace the parser");
		const native = octocodeToolDisplay(
			"bash",
			bashDisplay,
		)({
			toolName: "bash",
			args: { command: "ls", reason: "List the\nfiles" },
			status: "running",
		});
		expect(native).toMatchObject({ title: "Bash", summary: "ls", reason: "List the files" });
	});

	it("shows a command's status, output, notices and saved output", () => {
		const display = bashDisplay({
			toolName: "bash",
			args: { command: "npm test", background: true, timeout: 60 },
			result: {
				...text("ok 1\nok 2"),
				details: { exitCode: 1, output: "ok 1\nok 2", fullOutputPath: "/tmp/out.log", notices: ["Slow"] },
			},
			status: "failed",
		});
		expect(display).toMatchObject({
			title: "Bash",
			summary: "npm test",
			meta: ["background", "timeout 1m"],
			kind: "execute",
			outcome: { text: "exit 1 · 2 lines", tone: "error" },
			blocks: [
				{ type: "output", text: "ok 1\nok 2", command: "npm test", exitCode: 1 },
				{ type: "text", text: "Slow", tone: "muted" },
				{ type: "path", label: "saved", path: "/tmp/out.log" },
			],
		});
	});

	it("shows file changes as per-file diffs and failed changes as a list", () => {
		const diff = "--- a.ts\n+++ a.ts\n@@ -1 +1 @@\n-old\n+new\n+more";
		const display = fileDisplay({
			toolName: "file",
			args: {
				queries: [
					{ type: "edit", path: "a.ts", edits: [{}] },
					{ type: "edit", path: "b.ts", edits: [{}] },
				],
			},
			result: {
				...text("done"),
				details: {
					outcomes: [
						{ type: "edit", path: "a.ts", reason: "r", ok: true, message: "", diff },
						{ type: "edit", path: "b.ts", reason: "r", ok: false, message: "no match" },
					],
				},
			},
			status: "completed",
		});
		expect(display).toMatchObject({
			title: "File",
			summary: "2 changes",
			subjects: ["edit a.ts · 1 edit", "edit b.ts · 1 edit"],
			kind: "edit",
			locations: [{ path: "a.ts" }, { path: "b.ts" }],
			outcome: { text: "Applied 1 of 2 changes", tone: "warning" },
			blocks: [
				{ type: "diff", files: [{ path: "a.ts", operation: "modify", additions: 2, removals: 1, patch: diff }] },
				{ type: "list", items: [{ text: "edit b.ts: no match", state: "failed" }] },
			],
		});
	});

	it("renders a display as escaped HTML for the export, collapsed and expanded", () => {
		const display: ToolDisplay = {
			title: "Bash",
			summary: "echo <b>",
			reason: "Show the tag",
			outcome: { text: "exit 0 · 1 line" },
			blocks: [{ type: "output", text: Array.from({ length: 12 }, (_, i) => `line ${i}`).join("\n") }],
		};
		expect(displayCallHtml(display)).toContain("echo &lt;b&gt;");
		expect(displayCallHtml(display)).toContain("↳ Show the tag");
		const { collapsed, expanded } = displayResultHtml(display);
		expect(collapsed).toContain("4 more lines");
		expect(collapsed).toContain("line 11");
		expect(collapsed).not.toContain("line 0\n");
		expect(expanded).toContain("line 0");
	});

	it("adds each tool event's display to the RPC stream, keeping the start's arguments for the end", () => {
		const attach = createToolDisplayAttacher(() => ({ display: bashDisplay }));
		attach({ type: "tool_execution_start", toolCallId: "c", toolName: "bash", args: { command: "ls" } } as never);
		const end = attach({
			type: "tool_execution_end",
			toolCallId: "c",
			toolName: "bash",
			result: { ...text("a"), details: { exitCode: 0, output: "a" } },
			isError: false,
		} as never) as { display?: ToolDisplay };
		expect(end.display?.summary).toBe("ls");
		expect(toolDisplayText(end.display!)).toContain("exit 0 · 1 line");
	});
});

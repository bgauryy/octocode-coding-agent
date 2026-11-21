import type { TUI } from "@octocodeai/octocode-tui";
import { beforeAll, describe, expect, it } from "vitest";
import type { ToolRenderers } from "../../src/core/features/types.ts";
import { createBashToolDefinition } from "../../src/core/tools/bash.ts";
import type { BashExecutionError } from "../../src/core/tools/bash/outcome.ts";
import { ToolExecutionComponent } from "../../src/modes/interactive/components/tool-execution.ts";
import { withBuiltInRenderers } from "../../src/octocode/files/built-in-renderers.ts";
import { renderBashResult, renderJobMessage } from "../../src/octocode/files/render.ts";
import { initTheme, theme } from "../../src/theme/theme.ts";
import { stripAnsi } from "../../src/utils/ansi.ts";
import { fakeCtx } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

const ui = { requestRender: () => {} } as unknown as TUI;
const text = (component: { render(width: number): string[] }, width = 100) =>
	component.render(width).map(stripAnsi).join("\n");
const HEADER = /\[exit 1 · [^\]]*3,000 lines[^\]]*trimmed: first 100 \+ last 398 lines \+ 1 matched[^\]]*\]/s;

/** What the bash tool returns for a command that prints `output` and exits with `code`. */
async function run(output: string, code: number | null, end?: "timeout" | "abort") {
	const tool = createBashToolDefinition(tmp(), {
		operations: {
			exec: async (_command, _cwd, options) => {
				options.onData(Buffer.from(output));
				if (end === "timeout") throw new Error("timeout:3");
				if (end === "abort") throw new Error("aborted");
				return { exitCode: code };
			},
		},
	});
	try {
		const result = await tool.execute(
			"t",
			{ command: "x" },
			undefined,
			undefined,
			fakeCtx({ cwd: process.cwd() }) as never,
		);
		return { ...result, isError: code !== 0 };
	} catch (error) {
		const failure = error as BashExecutionError;
		return { content: [{ type: "text" as const, text: failure.message }], details: failure.details, isError: true };
	}
}

const big =
	Array.from({ length: 3000 }, (_, i) =>
		i === 1500 ? "error: boom in the middle" : `line ${i} some padding text here`,
	).join("\n") + "\n";

function coreRow(result: Awaited<ReturnType<typeof run>>, expanded: boolean) {
	const row = new ToolExecutionComponent(
		"bash",
		"c1",
		{ command: "x" },
		{},
		// The interactive display fills in the built-in shell renderers; the core definition has none of its own.
		withBuiltInRenderers("bash", createBashToolDefinition(tmp()) as ToolRenderers),
		ui,
		process.cwd(),
	);
	row.updateResult(result, false);
	row.setExpanded(expanded);
	return row;
}

describe("bash result rows", () => {
	beforeAll(() => initTheme("dark"));

	it("draw the core row in the native shell grammar once above a trimmed result, collapsed and expanded, at any width", async () => {
		const result = await run(big, 1);
		for (const expanded of [false, true]) {
			for (const width of [40, 100]) {
				const rows = text(coreRow(result, expanded), width).split("\n");
				const at = `expanded=${expanded} width=${width}`;
				// A blank row above the block, then the marked header and the outcome under the gutter, each once.
				expect(rows[1]?.trimEnd(), at).toBe(" ⏺ Bash(x)");
				expect(rows[2]?.trimEnd(), at).toBe("   ⎿  Error: exit 1 · 3000 lines");
				const flat = rows.join(" ").replace(/\s+/g, " ");
				expect(flat.match(/exit 1/g), at).toHaveLength(1);
				expect(flat, at).not.toContain("[exit");
				expect(flat, at).toContain("line 2999 some padding text here");
			}
		}
		expect(text(coreRow(result, false))).toContain("… +495 earlier lines (ctrl+o to expand)");
		expect(text(coreRow(result, true))).toContain("1501: error: boom in the middle");
		expect(text(coreRow(result, true))).not.toContain("Full output:");
		expect(text(coreRow(result, true), 400)).toContain("saved: ");
	});

	it("show the deadline, abort and kill outcomes of a command that did not exit", async () => {
		const outcome = (row: string) => row.split("\n")[2]?.trimEnd();
		expect(outcome(text(coreRow(await run("partial\n", null, "timeout"), false)))).toBe(
			"   ⎿  Error: timed out after 3s · 1 line",
		);
		expect(outcome(text(coreRow(await run("partial\n", null, "abort"), true)))).toMatch(/^ {3}⎿ {2}.*aborted/);
		expect(outcome(text(coreRow(await run("p\n", null), false)))).toMatch(/^ {3}⎿ {2}.*terminated \(no exit code\)/);
	});

	it("draw a result recorded before the header existed from its own footer and truncation notice", () => {
		const old = {
			content: [
				{
					type: "text",
					text: "line 1\nline 2\n\n[Showing lines 1-2 of 900 (24KB limit). Full output: /tmp/octocode-bash-1.log]\n\nCommand exited with code 2",
				},
			],
			details: {
				truncation: { truncated: true, truncatedBy: "bytes", outputLines: 2, totalLines: 900, maxBytes: 24576 },
				fullOutputPath: "/tmp/octocode-bash-1.log",
			},
			isError: true,
		};
		// The core row draws the native result: same status, same notice, below its own header.
		const core = text(coreRow(old as never, true));
		expect(core).toContain("line 2");
		expect(core).toContain("⎿  Error: exit 2 · 900 lines");
		expect(core).toContain("saved: /tmp/octocode-bash-1.log");
		expect(core).not.toContain("Command exited with code");
		expect(core).not.toContain("Showing lines");
		expect(core).not.toContain("[exit");
		// The native row has no structured output to read: it takes the status and notice out of the text.
		const native = text(renderBashResult(old, { expanded: true, isPartial: false }, theme, { isError: true }));
		expect(native).toContain("exit 2 · 900 lines");
		expect(native).toContain("saved: /tmp/octocode-bash-1.log");
		expect(native).not.toContain("Command exited with code");
		expect(native).not.toContain("Showing lines");
	});

	it("keep the native summary free of the header's own fields, and name the spill file when expanded", async () => {
		const result = await run(big, 1);
		const collapsed = text(renderBashResult(result, { expanded: false, isPartial: false }, theme, { isError: true }));
		expect(collapsed).toContain("exit 1 · 3000 lines");
		expect(collapsed).not.toMatch(HEADER);
		expect(collapsed).not.toContain("[exit");
		// Wide enough that a long temporary directory does not wrap the path onto a row of its own.
		const expanded = text(
			renderBashResult(result, { expanded: true, isPartial: false }, theme, { isError: true }),
			400,
		);
		const spill = (result.details as { fullOutputPath?: string }).fullOutputPath!;
		expect(expanded).toContain("saved: ");
		expect(expanded).toContain(spill.slice(spill.lastIndexOf("octocode-bash-")));
		expect(expanded).toContain("1501: error: boom in the middle");
	});
});

describe("background job messages", () => {
	beforeAll(() => initTheme("dark"));
	const log = "~/.octocode/octocodecode/agent/sessions/abc/bash/bash-1-1792877887622.log";
	const fresh = `[exit 1 · 61s · 48,213 lines · 2.1 MB · log: ${log}]\nBackground bash bash-1 failed with exit code 1 after 1m01s: yarn build\n[+48173 earlier lines in the log]\nerror TS2322: nope`;

	const freshDetails = { id: "bash-1", command: "yarn build", how: "failed with exit code 1", ok: false, seconds: 61 };
	it("hide the status header and name the whole log path, wrapped, when expanded", () => {
		const collapsed = text(renderJobMessage(fresh, false, theme, 1, freshDetails));
		expect(collapsed).toContain("Bash(bash-1: yarn build) · background");
		expect(collapsed).toContain("failed with exit code 1 after 1m01s");
		expect(collapsed).not.toContain("[exit 1");
		for (const width of [40, 80]) {
			const expanded = text(renderJobMessage(fresh, true, theme, 1, freshDetails), width);
			expect(expanded.replace(/\s+/g, "")).toContain(`log:${log}`);
		}
	});

	it("draw a report without a log, with its output only when expanded", () => {
		const report = "Background bash bash-9 finished after 4m: sleep 240\ndone";
		const details = { id: "bash-9", command: "sleep 240", how: "finished", ok: true, seconds: 240 };
		const bare = text(renderJobMessage(report, false, theme, 1, details));
		expect(bare).toContain("finished after 4m");
		expect(bare).not.toContain("done");
		expect(text(renderJobMessage(report, true, theme, 1, details))).toContain("done");
	});

	it("draw a stopped job as interrupted and unparseable text as a failure without throwing", () => {
		const stopped = text(
			renderJobMessage(
				"[stopped (user) · 5s · 1 line · 3 B · log: ~/l.log]\nBackground bash bash-4 stopped (user) after 5s: sleep 100\nx",
				false,
				theme,
				1,
				{ id: "bash-4", command: "sleep 100", how: "stopped (user)", ok: false, interrupted: true, seconds: 5 },
			),
		);
		expect(stopped).toContain("⏺");
		expect(text(renderJobMessage("something else\nline two", false, theme))).toContain("something else");
	});
});

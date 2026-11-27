/**
 * `BashExecutionComponent` draws output from three sources: the executor's stream, an extension's `user_bash` result
 * and a stored session message (which may come from an imported file). None of them may reach the terminal with
 * controls: an OSC title or link, an escape split across chunks, a bell, an 8-bit CSI or a bidi override.
 */
import type { TUI } from "@octocodeai/octocode-tui";
import { beforeAll, describe, expect, test } from "vitest";
import { BashExecutionComponent } from "../src/modes/interactive/components/bash-execution.ts";
import { initTheme } from "../src/theme/theme.ts";

const ui = { requestRender: () => {} } as unknown as TUI;

function expectClean(rendered: string): void {
	expect(rendered).not.toContain("\u001b]");
	expect(rendered).not.toContain("\u0007");
	expect(rendered).not.toContain("\u009b");
	expect(rendered).not.toContain("\u202e");
}

describe("BashExecutionComponent strips terminal controls", () => {
	beforeAll(() => initTheme("dark"));

	for (const expanded of [false, true]) {
		test(`stored or extension output (${expanded ? "expanded" : "collapsed"})`, () => {
			const row = new BashExecutionComponent("cat \u001b]0;title\u0007notes", ui);
			row.appendOutput(
				"see \u001b]8;;https://evil.example\u0007here\u001b]8;;\u0007\nbell\u0007 x\u009b2Jy safe\u202etxt.exe\n",
			);
			row.setComplete(0, false, undefined, undefined, "[exit 0 \u001b]0;hdr\u0007]");
			row.setExpanded(expanded);
			const rendered = row.render(200).join("\n");
			expectClean(rendered);
			expect(rendered).toContain("here");
			expect(rendered).toContain("safetxt.exe");
		});
	}

	// Layout once per frame: a rebuild per chunk re-joins and re-truncates the whole output (quadratic in output size).
	test("streaming many chunks does not rebuild the whole output per chunk", () => {
		const row = new BashExecutionComponent("yes", ui);
		const line = `${"y".repeat(199)}\n`;
		const started = performance.now();
		for (let i = 0; i < 20000; i++) row.appendOutput(line);
		const lines = row.render(120);
		expect(performance.now() - started).toBeLessThan(1500);
		expect(lines.some((rendered) => rendered.includes("yyyy"))).toBe(true);
	});

	test("an escape split across streamed chunks never joins into a sequence", () => {
		const row = new BashExecutionComponent("make", ui);
		row.appendOutput("progress \u001b");
		row.appendOutput("]0;pwned\u0007 done\n");
		row.setComplete(0, false);
		expectClean(row.render(200).join("\n"));
	});
});

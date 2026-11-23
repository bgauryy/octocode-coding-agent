/**
 * A `!` command row uses the tool-row grammar: `<mark> ! cmd · you · time`, then the outcome in words under the `⎿`
 * gutter and the output hanging beneath it. A mark and words say how it ended; there is no frame to tint.
 */
import { GLYPH, setKeybindings, type TUI } from "@octocodeai/octocode-tui";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { BashExecutionComponent } from "../src/modes/interactive/components/bash-execution.ts";
import { STOPPED_COLOR } from "../src/octocode/render/types.ts";
import { initTheme, theme } from "../src/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const ui = { requestRender: () => {} } as unknown as TUI;
// Colours and links stripped: a terminal with hyperlinks draws the saved path as a link.
const plain = (rows: string[]): string => rows.map((row) => stripAnsi(row).trimEnd()).join("\n");

describe("BashExecutionComponent outcome", () => {
	beforeAll(() => initTheme("dark"));

	test("marks a command that succeeded with a check, its time in the title and its outcome under the gutter", () => {
		const row = new BashExecutionComponent("npm test", ui);
		row.setComplete(0, false, undefined, undefined, "[exit 0 · 1.2s · 4 lines · 40 B]");
		expect(plain(row.render(60))).toBe(
			`\n ${GLYPH.done} ! npm test · you · 1.2s\n   ${GLYPH.gutter}  exit 0 · 4 lines · 40 B`,
		);
	});

	test("shows a run time only from 1s on, and names the saved output", () => {
		const row = new BashExecutionComponent("seq 9", ui);
		row.setComplete(
			0,
			false,
			undefined,
			undefined,
			"[exit 0 · 0.3s · 9 lines · 18 B · trimmed: last 2 lines · full output: /tmp/o.log]",
		);
		expect(plain(row.render(120))).toBe(
			`\n ${GLYPH.done} ! seq 9 · you\n   ${GLYPH.gutter}  exit 0 · 9 lines · 18 B · trimmed: last 2 lines · full output: /tmp/o.log`,
		);
	});

	test("marks a failed command with a cross and its exit code, even without a result header", () => {
		const row = new BashExecutionComponent("npm test", ui);
		row.appendOutput("boom\n");
		row.setComplete(1, false);
		expect(plain(row.render(60))).toBe(`\n ${GLYPH.failed} ! npm test · you\n   ${GLYPH.gutter}  exit 1\n      boom`);
		expect(row.render(60).join("\n")).toContain(theme.fg("error", "exit 1"));
	});

	test("marks a cancelled command as stopped, not failed", () => {
		const row = new BashExecutionComponent("sleep 9", ui);
		row.setComplete(undefined, true);
		expect(plain(row.render(60))).toBe(`\n ${GLYPH.stopped} ! sleep 9 · you\n   ${GLYPH.gutter}  interrupted`);
		expect(row.render(60).join("\n")).toContain(theme.fg(STOPPED_COLOR, "interrupted"));
	});

	test("paints failure output in text colour, a failure line in error and a quiet success in muted", () => {
		const failed = new BashExecutionComponent("a", ui);
		failed.appendOutput("FAIL x\ndetail z\n");
		failed.setComplete(2, false);
		const failedText = failed.render(60).join("\n");
		expect(failedText).toContain(theme.fg("text", "detail z"));
		expect(failedText).toContain(theme.fg("error", "FAIL x"));

		const passed = new BashExecutionComponent("b", ui);
		passed.appendOutput("ok y\n");
		passed.setComplete(0, false);
		expect(passed.render(60).join("\n")).toContain(theme.fg("muted", "ok y"));
	});

	test("draws no frame: no mark while it runs, the command in its neutral colour before and after", () => {
		const row = new BashExecutionComponent("x", ui);
		const running = row.render(20);
		expect(running.some((line) => line.includes("─"))).toBe(false);
		expect(plain(running).split("\n")[1]).toBe(" ! x · you");
		expect(running.join("\n")).toContain(theme.fg("bashMode", theme.bold("! x")));
		row.setComplete(0, false);
		const done = row.render(20);
		expect(done.some((line) => line.includes("─"))).toBe(false);
		expect(done.join("\n")).toContain(theme.fg("bashMode", theme.bold("! x")));
		row.dispose();
	});

	test("names a `!!` command as such and keeps it dim whatever the outcome", () => {
		const row = new BashExecutionComponent("x", ui, true);
		row.setComplete(0, false);
		const rows = row.render(20);
		expect(plain(rows).split("\n")[1]).toBe(` ${GLYPH.done} !! x · you`);
		expect(rows.join("\n")).toContain(theme.fg("dim", theme.bold("!! x")));
	});
});

describe("BashExecutionComponent while it runs", () => {
	beforeAll(() => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
	});

	test("says how long the command has run, from 1s on, before the cancel key", () => {
		vi.useFakeTimers();
		try {
			const row = new BashExecutionComponent("sleep 30", ui);
			const running = () => plain(row.render(60)).split("\n").at(-1) ?? "";
			expect(running()).toMatch(/Running… · esc cancel$/);
			vi.advanceTimersByTime(12_000);
			expect(running()).toMatch(/Running… 12s · esc cancel$/);
			row.setComplete(0, false, undefined, undefined, "[exit 0 · 12s · 0 lines · 0 B]");
			// Finished, the time moves to the title and nothing ticks any more.
			expect(plain(row.render(60)).split("\n")[1]).toBe(` ${GLYPH.done} ! sleep 30 · you · 12s`);
			expect(vi.getTimerCount()).toBe(0);
			row.dispose();
		} finally {
			vi.useRealTimers();
		}
	});
});

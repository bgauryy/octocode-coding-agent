/**
 * A finished `!` command row says how it ended in words and a mark, not by band or frame tint alone (a 256-colour
 * terminal loses the tint), and the frame is neutral until the command has succeeded or failed.
 */
import { GLYPH, type TUI } from "@octocodeai/octocode-tui";
import { beforeAll, describe, expect, test } from "vitest";
import { BashExecutionComponent } from "../src/modes/interactive/components/bash-execution.ts";
import { STOPPED_COLOR } from "../src/octocode/render/types.ts";
import { STATE_COLOR } from "../src/theme/status.ts";
import { initTheme, theme } from "../src/theme/theme.ts";

const ui = { requestRender: () => {} } as unknown as TUI;
// biome-ignore lint/suspicious/noControlCharactersInRegex: strips SGR colours from rendered rows
const plain = (rows: string[]): string => rows.map((row) => row.replace(/\x1b\[[0-9;]*m/g, "")).join("\n");

describe("BashExecutionComponent outcome", () => {
	beforeAll(() => initTheme("dark"));

	test("marks a command that succeeded with a check", () => {
		const row = new BashExecutionComponent("npm test", ui);
		row.setComplete(0, false, undefined, undefined, "[exit 0 · 1.2s]");
		const text = plain(row.render(60));
		expect(text).toContain(`${GLYPH.done} $ npm test`);
		expect(text).toContain("[exit 0 · 1.2s]");
	});

	test("marks a failed command with a cross and its exit code, even without a result header", () => {
		const row = new BashExecutionComponent("npm test", ui);
		row.appendOutput("boom\n");
		row.setComplete(1, false);
		const text = plain(row.render(60));
		expect(text).toContain(`${GLYPH.failed} $ npm test · exit 1`);
		expect(text).toContain("boom");
	});

	test("marks a cancelled command as stopped, not failed", () => {
		const row = new BashExecutionComponent("sleep 9", ui);
		row.setComplete(undefined, true);
		const text = plain(row.render(60));
		expect(text).toContain(`${GLYPH.stopped} $ sleep 9 · interrupted`);
		expect(row.render(60).join("\n")).toContain(theme.fg(STOPPED_COLOR, " · interrupted"));
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

	test("frames the row neutral while it runs, then in its outcome colour", () => {
		const frame = (rows: string[]) => rows.find((row) => row.includes("─")) ?? "";
		const row = new BashExecutionComponent("x", ui);
		const running = frame(row.render(20));
		expect(running).toContain(theme.fg("bashMode", "─".repeat(20)));
		row.setComplete(0, false);
		expect(frame(row.render(20))).toContain(theme.fg(STATE_COLOR.done, "─".repeat(20)));
		const failed = new BashExecutionComponent("x", ui);
		failed.setComplete(1, false);
		expect(frame(failed.render(20))).toContain(theme.fg(STATE_COLOR.failed, "─".repeat(20)));
	});

	test("keeps a `!!` command's frame dim whatever the outcome", () => {
		const row = new BashExecutionComponent("x", ui, true);
		row.setComplete(0, false);
		const line = row.render(20).find((entry) => entry.includes("─")) ?? "";
		expect(line).toContain(theme.fg("dim", "─".repeat(20)));
	});
});

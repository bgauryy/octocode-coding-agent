/**
 * The live bash row keeps a bounded tail of the stream, folds carriage returns the way a terminal draws them and
 * takes the executor's final output when the command ends.
 */
import type { TUI } from "@octocodeai/octocode-tui";
import { beforeAll, describe, expect, test } from "vitest";
import { BashExecutionComponent } from "../src/modes/interactive/components/bash-execution.ts";
import { DEFAULT_MAX_BYTES } from "../src/core/tools/truncate.ts";
import { initTheme } from "../src/theme/theme.ts";

const ui = { requestRender: () => {} } as unknown as TUI;
// biome-ignore lint/suspicious/noControlCharactersInRegex: strips SGR colours from rendered rows
const plain = (rows: string[]): string => rows.map((row) => row.replace(/\x1b\[[0-9;]*m/g, "")).join("\n");

describe("BashExecutionComponent live stream", () => {
	beforeAll(() => initTheme("dark"));

	test("a carriage return redraws the current line instead of joining progress updates", () => {
		const row = new BashExecutionComponent("curl", ui);
		for (const percent of [10, 20, 30]) row.appendOutput(`${percent}%\r`);
		row.appendOutput("40%");
		const text = plain(row.render(60));
		expect(text).toContain("40%");
		expect(text).not.toMatch(/10%|20%|30%/);
	});

	test("text after the last carriage return of a line wins, and later lines stay", () => {
		const row = new BashExecutionComponent("npm", ui);
		row.appendOutput("start\nold\rmid\rfinal\nafter\n");
		const text = plain(row.render(60));
		expect(text).toContain("start");
		expect(text).toContain("final");
		expect(text).toContain("after");
		expect(text).not.toMatch(/old|mid/);
	});

	test("CR LF is one line break even when the chunk boundary splits it", () => {
		const row = new BashExecutionComponent("win", ui);
		row.appendOutput("first\r");
		row.appendOutput("\nsecond\r\nthird");
		const rows = plain(row.render(60))
			.split("\n")
			.map((line) => line.trim());
		const first = rows.indexOf("first");
		expect(first).toBeGreaterThan(-1);
		expect(rows.slice(first, first + 3)).toEqual(["first", "second", "third"]);
	});

	test("the final row of a redrawn line matches the executor's output at completion", () => {
		const row = new BashExecutionComponent("curl", ui);
		row.appendOutput("10%\r20%\r");
		row.setComplete(0, false);
		row.replaceOutput("100%\ndone");
		const text = plain(row.render(60));
		expect(text).toContain("100%");
		expect(text).toContain("done");
		expect(text).not.toContain("20%");
	});

	test("keeps a bounded tail of a huge stream and still shows the newest lines", () => {
		const row = new BashExecutionComponent("yes", ui);
		const chunk = `${Array.from({ length: 160 }, () => "x".repeat(99)).join("\n")}\n`;
		for (let i = 0; i < 1500; i++) row.appendOutput(chunk); // ~24 MB
		row.appendOutput("the last line\n");
		expect(row.getOutput().length).toBeLessThan(4 * DEFAULT_MAX_BYTES);
		expect(plain(row.render(120))).toContain("the last line");
	});

	test("a single endless line is bounded too", () => {
		const row = new BashExecutionComponent("cat", ui);
		for (let i = 0; i < 200; i++) row.appendOutput("z".repeat(100_000));
		expect(row.getOutput().length).toBeLessThan(4 * DEFAULT_MAX_BYTES);
	});

	test("a chunk with a very large number of lines is accepted", () => {
		const row = new BashExecutionComponent("seq", ui);
		expect(() => row.appendOutput("\n".repeat(300_000))).not.toThrow();
	});
});

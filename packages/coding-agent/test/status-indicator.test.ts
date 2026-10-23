import { getKeybindings, setKeybindings, type TUI, visibleWidth } from "@octocodeai/octocode-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { CustomEditor } from "../src/modes/interactive/components/custom-editor.ts";
import {
	BranchSummaryStatusIndicator,
	CompactionStatusIndicator,
	IdleStatus,
	RetryStatusIndicator,
	WorkingStatusIndicator,
} from "../src/modes/interactive/components/status-indicator.ts";
import { getEditorTheme, initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

describe("status indicators", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("keeps idle status at the same height as standalone status indicators", () => {
		const idleStatus = new IdleStatus();

		const lines = idleStatus.render(20);
		expect(lines).toHaveLength(2);
		expect(lines).toEqual([" ".repeat(20), " ".repeat(20)]);
	});

	it("shows the run summary with an esc hint and sweeps a light band across the detail", () => {
		initTheme("octocode-dark");
		const previousKeybindings = getKeybindings();
		setKeybindings(new KeybindingsManager());
		const tui = { requestRender: vi.fn(), terminal: { rows: 10 } } as unknown as TUI;
		const indicator = new WorkingStatusIndicator(tui, "Main · 3s · 1.2k tokens\nWriting the summary");
		const at = (now: number) => {
			vi.useFakeTimers({ now });
			const lines = indicator.render(80);
			vi.useRealTimers();
			return lines;
		};
		const [, heading, detail] = at(1000);
		expect(stripAnsi(heading)).toMatch(/Main · 3s · 1\.2k tokens +esc to interrupt$/);
		expect(stripAnsi(detail)).toBe("   └ Writing the summary");
		expect(at(1000)[2]).not.toBe(at(1600)[2]);
		indicator.dispose();
		setKeybindings(previousKeybindings);
	});

	it("draws the detail plain when the indicator does not animate", () => {
		initTheme("octocode-dark");
		const tui = { requestRender: vi.fn(), terminal: { rows: 10 } } as unknown as TUI;
		const indicator = new WorkingStatusIndicator(tui, "Main · 3s\nWriting", { frames: ["●"] });
		expect(indicator.render(80)[2]).toBe(`   ${theme.fg("dim", "└ ")}${theme.fg("text", "Writing")}`);
		indicator.dispose();
	});

	it("keeps the top border unchanged unless the editor opts in", () => {
		initTheme("dark");
		const tui = {
			requestRender: vi.fn(),
			terminal: { rows: 10 },
		} as unknown as TUI;
		const editor = new CustomEditor(tui, getEditorTheme(), KeybindingsManager.create());
		const indicator = new WorkingStatusIndicator(tui, "Working");
		editor.setWorkingStatusIndicator(indicator);

		expect(stripAnsi(editor.render(20)[0])).toBe("─".repeat(20));
		const standaloneLine = indicator.render(20)[1];
		expect(standaloneLine).toContain(theme.getFgAnsi("accent"));
		expect(standaloneLine).toContain(theme.getFgAnsi("muted"));
		indicator.dispose();
	});

	it.each(["dark", "light"])("embeds a readable working indicator in the %s theme", (name) => {
		initTheme(name);
		const tui = {
			requestRender: vi.fn(),
			terminal: { rows: 10 },
		} as unknown as TUI;
		const editor = new CustomEditor(tui, getEditorTheme(), KeybindingsManager.create(), {
			embedWorkingStatus: true,
		});
		expect(editor.embedWorkingStatus).toBe(true);
		editor.borderColor = theme.getThinkingBorderColor("high");
		const indicator = new WorkingStatusIndicator(tui, "Working", undefined, (text) => editor.borderColor(text));
		editor.setWorkingStatusIndicator(indicator);

		const topBorder = editor.render(20)[0];
		expect(stripAnsi(topBorder)).toBe("── ⠋ Working ───────");
		expect(visibleWidth(topBorder)).toBe(20);
		expect(topBorder).toContain(theme.fg("muted", "Working"));
		expect(topBorder).toContain(theme.fg("thinkingHigh", "⠋"));
		indicator.dispose();
	});

	it("embeds compaction, summary, and retry labels within the border width", () => {
		initTheme("dark");
		vi.useFakeTimers();
		const tui = { requestRender: vi.fn(), terminal: { rows: 10 } } as unknown as TUI;
		const editor = new CustomEditor(tui, getEditorTheme(), KeybindingsManager.create(), {
			embedWorkingStatus: true,
		});
		const indicators = [
			new CompactionStatusIndicator(tui, "manual"),
			new CompactionStatusIndicator(tui, "threshold"),
			new CompactionStatusIndicator(tui, "overflow"),
			new BranchSummaryStatusIndicator(tui),
			new RetryStatusIndicator(tui, 1, 3, 3000),
		];
		try {
			for (const indicator of indicators) {
				editor.setWorkingStatusIndicator(indicator);
				const label = stripAnsi(indicator.render(120)[1]).trim();
				expect(stripAnsi(editor.render(120)[0])).toContain(`── ${label} `);
				for (const width of [1, 4, 10, 20, 80, 120]) {
					expect(visibleWidth(editor.render(width)[0])).toBe(width);
				}
			}
			vi.advanceTimersByTime(1000);
			expect(stripAnsi(editor.render(120)[0])).toContain("Retrying (1/3) in 2s");
			editor.setWorkingStatusIndicator(undefined);
			expect(stripAnsi(editor.render(120)[0])).toBe("─".repeat(120));
		} finally {
			for (const indicator of indicators) indicator.dispose();
		}
	});

	it.each(["dark", "light"])("keeps the %s main activity at two rows without wrapping commands", (name) => {
		initTheme(name);
		vi.useFakeTimers();
		const tui = { requestRender: vi.fn() } as unknown as TUI;
		const indicator = new WorkingStatusIndicator(
			tui,
			`Main · 5m24s · 28.8k tokens · 2 compactions\nRunning bash ${"long command ".repeat(20)}`,
		);
		try {
			for (const width of [1, 20, 40, 80, 120, 200]) {
				const rows = indicator.render(width);
				expect(rows).toHaveLength(3);
				expect(rows.every((row) => visibleWidth(row) <= width)).toBe(true);
			}
			const rows = indicator.render(100);
			expect(stripAnsi(rows[1])).toContain("Main · 5m24s · 28.8k tokens · 2 compactions");
			expect(rows[1]).toContain(theme.fg("accent", theme.bold("Main")));
			expect(stripAnsi(rows[2])).toContain("└ Running bash");
			indicator.setMessage("Main · 5m25s · 29k tokens · 2 compactions\nWriting");
			expect(stripAnsi(indicator.render(100)[2])).toContain("Writing");
		} finally {
			indicator.dispose();
		}
	});

	it("disposes retry countdown updates", () => {
		initTheme("dark");
		vi.useFakeTimers();
		const requestRender = vi.fn();
		const tui = { requestRender } as unknown as TUI;
		const indicator = new RetryStatusIndicator(tui, 1, 3, 1000);
		const callsBeforeDispose = requestRender.mock.calls.length;

		indicator.dispose();
		vi.advanceTimersByTime(2000);

		expect(requestRender).toHaveBeenCalledTimes(callsBeforeDispose);
	});
});

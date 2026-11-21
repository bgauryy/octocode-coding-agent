import {
	animationClock,
	getKeybindings,
	MOTION,
	setScreenReaderMode,
	setKeybindings,
	type TUI,
	visibleWidth,
} from "@octocodeai/octocode-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { CustomEditor } from "../src/theme/custom-editor.ts";
import {
	BranchSummaryStatusIndicator,
	CompactionStatusIndicator,
	IdleStatus,
	RetryStatusIndicator,
	WorkingStatusIndicator,
} from "../src/modes/interactive/components/status-indicator.ts";
import { beginRun, resetRun } from "../src/utils/run-clock.ts";
import { getEditorTheme, initTheme, theme } from "../src/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

describe("status indicators", () => {
	beforeEach(() => {
		vi.stubEnv("NO_COLOR", "");
		vi.stubEnv("TERM", "xterm-256color");
		vi.stubEnv("COLORTERM", "truecolor");
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllEnvs();
	});

	it("keeps idle status at the same height as standalone status indicators", () => {
		const idleStatus = new IdleStatus();

		const lines = idleStatus.render(20);
		expect(lines).toHaveLength(2);
		expect(lines).toEqual([" ".repeat(20), " ".repeat(20)]);
	});

	it("shows activity with an esc hint and sweeps a light band across the detail", () => {
		initTheme("octocode-dark");
		const previousKeybindings = getKeybindings();
		setKeybindings(new KeybindingsManager());
		const tui = { requestRender: vi.fn(), terminal: { rows: 10 } } as unknown as TUI;
		const indicator = new WorkingStatusIndicator(tui, "Writing the summary");
		const at = (now: number) => {
			vi.useFakeTimers({ now });
			const lines = indicator.render(80);
			vi.useRealTimers();
			return lines;
		};
		try {
			const [, detail] = at(1000);
			expect(stripAnsi(detail)).toMatch(/^ \S Writing the summary \(\d+s · esc interrupt\)$/);
			expect(stripAnsi(detail)).not.toContain("Main");
			expect(at(1000)[1]).not.toBe(at(1600)[1]);
		} finally {
			indicator.dispose();
			setKeybindings(previousKeybindings);
		}
	});

	it("counts the whole run from the run clock and clips the detail, never the time", () => {
		initTheme("octocode-dark");
		const previousKeybindings = getKeybindings();
		setKeybindings(new KeybindingsManager());
		vi.useFakeTimers({ now: 1_000_000 });
		const tui = { requestRender: vi.fn(), terminal: { rows: 10 } } as unknown as TUI;
		beginRun(1_000_000 - 62_000);
		const indicator = new WorkingStatusIndicator(tui, `Running subagent ${"goal ".repeat(40)}`);
		try {
			vi.setSystemTime(1_000_000 + MOTION.spinnerDelayMs);
			expect(stripAnsi(indicator.render(120)[1])).toMatch(/^ \S Running subagent goal .*… \(1m02s · esc interrupt\)$/);
			// Narrow: the interrupt hint goes first, then the detail shrinks; the time stays last.
			expect(stripAnsi(indicator.render(32)[1])).toMatch(/\(1m02s\)$/);
			expect(stripAnsi(indicator.render(60)[1])).toMatch(/\(1m02s · esc interrupt\)$/);
			for (const width of [10, 20, 32, 60, 120])
				expect(visibleWidth(indicator.render(width)[1])).toBeLessThanOrEqual(width);
			vi.advanceTimersByTime(3_000);
			expect(stripAnsi(indicator.render(120)[1])).toContain("(1m05s");
			// The clock repaints once a second even when nothing else does.
			expect(tui.requestRender).toHaveBeenCalled();
		} finally {
			indicator.dispose();
			resetRun();
			setKeybindings(previousKeybindings);
		}
		expect(vi.getTimerCount()).toBe(0);
	});

	it("repaints each second for the run clock while the decoration is held", () => {
		vi.useFakeTimers({ now: 5_000_000 });
		const tui = { requestRender: vi.fn(), terminal: { rows: 10 } } as unknown as TUI;
		const indicator = new WorkingStatusIndicator(tui, "Working");
		try {
			animationClock.holdDecoration(10_000);
			vi.advanceTimersByTime(3_100);
			expect(vi.mocked(tui.requestRender).mock.calls.length).toBeGreaterThanOrEqual(3);
		} finally {
			indicator.dispose();
		}
	});

	it("draws the detail plain when the indicator does not animate", () => {
		initTheme("octocode-dark");
		const tui = { requestRender: vi.fn(), terminal: { rows: 10 } } as unknown as TUI;
		const indicator = new WorkingStatusIndicator(tui, "Writing", { frames: ["●"] });
		expect(indicator.render(80)[1]).toContain(theme.fg("text", "Writing"));
		indicator.dispose();
	});

	it("says working in words, with no spinner glyph and no animation, in screen-reader mode", () => {
		initTheme("octocode-dark");
		vi.useFakeTimers({ now: 1_000_000 + MOTION.spinnerDelayMs });
		const tui = { requestRender: vi.fn(), terminal: { rows: 10 } } as unknown as TUI;
		setScreenReaderMode(true);
		const indicator = new WorkingStatusIndicator(tui, "Writing");
		try {
			expect(stripAnsi(indicator.render(80)[1])).toMatch(/^ working: Writing /);
		} finally {
			setScreenReaderMode(false);
			indicator.dispose();
		}
	});

	it("hides the spinner for its first moments, then shows it in the same cell", () => {
		initTheme("octocode-dark");
		vi.useFakeTimers({ now: 1_000_000 });
		const tui = { requestRender: vi.fn(), terminal: { rows: 10 } } as unknown as TUI;
		const indicator = new WorkingStatusIndicator(tui, "Writing");
		try {
			const early = stripAnsi(indicator.render(80)[1]);
			expect(early).toMatch(/^ {3}Writing /);
			vi.setSystemTime(1_000_000 + MOTION.spinnerDelayMs);
			expect(stripAnsi(indicator.render(80)[1])).toMatch(/^ \S Writing /);
		} finally {
			indicator.dispose();
		}
	});

	it("keeps the top border unchanged unless the editor opts in", () => {
		// The base-color assertion needs a fixed shimmer phase, independent of wall-clock time.
		vi.useFakeTimers({ now: 0 });
		initTheme("dark");
		const tui = {
			requestRender: vi.fn(),
			terminal: { rows: 10 },
		} as unknown as TUI;
		const editor = new CustomEditor(tui, getEditorTheme(), KeybindingsManager.create());
		const indicator = new WorkingStatusIndicator(tui, "Working");
		editor.setWorkingStatusIndicator(indicator);
		// The spinner stays hidden for its first MOTION.spinnerDelayMs.
		vi.setSystemTime(MOTION.spinnerDelayMs);

		expect(stripAnsi(editor.render(20)[0])).toBe("─".repeat(20));
		const standaloneLine = indicator.render(20)[1];
		expect(standaloneLine).toContain(theme.getFgAnsi("accent"));
		// The label shimmers between the terminal's default colors, at rest dimmed toward its background.
		expect(standaloneLine).toMatch(/\x1b\[38;2;\d+;\d+;\d+mW/);
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
		// The spinner stays hidden for its first MOTION.spinnerDelayMs: render once the delay has passed.
		vi.useFakeTimers({ now: Date.now() + MOTION.spinnerDelayMs + 50 });

		const topBorder = editor.render(20)[0];
		expect(stripAnsi(topBorder)).toBe("── ⠋ Working (0s) ──");
		expect(visibleWidth(topBorder)).toBe(20);
		expect(topBorder).toContain(theme.fg("muted", "Working"));
		expect(topBorder).toContain(theme.fg("dim", " (0s"));
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
			// The shared clock ticks on its own cadence: allow a frame past the second.
			vi.advanceTimersByTime(1300);
			expect(stripAnsi(editor.render(120)[0])).toContain("Retrying (1/3) in 2s");
			editor.setWorkingStatusIndicator(undefined);
			expect(stripAnsi(editor.render(120)[0])).toBe("─".repeat(120));
		} finally {
			for (const indicator of indicators) indicator.dispose();
		}
	});

	it.each(["dark", "light"])("keeps the %s activity at one row without wrapping commands", (name) => {
		initTheme(name);
		vi.useFakeTimers();
		const tui = { requestRender: vi.fn() } as unknown as TUI;
		const indicator = new WorkingStatusIndicator(tui, `Running bash ${"long command ".repeat(20)}`);
		try {
			for (const width of [1, 20, 40, 80, 120, 200]) {
				const rows = indicator.render(width);
				expect(rows).toHaveLength(2);
				expect(rows.every((row) => visibleWidth(row) <= width)).toBe(true);
			}
			const rows = indicator.render(100);
			expect(stripAnsi(rows[1])).not.toContain("Main");
			expect(stripAnsi(rows[1])).toContain("Running bash");

			indicator.setMessage("Writing");
			expect(stripAnsi(indicator.render(100)[1])).toContain("Writing");
		} finally {
			indicator.dispose();
		}
	});

	it("paints an automatic retry neutral: warning is reserved for what needs the user", () => {
		initTheme("dark");
		vi.useFakeTimers();
		const indicator = new RetryStatusIndicator({ requestRender: vi.fn() } as unknown as TUI, 1, 3, 3000);
		try {
			const row = indicator.render(80).join("\n");
			const tone = (token: "warning" | "muted") => theme.fg(token, "x").split("x")[0];
			expect(row).toContain(tone("muted"));
			expect(row).not.toContain(tone("warning"));
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

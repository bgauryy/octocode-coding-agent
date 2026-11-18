import { setKeybindings, type TUI, visibleWidth } from "@octocodeai/octocode-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { RetryStatusIndicator } from "../src/modes/interactive/components/status-indicator.ts";
import { detailHints, errorHints } from "../src/octocode/harness/picker-hints.ts";
import { ruleLine } from "../src/theme/dynamic-border.ts";
import { ManagePageComponent } from "../src/theme/manage-page.ts";
import { initTheme } from "../src/theme/theme.ts";
import { positionLabel } from "../src/theme/page-kit.ts";
import { emptyState, noMatchMessage, renderHintLine } from "../src/theme/theme-tui-helpers.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

beforeEach(() => {
	initTheme("octocode-dark");
	setKeybindings(new KeybindingsManager());
});
afterEach(() => vi.useRealTimers());

describe("one chrome vocabulary", () => {
	it("draws rules at exactly the width and nothing at zero", () => {
		expect(visibleWidth(ruleLine(37))).toBe(37);
		expect(ruleLine(0)).toBe("");
	});

	it("shows esc, never escape, in every hint line", () => {
		const manage = new ManagePageComponent({
			title: "Page",
			sections: [{ heading: "A", rows: [{ id: "a", name: "alpha" }] }],
			hints: [["escape", "close"]],
			onSelect() {},
			onCancel() {},
		});
		const lines = [...manage.render(60), renderHintLine(errorHints(new KeybindingsManager(), false), 60)].map(
			stripAnsi,
		);
		expect(lines.some((line) => line.includes("esc close"))).toBe(true);
		expect(lines.join("\n")).not.toContain("escape");
		expect(stripAnsi(renderHintLine(detailHints(new KeybindingsManager()), 80))).toContain(" · ");
	});

	it("formats empty states and positions the same way, within the width", () => {
		const line = emptyState(noMatchMessage("sessions", "zzz"), ["esc", "clears"], 20);
		expect(visibleWidth(line)).toBeLessThanOrEqual(20);
		expect(stripAnsi(emptyState("No things", ["esc", "clears"]))).toBe("  No things · esc clears");
		expect(positionLabel(1, 5, 20)).toBe("1–5/20");
	});
});

describe("manage page paging", () => {
	it("page keys move the cursor by the visible rows, so Enter acts on a row in view", () => {
		const rows = Array.from({ length: 40 }, (_, index) => ({ id: `r${index}`, name: `row ${index}` }));
		const selected: string[] = [];
		const page = new ManagePageComponent({
			title: "Page",
			viewportRows: () => 14,
			sections: [{ heading: "Rows", rows }],
			hints: [["enter", "open"]],
			onSelect: (id) => selected.push(id),
			onCancel() {},
		});
		const first = page.render(60).map(stripAnsi);
		const rowsShown = first.filter((line) => /row \d+/.test(line)).length;
		expect(first.join("\n")).toContain(`1–${rowsShown}/40`);
		page.handleInput("\x1b[6~");
		page.handleInput("\x1b[6~");
		const shown = page.render(60).map(stripAnsi);
		expect(shown.join("\n")).not.toContain("row 0 ");
		expect(shown.some((line) => line.includes(`› row ${rowsShown * 2}`))).toBe(true);
		page.handleInput("\r");
		expect(selected).toEqual([`r${rowsShown * 2}`]);
	});
});

describe("retry status", () => {
	it("stays one row at 30 columns and reads Retrying… at 0 seconds", () => {
		vi.useFakeTimers({ now: 0 });
		const tui = { requestRender: vi.fn(), terminal: { rows: 10 } } as unknown as TUI;
		const indicator = new RetryStatusIndicator(tui, 1, 3, 1000);
		const narrow = indicator.render(30);
		expect(narrow).toHaveLength(2);
		for (const line of narrow) expect(visibleWidth(line)).toBeLessThanOrEqual(30);
		vi.setSystemTime(1500);
		vi.advanceTimersByTime(1500);
		const text = stripAnsi(indicator.render(80).join("\n"));
		indicator.dispose();
		expect(text).toContain("Retrying (1/3)…");
		expect(text).not.toContain("in 0s");
	});
});

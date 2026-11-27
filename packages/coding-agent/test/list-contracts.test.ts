import { setKeybindings, visibleWidth } from "@octocodeai/octocode-tui";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { DialogSelectorComponent } from "../src/modes/interactive/components/dialog-selector.ts";
import { OAuthSelectorComponent } from "../src/modes/interactive/components/oauth-selector.ts";
import { SearchableSelectorComponent } from "../src/modes/interactive/components/searchable-selector.ts";
import { ThinkingSelectorComponent } from "../src/modes/interactive/components/thinking-selector.ts";
import { UserMessageSelectorComponent } from "../src/modes/interactive/components/user-message-selector.ts";
import { initTheme } from "../src/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const ESC = "\x1b";
const DOWN = "\x1b[B";
const UP = "\x1b[A";
const PAGE_DOWN = "\x1b[6~";
const shown = (lines: string[]) => lines.map(stripAnsi);
const click = (type: "press" | "click", y: number) =>
	({
		type,
		button: "left",
		x: 4,
		y,
		screenX: 4,
		screenY: y,
		width: 80,
		height: 40,
		shift: false,
		alt: false,
		ctrl: false,
	}) as const;

/** Every rendered line fits the width: hints and rows are cut, never wrapped. */
function expectFits(lines: string[], width: number): void {
	for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
}

beforeEach(() => {
	initTheme("dark");
	setKeybindings(new KeybindingsManager());
});

describe("picker contract", () => {
	const items = Array.from({ length: 30 }, (_, i) => ({ value: String(i), label: `target ${i}` }));

	it("searchable picker: ⌕ search line, a–b/total foot, clamped ends, page = visible rows", () => {
		const select = vi.fn();
		const picker = new SearchableSelectorComponent("References", items, select, vi.fn());
		const lines = shown(picker.render(80));
		expect(lines.some((line) => line.startsWith(" ⌕ "))).toBe(true);
		expect(lines.some((line) => line.startsWith("› target 0"))).toBe(true);
		expect(lines.join("\n")).toContain("1–12/30");
		picker.handleInput(UP);
		picker.handleInput("\r");
		expect(select).toHaveBeenLastCalledWith("0");
		picker.handleInput(PAGE_DOWN);
		picker.handleInput("\r");
		expect(select).toHaveBeenLastCalledWith("12");
		expectFits(picker.render(40), 40);
	});

	it("esc clears an active search first, then cancels", () => {
		const cancel = vi.fn();
		const picker = new SearchableSelectorComponent("References", items, vi.fn(), cancel);
		for (const key of "zzz") picker.handleInput(key);
		const empty = shown(picker.render(80)).join("\n");
		expect(empty).toContain('No items match "zzz" · esc clears');
		expect(empty).not.toContain("enter");
		picker.handleInput(ESC);
		expect(cancel).not.toHaveBeenCalled();
		expect(shown(picker.render(80)).join("\n")).toContain("target 0");
		picker.handleInput(ESC);
		expect(cancel).toHaveBeenCalledOnce();
	});

	it("thinking picker: no search line, current level highlighted, stops at the ends", () => {
		const select = vi.fn();
		const picker = new ThinkingSelectorComponent("high", ["off", "medium", "high"], select, vi.fn());
		const lines = shown(picker.render(80));
		expect(lines.some((line) => line.includes("⌕"))).toBe(false);
		expect(lines.some((line) => line.startsWith("› ✓ high"))).toBe(true);
		picker.handleInput(DOWN);
		picker.handleInput("\r");
		expect(select).toHaveBeenLastCalledWith("high");
	});

	it("fork picker: two-line rows, most recent highlighted, typing filters", () => {
		const select = vi.fn();
		const picker = new UserMessageSelectorComponent(
			[
				{ id: "a", text: "first question" },
				{ id: "b", text: "second question" },
			],
			select,
			vi.fn(),
		);
		const list = picker.getMessageList();
		const lines = shown(picker.render(80));
		expect(lines.some((line) => line.startsWith("› second question"))).toBe(true);
		expect(lines.join("\n")).toContain("Message 2 of 2");
		for (const key of "first") list.handleInput(key);
		list.handleInput("\r");
		expect(select).toHaveBeenCalledWith("a");
		for (const key of "zz") list.handleInput(key);
		expect(shown(picker.render(80)).join("\n")).toContain('No user messages match "firstzz" · esc clears');
	});

	it("login picker: search narrows providers, empty search names its recovery key", () => {
		const select = vi.fn();
		const picker = new OAuthSelectorComponent(
			"sign-in",
			[
				{ id: "anthropic", name: "Anthropic", authType: "oauth" },
				{ id: "openai", name: "OpenAI", authType: "api_key" },
			],
			select,
			vi.fn(),
		);
		for (const key of "openai") picker.handleInput(key);
		picker.handleInput("\r");
		expect(select).toHaveBeenCalledWith("openai", "api_key");
		picker.handleInput("x");
		expect(shown(picker.render(80)).join("\n")).toContain('No providers match "openaix" · esc clears');
	});
});

describe("dialog contract", () => {
	it("numbers the answers, number keys move the cursor, Enter confirms", () => {
		const select = vi.fn();
		const dialog = new DialogSelectorComponent("Pick a branch", ["main", "dev", "next"], select, vi.fn());
		const lines = shown(dialog.render(80));
		expect(lines.some((line) => line.startsWith("› 1. main"))).toBe(true);
		expect(lines.some((line) => line.startsWith("  3. next"))).toBe(true);
		dialog.handleInput("3");
		expect(select).not.toHaveBeenCalled();
		dialog.handleInput(DOWN);
		dialog.handleInput("\r");
		expect(select).toHaveBeenCalledWith("next");
	});

	function answerRow(dialog: DialogSelectorComponent, label: string): number {
		return shown(dialog.render(80)).findIndex((line) => line.includes(label));
	}

	it("a click selects and a second click on the same answer confirms", () => {
		const select = vi.fn();
		const dialog = new DialogSelectorComponent("Pick a branch", ["main", "dev"], select, vi.fn());
		const y = answerRow(dialog, "2. dev");
		dialog.handleMouse(click("press", y));
		dialog.handleMouse(click("click", y));
		expect(select).not.toHaveBeenCalled();
		expect(shown(dialog.render(80))[y]).toContain("› 2. dev");
		dialog.handleMouse(click("press", y));
		dialog.handleMouse(click("click", y));
		expect(select).toHaveBeenCalledWith("dev");
	});

	it("a confirmation lists its safe answer first and never confirms by click", () => {
		const select = vi.fn();
		const dialog = new DialogSelectorComponent("Remove the key?", ["Cancel", "Remove"], select, vi.fn());
		expect(shown(dialog.render(80)).some((line) => line.startsWith("› 1. Cancel"))).toBe(true);
		const y = answerRow(dialog, "2. Remove");
		for (let i = 0; i < 2; i++) {
			dialog.handleMouse(click("press", y));
			dialog.handleMouse(click("click", y));
		}
		expect(select).not.toHaveBeenCalled();
		dialog.handleInput("\r");
		expect(select).toHaveBeenCalledWith("Remove");
	});

	it("a dialog marked destructive never confirms by click", () => {
		const select = vi.fn();
		const dialog = new DialogSelectorComponent("Purge?", ["Keep", "Purge"], select, vi.fn(), {
			destructive: true,
		});
		const y = answerRow(dialog, "1. Keep");
		for (let i = 0; i < 2; i++) {
			dialog.handleMouse(click("press", y));
			dialog.handleMouse(click("click", y));
		}
		expect(select).not.toHaveBeenCalled();
	});

	it("hints stay on one line at 40 columns", () => {
		const dialog = new DialogSelectorComponent("Pick", ["a", "b"], vi.fn(), vi.fn());
		expectFits(dialog.render(40), 40);
	});
});

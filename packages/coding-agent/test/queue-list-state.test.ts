import { getKeybindings, setKeybindings, stripTerminalSequences, visibleWidth } from "@octocodeai/octocode-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { QueueListComponent } from "../src/modes/interactive/components/queue-list.ts";
import { initTheme } from "../src/theme/theme.ts";

const initialBindings = getKeybindings();

beforeEach(() => {
	initTheme("dark");
	setKeybindings(new KeybindingsManager());
});
afterEach(() => setKeybindings(initialBindings));

describe("queue list state and controls", () => {
	it("shows and accepts configured selection keys", () => {
		setKeybindings(new KeybindingsManager({ "tui.select.confirm": "ctrl+y", "tui.select.cancel": "ctrl+x" }));
		const onAction = vi.fn();
		const onClose = vi.fn();
		const list = new QueueListComponent(onAction, onClose);
		list.setRows([{ mode: "steer", text: "Review the patch", notes: [] }]);
		const text = list.render(100).map(stripTerminalSequences).join("\n");
		expect(text).toContain("ctrl+y edit");
		expect(text).toContain("ctrl+x close");
		expect(text).not.toContain("enter edit");
		expect(text).not.toContain("esc close");
		list.handleInput("\x19");
		list.handleInput("\x18");
		expect(onAction).toHaveBeenCalledWith("edit", 0);
		expect(onClose).toHaveBeenCalledOnce();
	});

	it("offers working fallback keys when configured actions are unbound", () => {
		setKeybindings(new KeybindingsManager({ "tui.select.confirm": [], "tui.select.cancel": [] }));
		const onAction = vi.fn();
		const onClose = vi.fn();
		const list = new QueueListComponent(onAction, onClose);
		list.setRows([{ mode: "followUp", text: "Check later", notes: [] }]);
		const text = list.render(100).map(stripTerminalSequences).join("\n");
		expect(text).toContain("e edit");
		expect(text).toContain("q close");
		list.handleInput("e");
		list.handleInput("q");
		expect(onAction).toHaveBeenCalledWith("edit", 0);
		expect(onClose).toHaveBeenCalledOnce();
	});

	it("gives configured actions precedence over letter shortcuts", () => {
		setKeybindings(new KeybindingsManager({ "tui.select.confirm": "k", "tui.select.cancel": "d" }));
		const onAction = vi.fn();
		const onClose = vi.fn();
		const list = new QueueListComponent(onAction, onClose);
		list.setRows([{ mode: "steer", text: "Keep this message", notes: [] }]);
		const text = list.render(100).map(stripTerminalSequences).join("\n");
		expect(text).toContain("k edit");
		expect(text).toContain("d close");
		expect(text).not.toContain("d delete");
		expect(text).toContain("delete remove");
		list.handleInput("k");
		list.handleInput("d");
		expect(onAction.mock.calls).toEqual([["edit", 0]]);
		expect(onClose).toHaveBeenCalledOnce();
	});

	it("keeps empty selection valid and ignores item actions after a queue drains", () => {
		const onAction = vi.fn();
		const onClose = vi.fn();
		const list = new QueueListComponent(onAction, onClose);
		list.setRows([{ mode: "steer", text: "Delivered", notes: [] }]);
		list.setRows([]);
		for (const key of ["\x1b[B", "\r", "e", "d", "s", "J", "K"]) list.handleInput(key);
		expect(list.selectedIndex).toBe(0);
		expect(onAction).not.toHaveBeenCalled();
		const text = list.render(80).map(stripTerminalSequences).join("\n");
		expect(text).toContain("No queued messages");
		expect(text).toContain("esc close");
		expect(text).not.toContain("delete");
		list.handleInput("\x1b");
		expect(onClose).toHaveBeenCalledOnce();
	});

	it("keeps metadata on one safe line and respects every terminal width", () => {
		const list = new QueueListComponent(vi.fn(), vi.fn());
		list.setRows([
			{
				mode: "steer",
				text: "日本語\nnext\u202e\u200b",
				notes: ["extension\nstatus\x1b[2J", "\x1b]0;title\x07note\u2066"],
			},
		]);
		const plain = list.render(100).map(stripTerminalSequences);
		expect(plain.join("\n")).toContain("extension status, note");
		expect(plain.every((line) => !/[\r\n\x07\x1b\u202e\u200b\u2066]/.test(line))).toBe(true);
		expect(list.render(0)).toEqual([]);
		for (const width of [1, 2, 8, 20, 40, 80])
			for (const line of list.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
	});

	it("preserves ordinary Hebrew and Arabic while flattening preview line separators", () => {
		const list = new QueueListComponent(vi.fn(), vi.fn());
		list.setRows([{ mode: "steer", text: "שלום\u2028مرحبا", notes: ["עברית\u2029العربية"] }]);
		const text = list.render(100).map(stripTerminalSequences).join("\n");
		expect(text).toContain("שלום مرحبا");
		expect(text).toContain("עברית العربية");
		expect(text).not.toMatch(/[\u2028\u2029]/);
	});
});

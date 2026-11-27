import { setKeybindings, visibleWidth } from "@octocodeai/octocode-tui";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { SearchableSelectorComponent } from "../src/modes/interactive/components/searchable-selector.ts";
import { initTheme } from "../src/theme/theme.ts";

beforeEach(() => {
	initTheme("dark");
	setKeybindings(new KeybindingsManager());
});
function picker() {
	const select = vi.fn();
	const component = new SearchableSelectorComponent(
		"References",
		Array.from({ length: 40 }, (_, i) => ({ value: String(i), label: `target ${i}` })),
		select,
		vi.fn(),
	);
	return { component, select };
}
describe("searchable selector navigation", () => {
	it("pages a large list and keeps the selected value while narrowing its query", () => {
		const { component, select } = picker();
		component.handleInput("\x1b[6~");
		for (const key of "target") component.handleInput(key);
		component.handleInput("\x1b[D");
		component.handleInput("\r");
		expect(select).toHaveBeenCalledWith("12");
		expect(component.render(80).length).toBeLessThan(30);
	});
	it("routes configured page keys and clamps the first and last pages", () => {
		setKeybindings(new KeybindingsManager({ "tui.select.pageDown": "ctrl+n", "tui.select.pageUp": "ctrl+p" }));
		const { component, select } = picker();
		for (let i = 0; i < 5; i++) component.handleInput("\x0e");
		component.handleInput("\r");
		expect(select).toHaveBeenLastCalledWith("39");
		for (let i = 0; i < 5; i++) component.handleInput("\x10");
		component.handleInput("\r");
		expect(select).toHaveBeenLastCalledWith("0");
	});
	it("describes an empty reference result as items", () => {
		const { component } = picker();
		component.handleInput("zzz");
		expect(component.render(80).join("\n")).toContain('No items match "zzz" · esc clears');
	});
	it("fits Unicode command rows at narrow and wide widths", () => {
		const component = new SearchableSelectorComponent(
			"Commands",
			[{ value: "a", label: "/命令👩‍💻", description: "café é description" }],
			vi.fn(),
			vi.fn(),
			{ commandColumns: true },
		);
		for (const width of [12, 20, 80, 160]) {
			// The list row is bounded independently of the surrounding title and key hints.
			const row = component.render(width).find((line) => line.includes("›"));
			expect(row).toBeDefined();
			expect(visibleWidth(row!)).toBeLessThanOrEqual(width);
		}
	});
});

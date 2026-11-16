import { setKeybindings, visibleWidth } from "@octocodeai/octocode-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { ManagePageComponent } from "../src/theme/manage-page.ts";
import { initTheme } from "../src/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

describe("ManagePageComponent", () => {
	beforeAll(() => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
	});

	const make = (onSelect = vi.fn(), onKey = vi.fn()) =>
		new ManagePageComponent({
			title: "Anthropic — configured",
			facts: [{ label: "Status", value: "key configured · ANTHROPIC_API_KEY" }],
			sections: [
				{
					heading: "Actions",
					rows: [
						{ id: "a", name: "Sign out", badge: "on", tone: "success" },
						{ id: "b", name: "Disable provider" },
					],
				},
				{ heading: "Empty", rows: [], empty: "nothing here" },
			],
			hints: [
				["enter", "run", 0],
				["e", "toggle", 1],
				["esc", "back", 2],
			],
			keys: ["e"],
			onSelect,
			onKey,
			onCancel: vi.fn(),
		});

	it("renders facts, sections and one hint line within every width", () => {
		for (const width of [80, 40, 20]) {
			const lines = make().render(width);
			for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
		const output = stripAnsi(make().render(80).join("\n"));
		expect(output).toContain("Status  key configured");
		expect(output).toContain("nothing here");
		expect(output).toMatch(/enter run · e toggle · esc back/);
	});

	it("opens the selected row on Enter and reports page keys with it", () => {
		const onSelect = vi.fn();
		const onKey = vi.fn();
		const page = make(onSelect, onKey);
		page.handleInput("\x1b[B");
		page.handleInput("\r");
		page.handleInput("e");
		expect(onSelect).toHaveBeenCalledWith("b");
		expect(onKey).toHaveBeenCalledWith("e", "b");
	});

	describe("row keys", () => {
		const keyed = (onKey = vi.fn()) =>
			new ManagePageComponent({
				title: "Servers",
				sections: [
					{
						heading: "Servers",
						rows: [
							{ id: "srv", name: "docs", keys: { e: "edit" } },
							{ id: "add", name: "+ Add" },
						],
					},
				],
				onSelect: vi.fn(),
				onKey,
				onCancel: vi.fn(),
			});

		it("shows the selected row's keys in the footer and no others", () => {
			const page = keyed();
			expect(stripAnsi(page.render(80).join("\n"))).toMatch(/enter open · e edit · esc\S* close/);
			page.handleInput("\x1b[B");
			const footer = stripAnsi(page.render(80).join("\n"));
			expect(footer).toMatch(/enter open · esc\S* close/);
			expect(footer).not.toContain("e edit");
		});

		it("ignores a key the selected row does not declare", () => {
			const onKey = vi.fn();
			const page = keyed(onKey);
			page.handleInput("e");
			expect(onKey).toHaveBeenCalledWith("e", "srv");
			onKey.mockClear();
			page.handleInput("\x1b[B");
			page.handleInput("e");
			expect(onKey).not.toHaveBeenCalled();
		});

		it("says back when nested and drops enter on an empty page", () => {
			const empty = new ManagePageComponent({
				title: "T",
				nested: true,
				sections: [{ heading: "S", rows: [], empty: "none" }],
				onSelect: vi.fn(),
				onCancel: vi.fn(),
			});
			const footer = stripAnsi(empty.render(80).join("\n"));
			expect(footer).toMatch(/esc\S* back/);
			expect(footer).not.toContain("enter");
		});
	});
});

import { setKeybindings, visibleWidth } from "@octocodeai/octocode-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { ManagePageComponent } from "../src/modes/interactive/components/manage-page.ts";
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
});

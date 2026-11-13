import { setKeybindings, visibleWidth } from "@octocodeai/octocode-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { ManagePageComponent } from "../src/theme/manage-page.ts";
import { initTheme } from "../src/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

beforeAll(() => {
	initTheme("dark");
	setKeybindings(new KeybindingsManager());
});

function page() {
	return new ManagePageComponent({
		title: "Providers",
		sections: [
			{
				heading: "Configured",
				rows: Array.from({ length: 20 }, (_, index) => ({
					id: String(index),
					name: "Example provider",
					badge: "authentication required",
					tone: "warning" as const,
				})),
			},
		],
		hints: [
			["enter", "configure"],
			["esc", "back"],
		],
		onSelect: vi.fn(),
		onCancel: vi.fn(),
	});
}

describe("narrow management pages", () => {
	it("keeps badges, pagination and borders within the viewport through resize", () => {
		const view = page();
		for (const width of [80, 30, 20, 10, 4, 1, 0, 30]) {
			for (const row of view.render(width))
				expect(visibleWidth(row), `width ${width}: ${stripAnsi(row)}`).toBeLessThanOrEqual(width);
		}
	});

	it("keeps a long status readable when it fits beside the selected marker", () => {
		const rows = page().render(30).map(stripAnsi);
		expect(rows.some((row) => row.includes("authentication required") && row.includes("›"))).toBe(true);
	});

	it("keeps selection visible when the viewport has no room for a badge", () => {
		expect(
			page()
				.render(4)
				.map(stripAnsi)
				.some((row) => row.includes("›")),
		).toBe(true);
	});
});

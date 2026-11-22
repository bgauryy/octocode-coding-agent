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

	it("keeps the indent of a selected row's detail, notes and facts on every wrapped line", () => {
		const view = new ManagePageComponent({
			title: "Providers",
			notes: ["a long note that has to wrap across several lines of this narrow page"],
			sections: [
				{
					heading: "Ready",
					rows: [{ id: "a", name: "mock", detail: "local · apiKey in ~/.octocode/models.json · 2 models" }],
				},
			],
			hints: [["esc", "back"]],
			onSelect: vi.fn(),
			onCancel: vi.fn(),
		});
		const lines = view.render(40).map(stripAnsi);
		const detail = lines.slice(lines.findIndex((line) => line.includes("› mock")) + 1);
		const continued = detail.slice(0, 2);
		expect(continued.every((line) => line.startsWith("   "))).toBe(true);
		const note = lines.slice(lines.findIndex((line) => line.includes("a long note")));
		expect(note.slice(0, 2).every((line) => line.startsWith(" "))).toBe(true);
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(40);
	});

	it("shows a long selected row's detail once, wrapped beneath the name, never cut", () => {
		const path = "/very/long/directory/for/the/models/file/that/holds/the/provider/definition/models.json";
		const view = new ManagePageComponent({
			title: "Providers",
			sections: [{ heading: "Files", rows: [{ id: "a", name: "Octocode", detail: `${path} · defines one` }] }],
			onSelect: vi.fn(),
			onCancel: vi.fn(),
		});
		const text = view.render(60).map(stripAnsi).join("");
		expect(text.split("models.json").length - 1).toBe(1);
		expect(text.replaceAll(/\s+/g, "")).toContain(path.replaceAll("/", "/"));
	});
});

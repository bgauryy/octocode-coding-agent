import { GLYPH, setKeybindings } from "@octocodeai/octocode-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { showModelsPage } from "../src/modes/interactive/interactive-mode/models-page.ts";
import { initTheme } from "../src/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

type Page = { render(width: number): string[]; handleInput(data: string): void };

beforeAll(() => {
	initTheme("dark");
	setKeybindings(new KeybindingsManager());
});

function setup() {
	let hidden: Record<string, string[]> = {};
	const pages: Page[] = [];
	const runtime = {
		getProviders: () => [
			{ id: "a", name: "Alpha", auth: { apiKey: { name: "API key" } } },
			{ id: "b", name: "Beta", auth: { apiKey: { name: "API key" } } },
		],
		getProvider: (id: string) => ({ id, name: id === "a" ? "Alpha" : "Beta", auth: { apiKey: { name: "API key" } } }),
		getProviderKind: () => "API key",
		getProviderAuthStatus: () => ({ configured: true, source: "environment", label: "KEY" }),
		hasConfiguredAuth: () => true,
		getAvailableSnapshot: () => [
			{ provider: "a", id: "m1" },
			{ provider: "a", id: "m2" },
			{ provider: "b", id: "n1" },
		],
		getModels: (id: string) => (id === "a" ? [{ id: "m1" }, { id: "m2" }] : [{ id: "n1" }]),
		getPlanDisabledReason: () => undefined,
		getProviderDefinitionFile: () => undefined,
		listCredentials: async () => [],
		readCredential: async () => undefined,
		getAuth: async () => undefined,
		setHiddenModels: vi.fn(),
		setDisabledProviders: vi.fn(),
	};
	const settingsManager = {
		getDisabledProviders: () => ["b"],
		getHiddenModels: () => hidden,
		setHiddenModels: (next: Record<string, string[]>) => void (hidden = next),
		saveDefaultModelSelection: vi.fn(),
	};
	const host = {
		session: { modelRuntime: runtime, settingsManager },
		showSelector: (create: (done: () => void) => { component: unknown }) =>
			void pages.push(create(vi.fn()).component as Page),
		ui: { terminal: { rows: 40 } },
		showStatus: vi.fn(),
		updateAvailableProviderCount: vi.fn(),
	};
	return { host, pages, settingsManager, hidden: () => hidden };
}

const text = (page: Page) => stripAnsi(page.render(120).join("\n"));
const open = async (pages: Page[], index: number) => {
	await vi.waitFor(() => expect(pages.length).toBeGreaterThan(index));
	return pages[index];
};

describe("/models page", () => {
	it("lists enabled providers as headings, toggles a model and sets the default", async () => {
		const { host, pages, settingsManager, hidden } = setup();
		const run = showModelsPage(host as never);
		const first = await open(pages, 0);
		expect(text(first)).toContain("Alpha");
		expect(text(first)).not.toContain("Beta");
		expect(
			text(first)
				.split("\n")
				.find((line) => line.includes(`${GLYPH.cursor} `)),
		).toContain("m1");
		first.handleInput("\r");
		const second = await open(pages, 1);
		expect(hidden()).toEqual({ a: ["m1"] });
		expect(text(second)).toMatch(/m1 .*off/);
		second.handleInput("d");
		const third = await open(pages, 2);
		expect(settingsManager.saveDefaultModelSelection).toHaveBeenCalledWith("a", "m1");
		third.handleInput("\r");
		const fourth = await open(pages, 3);
		expect(hidden()).toEqual({});
		fourth.handleInput("\x1b");
		await run;
	});
});

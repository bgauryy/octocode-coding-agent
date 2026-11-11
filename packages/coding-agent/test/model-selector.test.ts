import { setKeybindings, type TUI } from "@octocodeai/octocode-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { ModelSelectorComponent } from "../src/modes/interactive/components/model-selector.ts";
import { initTheme } from "../src/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

function createFakeTui(): TUI {
	return { requestRender: () => {} } as unknown as TUI;
}

describe("model selector", () => {
	let harness: Harness | undefined;

	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	afterEach(() => {
		harness?.cleanup();
		harness = undefined;
	});

	it("keeps the current model marked while browsing", async () => {
		harness = await createHarness({
			models: [
				{ id: "current-model", name: "Current Model", reasoning: true },
				{ id: "browsed-model", name: "Browsed Model", reasoning: true },
			],
		});
		const currentModel = harness.getModel("current-model")!;
		const selector = new ModelSelectorComponent(
			createFakeTui(),
			currentModel,
			harness.session.modelRuntime,
			[],
			() => {},
			() => {},
		);

		const getModelRow = (id: string): string | undefined =>
			stripAnsi(selector.render(120).join("\n"))
				.split("\n")
				.find((line) => line.includes(`${id} [`))
				?.trimEnd();

		// The badge names the provider's kind: the faux provider serves from localhost.
		expect(getModelRow("current-model")).toBe(`› ✓ current-model [${currentModel.provider} · local]`);
		selector.handleInput("\x1b[B");
		expect(getModelRow("current-model")).toBe(`  ✓ current-model [${currentModel.provider} · local]`);
		expect(getModelRow("browsed-model")).toBe(`›   browsed-model [${currentModel.provider} · local]`);
		expect(stripAnsi(selector.render(120).join("\n"))).toContain(
			`Model Name: Browsed Model · Provider: ${currentModel.provider} (local)`,
		);
		selector.dispose();
	});

	it("switches the shown provider with left and right, then back to all", async () => {
		harness = await createHarness({ models: [{ id: "first-model", name: "First" }] });
		const first = harness.getModel("first-model")!;
		const other = { ...first, provider: "other-provider", id: "other-model", name: "Other" };
		vi.spyOn(harness.session.modelRuntime, "getAvailableSnapshot").mockReturnValue([first, other]);
		vi.spyOn(harness.session.modelRuntime, "refresh").mockResolvedValue({ aborted: false, errors: new Map() });
		const selector = new ModelSelectorComponent(
			createFakeTui(),
			first,
			harness.session.modelRuntime,
			[],
			() => {},
			() => {},
		);
		const screen = () => stripAnsi(selector.render(120).join("\n"));
		const shows = (id: string) => screen().includes(`${id} [`);

		expect(screen()).toContain("Provider: all");
		expect([shows("first-model"), shows("other-model")]).toEqual([true, true]);
		selector.handleInput("\x1b[C");
		expect(screen()).toContain(`Provider: ${first.provider}`);
		expect([shows("first-model"), shows("other-model")]).toEqual([true, false]);
		selector.handleInput("\x1b[C");
		expect([shows("first-model"), shows("other-model")]).toEqual([false, true]);
		selector.handleInput("\x1b[C");
		expect(screen()).toContain("Provider: all");
		selector.handleInput("\x1b[D");
		expect(screen()).toContain("Provider: other-provider");
		expect(selector.getSearchInput().getValue()).toBe("");
		selector.dispose();
	});

	it("uses the configured save binding", async () => {
		setKeybindings(new KeybindingsManager({ "app.models.save": "ctrl+r" }));
		harness = await createHarness();
		const currentModel = harness.getModel();
		const saveDefault = vi.fn();
		const selector = new ModelSelectorComponent(
			createFakeTui(),
			currentModel,
			harness.session.modelRuntime,
			[],
			() => {},
			() => {},
			undefined,
			saveDefault,
		);

		expect(stripAnsi(selector.render(120).join("\n"))).toContain("ctrl+r set as default");
		selector.handleInput("\x13");
		expect(saveDefault).not.toHaveBeenCalled();
		selector.handleInput("\x12");
		expect(saveDefault).toHaveBeenCalledWith(currentModel);
	});

	it("lists every catalog that failed to refresh", async () => {
		harness = await createHarness();
		vi.spyOn(harness.session.modelRuntime, "refresh").mockResolvedValue({
			aborted: false,
			errors: new Map([
				["openai", new Error("unavailable")],
				["anthropic", new Error("unavailable")],
			]),
		});

		const selector = new ModelSelectorComponent(
			createFakeTui(),
			harness.getModel(),
			harness.session.modelRuntime,
			[],
			() => {},
			() => {},
		);

		await vi.waitFor(() => {
			const rendered = stripAnsi(selector.render(120).join("\n"));
			expect(rendered).toContain("Could not refresh 2 model catalogs (openai, anthropic); showing cached models.");
		});
	});
});

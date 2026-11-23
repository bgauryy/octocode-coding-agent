import { setKeybindings, visibleWidth, type TUI } from "@octocodeai/octocode-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { modelRowLines } from "../src/modes/interactive/components/model-selector/rows.ts";
import { ModelSelectorComponent } from "../src/modes/interactive/components/model-selector.ts";
import { initTheme } from "../src/theme/theme.ts";
import { keyText } from "../src/theme/theme-tui-helpers.ts";
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
				.find((line) => /^(?:› | {2})(?:✓ | {2})/.test(line) && line.includes(id))
				?.trimEnd();

		// The badge names the provider's kind: the faux provider serves from localhost.
		expect(getModelRow("current-model")).toBe("› ✓ current-model");
		expect(stripAnsi(selector.render(120).join("\n"))).toContain(`${currentModel.provider} · local`);
		selector.handleInput("\x1b[B");
		expect(getModelRow("current-model")).toBe("  ✓ current-model");
		expect(getModelRow("browsed-model")).toBe("›   browsed-model");
		selector.handleInput("\x1bi");
		expect(stripAnsi(selector.render(120).join("\n"))).toContain(
			`Model Name: Browsed Model · Provider: ${currentModel.provider} (local)`,
		);
		selector.dispose();
	});

	it("keeps the browsed model when catalog refresh completes during a search", async () => {
		harness = await createHarness({
			models: [
				{ id: "first-model", name: "First" },
				{ id: "second-model", name: "Second" },
			],
		});
		let finish!: (result: { aborted: boolean; errors: Map<string, Error> }) => void;
		vi.spyOn(harness.session.modelRuntime, "refresh").mockImplementation(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		const select = vi.fn();
		const selector = new ModelSelectorComponent(
			createFakeTui(),
			harness.getModel("first-model"),
			harness.session.modelRuntime,
			[],
			select,
			vi.fn(),
		);
		for (const key of "model") selector.handleInput(key);
		selector.handleInput("\x1b[B");
		finish({ aborted: false, errors: new Map() });
		await vi.waitFor(() => expect(stripAnsi(selector.render(120).join("\n"))).toContain("Model catalogs refreshed."));
		// An ignored input key must not reset the filtered selection either.
		selector.handleInput("\x07");
		selector.handleInput("\r");
		expect(select).toHaveBeenCalledWith(harness.getModel("second-model"));
	});

	it("pages the model rows by the visible rows, stopping at the end, without changing the search query", async () => {
		harness = await createHarness({
			models: Array.from({ length: 15 }, (_, index) => ({ id: `model-${index}`, name: `Model ${index}` })),
		});
		vi.spyOn(harness.session.modelRuntime, "refresh").mockResolvedValue({ aborted: false, errors: new Map() });
		const select = vi.fn();
		const selector = new ModelSelectorComponent(
			createFakeTui(),
			harness.getModel("model-0"),
			harness.session.modelRuntime,
			[],
			select,
			vi.fn(),
		);
		selector.handleInput("\x1b[6~");
		expect(selector.getQuery()).toBe("");
		const screen = () => stripAnsi(selector.render(120).join("\n"));
		expect(screen()).toContain("/15");
		expect(screen()).toMatch(/^› ✓? *model-10$/m);
		selector.handleInput("\x1b[6~");
		selector.handleInput("\r");
		expect(select).toHaveBeenCalledWith(harness.getModel("model-14"));
	});

	it("marks a model models.dev added as new and dims a deprecated one, with the word beside it", async () => {
		harness = await createHarness({
			models: [
				{ id: "added-model", name: "Added" },
				{ id: "old-model", name: "Old" },
				{ id: "plain-model", name: "Plain" },
			],
		});
		const runtime = harness.session.modelRuntime;
		vi.spyOn(runtime, "getCatalogUpdate").mockImplementation((model) =>
			model.id === "added-model"
				? { source: "models.dev" }
				: model.id === "old-model"
					? { deprecated: true }
					: undefined,
		);
		vi.spyOn(runtime, "isModelDeprecated").mockImplementation((model) => model.id === "old-model");
		vi.spyOn(runtime, "refresh").mockResolvedValue({ aborted: false, errors: new Map() });
		const selector = new ModelSelectorComponent(
			createFakeTui(),
			harness.getModel("plain-model"),
			runtime,
			[],
			vi.fn(),
			vi.fn(),
		);
		const raw = selector.render(80);
		const row = (id: string) => raw.find((line) => stripAnsi(line).includes(id)) ?? "";
		expect(stripAnsi(row("added-model")).trimEnd()).toMatch(/added-model · new$/);
		expect(stripAnsi(row("old-model")).trimEnd()).toMatch(/old-model · deprecated$/);
		expect(stripAnsi(row("plain-model")).trimEnd()).toMatch(/plain-model$/);
		// Dimmed: the deprecated id is painted in the theme's dim colour, the others are not.
		const { theme } = await import("../src/theme/theme.ts");
		expect(row("old-model")).toContain(theme.fg("dim", "old-model"));
		expect(row("added-model")).not.toContain(theme.fg("dim", "added-model"));
		selector.dispose();
	});

	it("clips Unicode model rows and their provider heading", async () => {
		harness = await createHarness({ models: [{ id: "命令👩‍💻", name: "Unicode" }] });
		const model = harness.getModel("命令👩‍💻")!;
		const item = { id: model.id, provider: model.provider, model };
		for (const width of [1, 5, 12, 80, 160]) {
			const lines = modelRowLines(
				item,
				{ selected: true, width, heading: true },
				{ current: true, isDefault: true, kind: "局部" },
			);
			expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
		}
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
		const shows = (id: string) =>
			screen()
				.split("\n")
				.some((line) => line.trimEnd().endsWith(id));

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
		expect(selector.getQuery()).toBe("");
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

		expect(stripAnsi(selector.render(120).join("\n"))).toContain("ctrl+r set default");
		selector.handleInput("\x13");
		expect(saveDefault).not.toHaveBeenCalled();
		selector.handleInput("\x12");
		expect(saveDefault).toHaveBeenCalledWith(currentModel, "both");
	});

	it("switches to the highlighted row and saves it as default only with the save key", async () => {
		harness = await createHarness({
			models: [
				{ id: "alpha-model", name: "Alpha", reasoning: true },
				{ id: "beta-model", name: "Beta", reasoning: true },
			],
		});
		const saveDefault = vi.fn();
		const selector = new ModelSelectorComponent(
			createFakeTui(),
			harness.getModel("alpha-model"),
			harness.session.modelRuntime,
			[],
			() => {},
			() => {},
			undefined,
			saveDefault,
		);
		expect(stripAnsi(selector.render(120).join("\n"))).toContain(
			`enter switch · ctrl+s set default · ${keyText("app.models.details")} details · esc/ctrl+c cancel`,
		);
		selector.handleInput("\x1b[B");
		selector.handleInput("\x13");
		expect(saveDefault).toHaveBeenCalledTimes(1);
		expect(saveDefault.mock.calls[0][0].id).toBe("beta-model");
		expect(saveDefault.mock.calls[0][1]).toBe("both");
	});

	it("treats a bare d as filter text, also from an empty filter", async () => {
		harness = await createHarness({
			models: [
				{ id: "alpha-model", name: "Alpha", reasoning: true },
				{ id: "deepseek-model", name: "Deepseek", reasoning: true },
			],
		});
		const saveDefault = vi.fn();
		const selector = new ModelSelectorComponent(
			createFakeTui(),
			harness.getModel("alpha-model"),
			harness.session.modelRuntime,
			[],
			() => {},
			() => {},
			undefined,
			saveDefault,
		);
		selector.handleInput("d");
		expect(saveDefault).not.toHaveBeenCalled();
		expect(selector.getQuery()).toBe("d");
		selector.dispose();
	});

	it("treats d as filter text once the filter has content", async () => {
		harness = await createHarness({ models: [{ id: "alpha-model", name: "Alpha", reasoning: true }] });
		const saveDefault = vi.fn();
		const selector = new ModelSelectorComponent(
			createFakeTui(),
			harness.getModel("alpha-model"),
			harness.session.modelRuntime,
			[],
			() => {},
			() => {},
			"a",
			saveDefault,
		);
		selector.handleInput("d");
		expect(saveDefault).not.toHaveBeenCalled();
		expect(selector.getQuery()).toBe("ad");
		selector.dispose();
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
	it("hides unavailable shortcut models while keeping all-model scope reachable", async () => {
		harness = await createHarness({
			models: [
				{ id: "enabled", name: "Enabled" },
				{ id: "disabled", name: "Disabled" },
			],
		});
		const enabled = harness.getModel("enabled")!;
		const disabled = harness.getModel("disabled")!;
		vi.spyOn(harness.session.modelRuntime, "getAvailableSnapshot").mockReturnValue([enabled]);
		vi.spyOn(harness.session.modelRuntime, "refresh").mockResolvedValue({ aborted: false, errors: new Map() });
		const select = vi.fn();
		const selector = new ModelSelectorComponent(
			createFakeTui(),
			enabled,
			harness.session.modelRuntime,
			[{ model: disabled }],
			select,
			vi.fn(),
		);
		await vi.waitFor(() => expect(stripAnsi(selector.render(120).join("\n"))).toContain("Model catalogs refreshed."));
		expect(stripAnsi(selector.render(120).join("\n"))).toContain("No available scoped shortcuts");
		expect(stripAnsi(selector.render(120).join("\n"))).not.toContain("connect a provider");
		selector.handleInput("\r");
		expect(select).not.toHaveBeenCalled();
		selector.handleInput("\t");
		expect(stripAnsi(selector.render(120).join("\n"))).toContain("enabled");
		selector.handleInput("\r");
		expect(select).toHaveBeenCalledWith(enabled);
		selector.dispose();
	});

	it("keeps refreshed available shortcut identity and removes unavailable shortcuts", async () => {
		harness = await createHarness({
			models: [
				{ id: "kept", name: "Kept" },
				{ id: "removed", name: "Removed" },
			],
		});
		const kept = harness.getModel("kept")!;
		const removed = harness.getModel("removed")!;
		let finish!: (value: { aborted: boolean; errors: Map<string, Error> }) => void;
		vi.spyOn(harness.session.modelRuntime, "refresh").mockImplementation(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		const available = vi.spyOn(harness.session.modelRuntime, "getAvailableSnapshot").mockReturnValue([kept, removed]);
		const select = vi.fn();
		const selector = new ModelSelectorComponent(
			createFakeTui(),
			kept,
			harness.session.modelRuntime,
			[{ model: kept }, { model: removed }],
			select,
			vi.fn(),
		);
		selector.handleInput("\x1b[B");
		available.mockReturnValue([kept]);
		finish({ aborted: false, errors: new Map() });
		await vi.waitFor(() => expect(stripAnsi(selector.render(120).join("\n"))).toContain("Model catalogs refreshed."));
		selector.handleInput("\r");
		expect(select).toHaveBeenCalledWith(kept);
		selector.dispose();
	});
	it("renders plan billing for a provider accessed through a CLI", async () => {
		harness = await createHarness({ models: [{ id: "cli-model", name: "CLI model" }] });
		vi.spyOn(harness.session.modelRuntime, "getProviderKind").mockReturnValue("CLI");
		vi.spyOn(harness.session.modelRuntime, "getProviderBilling").mockReturnValue("plan");
		const selector = new ModelSelectorComponent(
			createFakeTui(),
			harness.getModel("cli-model"),
			harness.session.modelRuntime,
			[],
			vi.fn(),
			vi.fn(),
		);
		// The compact line says "billed by plan", as the details and /providers do (was "plan billing").
		expect(stripAnsi(selector.render(120).join("\n"))).toContain("billed by plan");
		selector.handleInput("\x1bi");
		expect(stripAnsi(selector.render(120).join("\n"))).toContain("Billing: billed by plan");
		expect(stripAnsi(selector.render(120).join("\n"))).not.toContain("Billing: billed per token");
		selector.dispose();
	});

	describe("Enter with a default callback", () => {
		const ENTER = "\r";
		const DOWN = "\x1b[B";
		const SAVE = "\x13";
		const PREFER = "\x10";
		const DETAILS = "\x1bi";
		const open = async (withDefault = true) => {
			harness = await createHarness({
				models: [
					{ id: "alpha-model", name: "Alpha", reasoning: true },
					{ id: "beta-model", name: "Beta", reasoning: true },
				],
			});
			const calls: string[] = [];
			const selector = new ModelSelectorComponent(
				createFakeTui(),
				harness.getModel("alpha-model"),
				harness.session.modelRuntime,
				[],
				(m) => calls.push(`chat:${m.id}`),
				() => calls.push("cancel"),
				undefined,
				withDefault ? (m, save) => calls.push(`${save}:${m.id}`) : undefined,
			);
			selector.handleInput(DOWN);
			return { selector, calls };
		};
		const screen = (selector: ModelSelectorComponent) => stripAnsi(selector.render(120).join("\n"));

		it("switches this chat at once, with no question", async () => {
			const { selector, calls } = await open();
			selector.handleInput(ENTER);
			expect(calls).toEqual(["chat:beta-model"]);
			expect(screen(selector)).not.toContain("Switch this chat");
			selector.handleInput(ENTER);
			expect(calls).toEqual(["chat:beta-model"]);
		});

		it("switches and saves the default with the save key", async () => {
			const { selector, calls } = await open();
			selector.handleInput(SAVE);
			expect(calls).toEqual(["both:beta-model"]);
		});

		it("offers the provider's preferred model only while the details are open", async () => {
			const { selector, calls } = await open();
			selector.handleInput(PREFER);
			expect(calls).toEqual([]);
			expect(screen(selector)).not.toContain("preferred model");
			selector.handleInput(DETAILS);
			expect(screen(selector)).toContain(`${keyText("app.models.preferred")} set as this provider’s preferred model`);
			selector.handleInput(PREFER);
			expect(calls).toEqual(["provider:beta-model"]);
		});

		it("closes on escape", async () => {
			const { selector, calls } = await open();
			selector.handleInput("\x1b");
			expect(calls).toEqual(["cancel"]);
		});

		it("switches immediately without a default callback, and the save keys do nothing", async () => {
			const { selector, calls } = await open(false);
			selector.handleInput(SAVE);
			selector.handleInput(DETAILS);
			selector.handleInput(PREFER);
			expect(screen(selector)).not.toContain("preferred model");
			expect(calls).toEqual([]);
			selector.handleInput(ENTER);
			expect(calls).toEqual(["chat:beta-model"]);
		});
	});
});

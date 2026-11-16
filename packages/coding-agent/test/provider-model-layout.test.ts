import type { Model } from "@octocodeai/octocode-ai";
import { setKeybindings, visibleWidth, type TUI } from "@octocodeai/octocode-tui";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { ModelRuntime } from "../src/core/model-runtime.ts";
import { ModelSelectorComponent } from "../src/modes/interactive/components/model-selector.ts";
import { ScopedModelsSelectorComponent } from "../src/modes/interactive/components/scoped-models-selector.ts";
import { compactModelDetails } from "../src/modes/interactive/components/model-selector/details.ts";
import { ManagePageComponent } from "../src/theme/manage-page.ts";
import { initTheme } from "../src/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

beforeAll(() => initTheme("dark"));
beforeEach(() => setKeybindings(new KeybindingsManager()));
const text = (component: { render(width: number): string[] }, width = 40) =>
	stripAnsi(component.render(width).join("\n"));
const model = (index: number): Model<"openai-completions"> => ({
	provider: `provider-${index}`,
	id: index === 0 ? "very-long-model-identifier-".repeat(4) : `model-${index}`,
	name: `Model ${index}`,
	api: "openai-completions",
	baseUrl: "https://example.test/v1",
	reasoning: true,
	input: ["text", "image"],
	contextWindow: 200000,
	maxTokens: 32000,
	cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
});

describe("provider and model layout regressions", () => {
	it("keeps close and unavailable status visible on narrow shortcut lists", () => {
		const view = new ScopedModelsSelectorComponent(
			{ allModels: [model(1)], enabledModelIds: ["missing/" + "long-model-name".repeat(4)] },
			{ onChange: vi.fn(), onPersist: vi.fn(), onCancel: vi.fn() },
		);
		const output = text(view);
		expect(output).toContain("esc/ctrl+c close");
		expect(output).toContain("[unavailable]");
		for (const line of view.render(40)) expect(visibleWidth(line)).toBeLessThanOrEqual(40);
	});

	it("does not round a compact output limit above the model's capacity", () => {
		const selected = { ...model(1), maxTokens: 32768 };
		const label = compactModelDetails(selected, "API key")[0];
		const displayed = Number(label.match(/· ([\d.]+)k output/)?.[1]) * 1000;
		expect(displayed).toBeLessThanOrEqual(selected.maxTokens);
		expect(displayed).toBeGreaterThan(selected.maxTokens - 100);
	});
	it("keeps access caveats and the selected row's details readable at narrow widths", () => {
		const page = new ManagePageComponent({
			title: "AI providers",
			sections: [
				{
					heading: "Needs attention",
					rows: [
						{
							id: "missing",
							name: "Long provider name",
							detail: "Provider definition missing; reconnect or remove its saved credential.",
							badge: "unavailable",
							tone: "warning",
						},
					],
				},
			],
			notes: ["Configured, not verified. Test access."],
			hints: [
				["enter", "open"],
				["esc", "back"],
			],
			onSelect: vi.fn(),
			onCancel: vi.fn(),
		});
		const output = text(page);
		expect(output).toContain("not verified");
		expect(output).toContain("definition missing");
		expect(output).toContain("unavailable");
		expect(output).toContain("›");
		for (const width of [1, 4, 20, 40, 80, 120])
			for (const line of page.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
	});

	it("scrolls full facts without activating a row hidden outside the viewport", () => {
		const select = vi.fn();
		const page = new ManagePageComponent({
			title: "Plan",
			facts: Array.from({ length: 20 }, (_, i) => ({ label: `Fact ${i}`, value: `Complete information ${i}` })),
			sections: [{ heading: "Actions", rows: [{ id: "remove", name: "Remove credential" }] }],
			hints: [["enter", "run"]],
			onSelect: select,
			onCancel: vi.fn(),
		});
		page.render(40);
		page.handleInput("\x1b[5~");
		page.render(40);
		page.handleInput("\x1b[5~");
		expect(text(page)).toContain("Fact 0");
		page.handleInput("\r");
		expect(select).not.toHaveBeenCalled();
		page.handleInput("\x1b[B");
		expect(text(page)).toContain("› Remove credential");
		page.handleInput("\r");
		expect(select).toHaveBeenCalledWith("remove");
		expect(page.render(40).length).toBeLessThanOrEqual(24);
	});

	it("fits the compact picker, preserves a long model's default badge, and reveals pricing on demand", async () => {
		const models = Array.from({ length: 6 }, (_, i) => model(i));
		const runtime = {
			getAvailableSnapshot: () => models,
			getModel: (p: string, id: string) => models.find((m) => m.provider === p && m.id === id),
			getProviderKind: () => "subscription",
			getProviderBilling: () => "plan",
			getProvider: () => undefined,
			refresh: async () => ({ aborted: false, errors: new Map() }),
			getError: () => undefined,
		} as unknown as ModelRuntime;
		const save = vi.fn();
		const picker = new ModelSelectorComponent(
			{ requestRender: vi.fn() } as unknown as TUI,
			models[0],
			runtime,
			[],
			vi.fn(),
			vi.fn(),
			undefined,
			save,
			{ provider: models[0].provider, id: models[0].id },
			{ source: "project" },
		);
		await vi.waitFor(() => expect(text(picker)).toContain("Model catalogs refreshed"));
		for (const width of [40, 80, 120]) {
			const lines = picker.render(width);
			expect(lines.length).toBeLessThanOrEqual(24);
			for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			expect(text(picker, width)).toContain("set default");
			expect(text(picker, width)).toContain("· default");
			expect(text(picker, width)).not.toContain("cache read $0.3");
		}
		expect(text(picker, 80)).toContain("Startup default (project)");
		picker.handleInput("\x04");
		const pages: string[] = [];
		for (let page = 0; page < 8; page++) {
			pages.push(text(picker, 120));
			expect(picker.render(120).length).toBeLessThanOrEqual(24);
			picker.handleInput("\x1b[6~");
		}
		expect(pages.join("\n")).toContain("cache read $0.3");
		expect(pages.join("\n")).toContain("billed by plan");
		picker.handleInput("\x13");
		expect(save).toHaveBeenCalledOnce();
		picker.dispose();
	});

	it("keeps shortcut changes unsaved after a failed persistence attempt and allows retry", async () => {
		let settle!: () => void;
		const persist = vi
			.fn()
			.mockImplementationOnce(
				() =>
					new Promise<void>((done) => {
						settle = done;
					}),
			)
			.mockRejectedValueOnce(new Error("disk full"))
			.mockResolvedValue(undefined);
		const frames: string[] = [];
		const requestRender = vi.fn(() => frames.push(text(view)));
		const view = new ScopedModelsSelectorComponent(
			{ allModels: [model(1)], enabledModelIds: null },
			{ onChange: vi.fn(), onPersist: persist, onCancel: vi.fn(), requestRender },
		);
		view.handleInput("\r");
		view.handleInput("\x13");
		view.handleInput("\x13");
		expect(persist).toHaveBeenCalledOnce();
		expect(text(view)).toContain("saving");
		settle();
		await vi.waitFor(() => expect(text(view)).not.toContain("saving"));
		expect(requestRender).toHaveBeenCalledOnce();
		expect(frames.at(-1)).not.toContain("saving");
		view.handleInput("\r");
		view.handleInput("\x13");
		await vi.waitFor(() => expect(text(view)).toContain("disk full"));
		expect(requestRender).toHaveBeenCalledTimes(2);
		expect(frames.at(-1)).toContain("disk full");
		expect(text(view)).toContain("unsaved");
		view.handleInput("\x13");
		await vi.waitFor(() => expect(text(view)).not.toContain("unsaved"));
		expect(text(view)).not.toContain("disk full");
		expect(requestRender).toHaveBeenCalledTimes(3);
		expect(frames.at(-1)).not.toContain("unsaved");
	});
});

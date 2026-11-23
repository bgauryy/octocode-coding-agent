import type { Model } from "@octocodeai/octocode-ai";
import { setKeybindings, visibleWidth, type TUI } from "@octocodeai/octocode-tui";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { ModelRuntime } from "../src/core/model-runtime.ts";
import { type ModelSave, ModelSelectorComponent } from "../src/modes/interactive/components/model-selector.ts";
import { QueueListComponent } from "../src/modes/interactive/components/queue-list.ts";
import { ScopedModelsSelectorComponent } from "../src/modes/interactive/components/scoped-models-selector.ts";
import { initTheme } from "../src/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const ESC = "\x1b";
const DOWN = "\x1b[B";
const UP = "\x1b[A";
const PAGE_DOWN = "\x1b[6~";
const HOME = "\x1b[H";
const END = "\x1b[F";
const screen = (component: { render(width: number): string[] }, width = 80) =>
	stripAnsi(component.render(width).join("\n"));
const cursorRow = (component: { render(width: number): string[] }) =>
	screen(component)
		.split("\n")
		.find((line) => line.startsWith("› "));

/** Every rendered line fits the width: hints and rows are cut, never wrapped. */
function expectFits(component: { render(width: number): string[] }, width: number): void {
	for (const line of component.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
}

const model = (index: number): Model<"openai-completions"> => ({
	provider: index < 15 ? "alpha" : "beta",
	id: `model-${index}`,
	name: `Model ${index}`,
	api: "openai-completions",
	baseUrl: "https://example.test/v1",
	reasoning: true,
	input: ["text"],
	contextWindow: 200000,
	maxTokens: 32000,
	cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
});
const models = Array.from({ length: 30 }, (_, index) => model(index));
const runtime = {
	getAvailableSnapshot: () => models,
	getModel: (provider: string, id: string) => models.find((m) => m.provider === provider && m.id === id),
	getProviderKind: () => "subscription",
	getProviderBilling: () => "plan",
	getModelOrigin: () => "built-in",
	getCatalogUpdate: () => undefined,
	isModelDeprecated: () => false,
	getProvider: () => undefined,
	getDefinedProviderIds: () => [],
	hasConfiguredAuth: () => true,
	refresh: async () => ({ aborted: false, errors: new Map() }),
	getError: () => undefined,
} as unknown as ModelRuntime;
const tui = { requestRender: vi.fn() } as unknown as TUI;

beforeEach(() => {
	initTheme("dark");
	setKeybindings(new KeybindingsManager());
});

describe("model picker contract", () => {
	const picker = (select = vi.fn(), cancel = vi.fn(), asDefault?: (model: Model<any>, save: ModelSave) => void) =>
		new ModelSelectorComponent(tui, models[0], runtime, [], select, cancel, undefined, asDefault);

	it("⌕ search line, › cursor, a–b/total foot, page by visible rows, stops at the ends", () => {
		const select = vi.fn();
		const view = picker(select);
		const text = screen(view);
		expect(text.split("\n").filter((line) => line.includes("⌕"))).toHaveLength(1);
		expect(cursorRow(view)).toContain("model-0");
		expect(text).toContain("1–10/30");
		view.handleInput(UP);
		expect(cursorRow(view)).toContain("model-0");
		view.handleInput(PAGE_DOWN);
		expect(cursorRow(view)).toContain("model-10");
		view.handleInput(END);
		view.handleInput(DOWN);
		expect(cursorRow(view)).toContain("model-29");
		view.handleInput(HOME);
		view.handleInput("\r");
		expect(select).toHaveBeenCalledWith(models[0]);
		expectFits(view, 40);
		view.dispose();
	});

	it("a bare d searches and alt+i shows details; the empty line names its search; esc clears, then cancels", () => {
		const cancel = vi.fn();
		const save = vi.fn();
		const view = picker(vi.fn(), cancel, save);
		view.handleInput("\x1bi");
		expect(screen(view, 120)).toContain("Model Name: Model 0");
		view.handleInput("\x1bi");
		for (const key of "dzz") view.handleInput(key);
		expect(save).not.toHaveBeenCalled();
		const empty = screen(view);
		expect(empty).toContain('No models match "dzz" · esc clears');
		expect(empty).not.toContain("enter switch");
		view.handleInput(ESC);
		expect(cancel).not.toHaveBeenCalled();
		expect(view.getQuery()).toBe("");
		view.handleInput(ESC);
		expect(cancel).toHaveBeenCalledOnce();
	});

	it("the hint line stays one line and ends with esc cancel", () => {
		const view = picker(vi.fn(), vi.fn(), vi.fn());
		const hint = screen(view, 120)
			.split("\n")
			.filter((line) => line.includes("set default"));
		expect(hint).toHaveLength(1);
		expect(hint[0]).toMatch(/esc\/ctrl\+c cancel$/);
		for (const width of [40, 60]) {
			expect(
				screen(view, width)
					.split("\n")
					.filter((line) => line.includes("esc")),
			).toHaveLength(1);
			expectFits(view, width);
		}
		view.dispose();
	});

	it("enter switches with no question; the open details offer the provider's preferred model", () => {
		const select = vi.fn();
		const save = vi.fn();
		const view = picker(select, vi.fn(), save);
		view.handleInput("\x1bi");
		expect(screen(view, 120)).toContain("set as this provider’s preferred model");
		expectFits(view, 40);
		view.handleInput("\x10");
		expect(select).not.toHaveBeenCalled();
		expect(save).toHaveBeenCalledWith(models[0], "provider");
		const again = picker(select, vi.fn(), save);
		again.handleInput("\r");
		expect(select).toHaveBeenCalledWith(models[0]);
		expect(screen(again)).not.toContain("Switch this chat");
	});
});

describe("model shortcuts contract", () => {
	const shortcuts = (cancel = vi.fn(), change = vi.fn()) =>
		new ScopedModelsSelectorComponent(
			{ allModels: models, enabledModelIds: [] },
			{ onChange: change, onPersist: vi.fn(), onCancel: cancel },
		);

	it("⌕ search line, a–b/total foot, page keys, clamped ends, Enter toggles", () => {
		const change = vi.fn();
		const view = shortcuts(vi.fn(), change);
		const text = screen(view);
		expect(text.split("\n").filter((line) => line.includes("⌕"))).toHaveLength(1);
		expect(text).toContain("1–8/30");
		view.handleInput(UP);
		expect(cursorRow(view)).toContain("model-0");
		view.handleInput(PAGE_DOWN);
		expect(cursorRow(view)).toContain("model-8");
		view.handleInput("\r");
		expect(change).toHaveBeenLastCalledWith(["alpha/model-8"]);
		expectFits(view, 40);
	});

	it("empty search names its recovery key, hints keep only close, esc clears then closes", () => {
		const cancel = vi.fn();
		const view = shortcuts(cancel);
		for (const key of "zz") view.handleInput(key);
		const empty = screen(view);
		expect(empty).toContain('No models match "zz" · esc clears');
		expect(empty).not.toContain("toggle");
		view.handleInput(ESC);
		expect(cancel).not.toHaveBeenCalled();
		view.handleInput(ESC);
		expect(cancel).toHaveBeenCalledOnce();
	});
});

describe("queue manager contract", () => {
	const rows = Array.from({ length: 12 }, (_, index) => ({
		mode: index % 2 ? ("followUp" as const) : ("steer" as const),
		text: `message ${index}`,
		notes: [],
	}));

	it("› cursor, a–b/total foot, page by visible rows, stops at the ends", () => {
		const action = vi.fn();
		const view = new QueueListComponent(action, vi.fn());
		view.setRows(rows, 0);
		expect(cursorRow(view)).toContain("message 0");
		expect(screen(view)).toContain("1–8/12");
		view.handleInput(UP);
		expect(view.selectedIndex).toBe(0);
		view.handleInput(PAGE_DOWN);
		expect(view.selectedIndex).toBe(8);
		view.handleInput(PAGE_DOWN);
		view.handleInput(DOWN);
		expect(view.selectedIndex).toBe(11);
		view.handleInput("\r");
		expect(action).toHaveBeenCalledWith("edit", 11);
		expectFits(view, 40);
	});

	it("an empty queue names its close key", () => {
		const close = vi.fn();
		const view = new QueueListComponent(vi.fn(), close);
		view.setRows([]);
		expect(screen(view)).toContain("No queued messages · esc close");
		view.handleInput(ESC);
		expect(close).toHaveBeenCalledOnce();
	});
});

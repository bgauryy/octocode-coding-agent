import type { Model } from "@octocodeai/octocode-ai";
import { setKeybindings, type TUI } from "@octocodeai/octocode-tui";
import { beforeAll, beforeEach, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { ModelRuntime } from "../src/core/model-runtime.ts";
import { ModelSelectorComponent } from "../src/modes/interactive/components/model-selector.ts";
import { modelDetails } from "../src/modes/interactive/components/model-selector/details.ts";
import { sortModelItems } from "../src/modes/interactive/components/model-selector/model-items.ts";
import { initTheme } from "../src/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function model(provider: string, id: string): Model<"openai-completions"> {
	return {
		provider,
		id,
		name: id,
		api: "openai-completions",
		baseUrl: "https://example.test",
		reasoning: true,
		contextWindow: 200000,
		maxTokens: 64000,
		input: ["text"],
		cost: { input: 2, output: 8, cacheRead: 0.2, cacheWrite: 2.5 },
		promptCache: { short: 300 },
	};
}
beforeAll(() => initTheme("dark"));
beforeEach(() => setKeybindings(new KeybindingsManager()));

it("keeps provider sections together even when current and default use different providers", () => {
	const models = [
		model("openai", "one"),
		model("anthropic", "two"),
		model("openai", "three"),
		model("anthropic", "four"),
	];
	const items = models.map((item) => ({ id: item.id, provider: item.provider, model: item }));
	expect(sortModelItems(items, models[0], models[1]).map((item) => item.id)).toEqual(["one", "three", "two", "four"]);
});

it("selects only the chosen provider, including when shortcuts point elsewhere", async () => {
	const zen = model("opencode", "zen-only");
	const go = model("opencode-go", "go-only");
	const models = [zen, go];
	const runtime = {
		getAvailableSnapshot: () => models,
		getModel: (provider: string, id: string) => models.find((item) => item.provider === provider && item.id === id),
		refresh: vi.fn(async () => ({ aborted: false, errors: new Map() })),
		getError: () => undefined,
	} as unknown as ModelRuntime;
	const select = vi.fn();
	const selector = new ModelSelectorComponent(
		{ requestRender: vi.fn() } as unknown as TUI,
		go,
		runtime,
		[{ model: go }],
		select,
		vi.fn(),
		"opencode/",
	);
	await vi.waitFor(() => expect(stripAnsi(selector.render(120).join("\n"))).toContain("Model catalogs refreshed."));
	const output = stripAnsi(selector.render(120).join("\n"));
	expect(output).toContain("zen-only");
	expect(output).not.toContain("go-only");
	selector.handleInput("\r");
	expect(select).toHaveBeenCalledWith(zen);
	selector.dispose();
});

it("shows provider catalog rates and limits without promising account billing", () => {
	const selected = model("proxy", "tiered");
	selected.cost.tiers = [{ inputTokensAbove: 200000, input: 4, output: 12, cacheRead: 0.4, cacheWrite: 5 }];
	const details = modelDetails(selected);
	expect(details).toContain("Context 200,000");
	expect(details).toContain("cache read $0.2");
	expect(details).toContain("short 300s");
	expect(details).toContain("Pricing tiers above 200,000");
	expect(details).toContain("billing may differ");
});

it("shows the rates in effect at the given time for a dated price", () => {
	const selected = model("proxy", "dated");
	selected.cost = {
		input: 0.75,
		output: 3.75,
		cacheRead: 0.075,
		cacheWrite: 0,
		until: "2026-12-31",
		after: { input: 1.5, output: 7.5, cacheRead: 0.15, cacheWrite: 0 },
	};
	const during = modelDetails(selected, new Date("2026-12-31T23:59:59Z"));
	expect(during).toContain("input $0.75 · output $3.75 · cache read $0.075");
	const after = modelDetails(selected, new Date("2027-01-01T00:00:00Z"));
	expect(after).toContain("input $1.5 · output $7.5 · cache read $0.15");
	expect(after).not.toContain("$0.75");
});

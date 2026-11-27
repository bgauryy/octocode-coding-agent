import { setKeybindings, type TUI } from "@octocodeai/octocode-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { ModelSelectorComponent } from "../src/modes/interactive/components/model-selector.ts";
import { initTheme } from "../src/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

const LINE = "switching rewrites ~52k cached tokens (~$0.13 at browsed-model's cache-write price)";
const usage = {
	input: 10,
	output: 5,
	cacheRead: 40_000,
	cacheWrite: 12_000,
	totalTokens: 52_015,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

describe("model selector cache cost before a switch", () => {
	let harness: Harness | undefined;
	beforeAll(() => initTheme("dark"));
	beforeEach(() => setKeybindings(new KeybindingsManager()));
	afterEach(() => {
		harness?.cleanup();
		harness = undefined;
	});

	it("names the rewritten cached tokens for another model and nothing for the current one", async () => {
		const cost = { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 };
		harness = await createHarness({
			models: [
				{ id: "current-model", cost },
				{ id: "browsed-model", cost },
			],
		});
		const selector = new ModelSelectorComponent(
			{ requestRender: () => {} } as unknown as TUI,
			harness.getModel("current-model"),
			harness.session.modelRuntime,
			[],
			() => {},
			() => {},
			undefined,
			undefined,
			undefined,
			undefined,
			() => ({ usage }),
		);
		const text = () => stripAnsi(selector.render(160).join("\n"));

		expect(text()).not.toContain("switching rewrites");
		selector.handleInput("\x1b[B");
		expect(text()).toContain(LINE);
	});
});

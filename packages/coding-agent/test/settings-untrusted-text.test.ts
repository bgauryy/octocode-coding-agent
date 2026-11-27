import type { Model } from "@octocodeai/octocode-ai";
import { setKeybindings } from "@octocodeai/octocode-tui";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { ScopedModelsSelectorComponent } from "../src/modes/interactive/components/scoped-models-selector.ts";
import {
	type SettingsCallbacks,
	type SettingsConfig,
	SettingsSelectorComponent,
} from "../src/modes/interactive/components/settings-selector.ts";
import { footerLines } from "../src/octocode/ui/footer/rows.ts";
import { initTheme, theme } from "../src/theme/theme.ts";

// Model ids, names and refresh errors come from vendor model lists and the remote catalog (network text): a clipboard
// write (OSC 52), a screen clear written with ESC and with the one-byte C1 CSI, a title change and a bidi override.
const HOSTILE = "A\x1b]52;c;cHduZWQ=\x07B\x1b[2JC\u009b2JD\x1b]0;title\x07E\u202eF";

/** Every escape, C1 control or bidi override except SGR colours and the TUI's own cursor markers. */
function unsafe(lines: string[]): string[] {
	return lines
		.map((line) => line.replace(/\x1b\[[0-9;:]*m/g, "").replace(/\x1b_octo:[^\x1b]*\x1b\\/g, ""))
		.filter((line) => /[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e]/u.test(line));
}

function model(id: string, provider: string, name: string): Model<any> {
	return { id, provider, name, reasoning: false, input: ["text"] } as unknown as Model<any>;
}

beforeAll(() => initTheme("dark"));
beforeEach(() => setKeybindings(new KeybindingsManager()));

describe("model settings views drawing network text", () => {
	it("the model shortcuts selector draws model ids, names, providers and refresh status without terminal controls", () => {
		const models = [model(`id${HOSTILE}`, `prov${HOSTILE}`, `name${HOSTILE}`), model("plain", "p", "Plain")];
		const selector = new ScopedModelsSelectorComponent(
			{ allModels: models, enabledModelIds: [`missing${HOSTILE}`, "p/plain"], refreshStatus: `refresh${HOSTILE}` },
			{ onChange: () => {}, onPersist: () => {}, onCancel: () => {} },
		);
		expect(unsafe(selector.render(200))).toEqual([]);

		selector.setRefreshStatus(`Could not refresh model catalogs: ${HOSTILE}`, "warning");
		selector.handleInput("\x1b[B");
		const lines = selector.render(200);
		expect(unsafe(lines)).toEqual([]);
		// The text around the controls stays readable.
		expect(lines.join("\n")).toContain("Could not refresh model catalogs:");
	});

	it("the per-model thinking submenu draws the chosen model in its title without terminal controls", () => {
		const hostile = model(`id${HOSTILE}`, "prov", "n");
		const config = {
			defaultModel: "not set",
			availableDefaultModels: [hostile],
			thinkingLevel: "off",
			modelThinkingLevels: {},
		} as unknown as SettingsConfig;
		const list = new SettingsSelectorComponent(config, {
			onCancel: () => {},
		} as unknown as SettingsCallbacks).getSettingsList();

		list.selectItem("model-thinking");
		list.handleInput("\r");
		list.handleInput("\r");
		const lines = list.render(200);
		expect(lines.join("\n")).toContain("Thinking Level for");
		expect(unsafe(lines)).toEqual([]);
	});

	it("the footer draws the model and its effort without terminal controls", () => {
		const usage = { input: 0, output: 0, cacheRead: 0, cost: 0, unpriced: false };
		const state = { usage, cwd: "/tmp", model: `id${HOSTILE}`, thinking: `low${HOSTILE}` };
		for (const width of [200, 40]) {
			const lines = footerLines(state, null, new Map(), theme, width);
			expect(unsafe(lines)).toEqual([]);
			expect(lines.join("\n")).toContain("id");
		}
	});
});

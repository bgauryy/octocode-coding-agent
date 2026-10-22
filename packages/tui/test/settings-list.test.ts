import assert from "node:assert";
import { describe, it } from "node:test";
import { SettingsList, type SettingsListTheme } from "../src/components/settings-list.ts";
import { getKeybindings, KeybindingsManager, setKeybindings, TUI_KEYBINDINGS } from "../src/keybindings.ts";
import { visibleWidth } from "../src/utils.ts";

const testTheme: SettingsListTheme = {
	label: (text) => text,
	value: (text) => text,
	description: (text) => text,
	cursor: "> ",
	hint: (text) => text,
};

const items = [
	{
		id: "tui-mode",
		label: "TUI mode",
		currentValue: "regular",
		values: ["regular", "fullscreen"],
	},
];

describe("SettingsList", () => {
	it("keeps search, change and cancel help visible at 48 columns", () => {
		const list = new SettingsList(
			items,
			10,
			testTheme,
			() => {},
			() => {},
			{ enableSearch: true },
		);
		const lines = list.render(48);
		assert.ok(lines.every((line) => visibleWidth(line) <= 48));
		assert.match(lines.join("\n"), /Type to search/);
		assert.match(lines.join("\n"), /enter\/space change/);
		assert.match(lines.join("\n"), /escape\/ctrl\+c cancel/);
	});

	it("shows configured keys and omits Space while filtering", () => {
		const previous = getKeybindings();
		setKeybindings(
			new KeybindingsManager(TUI_KEYBINDINGS, {
				"tui.select.confirm": "ctrl+y",
				"tui.select.cancel": "ctrl+q",
			}),
		);
		try {
			const list = new SettingsList(
				items,
				10,
				testTheme,
				() => {},
				() => {},
				{ enableSearch: true },
			);
			list.handleInput("TUI");
			const output = list.render(48).join("\n");
			assert.match(output, /ctrl\+y change/);
			assert.match(output, /ctrl\+q cancel/);
			assert.doesNotMatch(output, /space|enter|escape/);
		} finally {
			setKeybindings(previous);
		}
	});

	it("includes spaces in an active search instead of changing the selected setting", () => {
		const changes: Array<{ id: string; value: string }> = [];
		const list = new SettingsList(
			items.map((item) => ({ ...item })),
			10,
			testTheme,
			(id, value) => changes.push({ id, value }),
			() => {},
			{ enableSearch: true },
		);

		for (const character of "TUI mode") list.handleInput(character);

		assert.deepStrictEqual(changes, []);
		assert.match(list.render(80)[0] ?? "", /TUI mode/);

		list.handleInput("\r");
		assert.deepStrictEqual(changes, [{ id: "tui-mode", value: "fullscreen" }]);
	});

	it("keeps Space as a change shortcut before a search query is entered", () => {
		const changes: Array<{ id: string; value: string }> = [];
		const list = new SettingsList(
			items.map((item) => ({ ...item })),
			10,
			testTheme,
			(id, value) => changes.push({ id, value }),
			() => {},
			{ enableSearch: true },
		);

		list.handleInput(" ");

		assert.deepStrictEqual(changes, [{ id: "tui-mode", value: "fullscreen" }]);
	});
});

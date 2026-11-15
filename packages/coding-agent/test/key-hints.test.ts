import { getKeybindings, setKeybindings } from "@octocodeai/octocode-tui";
import { afterEach, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { formatKeyText, keyHint, keyText } from "../src/theme/theme-tui-helpers.ts";
import { shortcutText } from "../src/octocode/shared/keys.ts";
import { initTheme } from "../src/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const previous = getKeybindings();
afterEach(() => setKeybindings(previous));

describe("key hint casing", () => {
	it("writes every key lowercase, whatever case a binding was configured in", () => {
		expect(formatKeyText("shift+tab")).toBe("shift+tab");
		expect(formatKeyText("Ctrl+Shift+P/Escape")).toBe("ctrl+shift+p/esc");
	});

	it("shows the same lowercase text in chips, hints and selector footers", () => {
		initTheme("dark", false);
		setKeybindings(new KeybindingsManager({ "app.permission.cycle": "shift+tab", "tui.select.confirm": "enter" }));
		expect(shortcutText("app.permission.cycle")).toBe("shift+tab");
		expect(keyText("tui.select.confirm")).toBe("enter");
		expect(stripAnsi(keyHint("tui.select.confirm", "to select"))).toBe("enter to select");
	});

	it("names a disabled action in lowercase too", () => {
		setKeybindings(new KeybindingsManager({ "app.permission.cycle": [] }));
		expect(shortcutText("app.permission.cycle")).toBe("unbound");
	});
});

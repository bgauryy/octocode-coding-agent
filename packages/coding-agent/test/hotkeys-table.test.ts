/**
 * `/keys` lists what the main editor and the application answer with the keys in force: the permission mode, the
 * session keys someone bound, and the fullscreen transcript keys in fullscreen mode. A row with no key is left out.
 */
import { type Keybinding, setKeybindings } from "@octocodeai/octocode-tui";
import { describe, expect, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { hotkeysMarkdown } from "../src/modes/interactive/interactive-mode/hotkeys-table.ts";
import { keyText } from "../src/theme/theme-tui-helpers.ts";

const section = (markdown: string, title: string): string =>
	markdown
		.split("\n\n")
		.find((block) => block.startsWith(`**${title}**`))
		?.trim() ?? "";

describe("/keys table", () => {
	it("lists the permission mode, the bound session keys and, in fullscreen, the transcript keys", () => {
		setKeybindings(new KeybindingsManager({ "app.session.tree": "ctrl+shift+y" }));
		const table = hotkeysMarkdown({ key: keyText, fullscreen: true });
		expect(section(table, "Other")).toContain(`| \`${keyText("app.permission.cycle")}\` | Cycle the permission mode |`);
		const sessions = section(table, "Sessions");
		expect(sessions).toContain(`| \`${keyText("app.session.tree")}\` | Open the session tree (\`/tree\`) |`);
		expect(sessions).toContain(`| \`${keyText("app.session.loadEarlier")}\` | Load earlier transcript entries |`);
		// No key by default: no row with an empty key.
		expect(sessions).not.toContain("/new");
		expect(table).not.toContain("``");
		const fullscreen = section(table, "Fullscreen");
		expect(fullscreen).toContain(`\`${keyText("tui.altScreen.toggleMouse")}\``);
		expect(fullscreen).toContain(`\`${keyText("tui.altScreen.top")}\` / \`${keyText("tui.altScreen.bottom")}\``);
		expect(fullscreen).toContain("Search the transcript");
	});

	it("leaves the fullscreen keys out in regular mode, and a section whose rows all lack keys", () => {
		const table = hotkeysMarkdown({ key: () => "", fullscreen: false });
		expect(table).not.toContain("**Fullscreen**");
		expect(table).not.toContain("**Navigation**");
		// The text rows have no action to bind.
		expect(section(table, "Other")).toBe(
			"**Other**\n| Key | Action |\n|-----|--------|\n| `/` | Slash commands |\n| `!` | Run bash command |\n| `!!` | Run bash command (excluded from context) |",
		);
	});

	it("joins the keys of a shared row and drops only the unbound ones", () => {
		const keys: Partial<Record<Keybinding, string>> = { "tui.altScreen.lineDown": "ctrl+j" };
		const table = hotkeysMarkdown({ key: (action) => keys[action] ?? "", fullscreen: true });
		expect(section(table, "Fullscreen")).toContain("| `ctrl+j` | Scroll the transcript by line |");
	});
});

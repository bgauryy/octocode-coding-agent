import assert from "node:assert";
import { afterEach, describe, it } from "node:test";
import { Editor } from "../src/components/editor.ts";
import { KeybindingsManager, setKeybindings, TUI_KEYBINDINGS } from "../src/keybindings.ts";
import { setKittyProtocolActive } from "../src/keys/state.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { defaultEditorTheme } from "./test-themes.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

afterEach(() => {
	setKittyProtocolActive(false);
	setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
});

function run(sequence: string, kitty: boolean): { text: string; submitted: string[] } {
	setKittyProtocolActive(kitty);
	const editor = new Editor(new TuiMainScreen(new VirtualTerminal()), defaultEditorTheme);
	const submitted: string[] = [];
	editor.onSubmit = (text) => submitted.push(text);
	editor.handleInput("a");
	editor.handleInput(sequence);
	editor.handleInput("b");
	return { text: editor.getText(), submitted };
}

describe("Editor Shift+Enter", () => {
	const newlineCases: Array<[string, string, boolean]> = [
		["kitty CSI-u", "\x1b[13;2u", true],
		["kitty CSI-u with event type", "\x1b[13;2:1u", true],
		["kitty CSI-u without protocol flag", "\x1b[13;2u", false],
		["kitty keypad enter", "\x1b[57414;2u", true],
		["kitty with caps lock", "\x1b[13;66u", true],
		["kitty with num lock", "\x1b[13;130u", true],
		["kitty alternate-key form", "\x1b[13:13;2u", true],
		["modifyOtherKeys", "\x1b[27;2;13~", false],
		["linefeed (Ghostty/ctrl+j)", "\n", false],
		["linefeed with kitty", "\n", true],
		["escape+CR (VS Code/kitty mapping)", "\x1b\r", true],
		["escape+CR legacy (alt+enter)", "\x1b\r", false],
	];
	for (const [name, sequence, kitty] of newlineCases) {
		it(`inserts a newline for ${name}`, () => {
			const { text, submitted } = run(sequence, kitty);
			assert.strictEqual(text, "a\nb");
			assert.deepStrictEqual(submitted, []);
		});
	}

	it("still submits on plain Enter", () => {
		for (const kitty of [true, false]) {
			const { text, submitted } = run("\r", kitty);
			assert.deepStrictEqual(submitted, ["a"]);
			assert.strictEqual(text, "b");
		}
	});

	it("still submits on kitty-encoded plain Enter", () => {
		const { submitted } = run("\x1b[13u", true);
		assert.deepStrictEqual(submitted, ["a"]);
	});
});

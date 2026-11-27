import assert from "node:assert";
import { describe, it } from "node:test";
import { Editor } from "../src/components/editor.ts";
import { Input } from "../src/components/input.ts";
import type { TuiMouseEvent } from "../src/tui.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { defaultEditorTheme } from "./test-themes.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

function press(x: number): TuiMouseEvent {
	return {
		type: "press",
		button: "left",
		x,
		y: 0,
		screenX: x,
		screenY: 0,
		width: 40,
		height: 1,
		shift: false,
		alt: false,
		ctrl: false,
	};
}

function bigPaste(tag: string): string {
	return `\x1b[200~${Array.from({ length: 12 }, (_, i) => `${tag}${i}`).join("\n")}\x1b[201~`;
}

describe("Input click with a custom prompt", () => {
	it("places the cursor under the clicked character for any prompt width", () => {
		for (const prompt of ["", "> ", "name: ", "検索 "]) {
			const input = new Input({ prompt });
			input.setValue("hello");
			input.render(40);
			const promptWidth = prompt === "検索 " ? 5 : prompt.length;
			input.handleMouse(press(promptWidth + 2));
			input.handleInput("X");
			assert.strictEqual(input.getValue(), "heXllo", JSON.stringify(prompt));
		}
	});
});

describe("Editor backspace over a paste marker", () => {
	it("keeps the text after the marker when an earlier marker loses a digit", () => {
		const editor = new Editor(new TuiMainScreen(new VirtualTerminal(200, 24)), defaultEditorTheme);
		for (let i = 1; i <= 9; i++) {
			editor.handleInput(bigPaste(`p${i}-`));
			if (i === 3) editor.handleInput("Z");
		}
		editor.handleInput("\x01");
		editor.handleInput(bigPaste("p10-"));
		// Line: [paste #10][paste #1][paste #2][paste #3]Z[paste #4]...[paste #9]
		editor.handleInput("\x01");
		for (let i = 0; i < 4; i++) editor.handleInput("\x1b[C");
		editor.handleInput("\x7f");

		const text = editor.getText();
		assert.ok(
			text.startsWith("[paste #9 +12 lines][paste #1 +12 lines][paste #2 +12 lines]Z[paste #3 +12 lines]"),
			text,
		);
		assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 60 });
		editor.handleInput("Q");
		assert.ok(editor.getText().includes("[paste #2 +12 lines]QZ"), editor.getText());
		const expanded = editor.getExpandedText();
		assert.ok(expanded.startsWith("p10-0"), expanded.slice(0, 20));
		assert.ok(!expanded.includes("p3-0"), "the deleted paste is gone");
		assert.ok(expanded.includes("QZp4-0"), "the paste after Z expands from its renumbered marker");
	});
});

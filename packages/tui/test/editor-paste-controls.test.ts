import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Editor } from "../src/components/editor.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { defaultEditorTheme } from "./test-themes.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

function pasted(text: string): string {
	const editor = new Editor(new TuiMainScreen(new VirtualTerminal(40, 10)), defaultEditorTheme);
	editor.handleInput(`\x1b[200~${text}\x1b[201~`);
	return editor.getText();
}

describe("editor paste control characters", () => {
	it("drops a C1 control alone: the text around it stays, and the 8-bit CSI never reaches the screen", () => {
		assert.equal(pasted("a\u009bb"), "ab");
		assert.equal(pasted("a\u0085b\u009d"), "ab");
	});

	it("drops DEL and C0 controls but keeps newlines", () => {
		assert.equal(pasted("a\x7fb\x00c\nd"), "abc\nd");
	});
});

import assert from "node:assert";
import { describe, it } from "node:test";
import { Editor } from "../src/components/editor.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { visibleWidth } from "../src/utils/width.ts";
import { defaultEditorTheme } from "./test-themes.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

const RIGHT = "\x1b[C";
const END = "\x1b[F";
const ALT_RIGHT = "\x1bf";

function editorWith(text: string, suggestion: string): Editor {
	const editor = new Editor(new TuiMainScreen(new VirtualTerminal()), {
		...defaultEditorTheme,
		ghostText: (s) => `<${s}>`,
	});
	for (const ch of text) editor.handleInput(ch);
	editor.setInlineSuggestion(suggestion);
	return editor;
}

describe("Editor inline suggestion", () => {
	it("draws the untyped rest after the cursor", () => {
		const editor = editorWith("!git s", "!git status");
		const row = editor.render(40)[1];
		assert.ok(row.startsWith("!git s"), row);
		assert.ok(row.includes("<tatus>") || row.includes("<atus>"), row);
	});

	it("keeps showing while the typed text follows it, and hides otherwise", () => {
		const editor = editorWith("!git s", "!git status");
		editor.handleInput("t");
		assert.ok(editor.render(40)[1].includes("<tus>"));
		editor.handleInput("x");
		assert.ok(!editor.render(40)[1].includes("<"));
	});

	it("accepts the whole suggestion with Right or End, and undoes in one step", () => {
		for (const key of [RIGHT, END]) {
			const editor = editorWith("!npm r", "!npm run build");
			editor.handleInput(key);
			assert.strictEqual(editor.getText(), "!npm run build");
			editor.handleInput("\x1f"); // ctrl+- undo
			assert.strictEqual(editor.getText(), "!npm r");
		}
	});

	it("accepts the next word with word-right", () => {
		const editor = editorWith("!npm", "!npm run build");
		editor.handleInput(ALT_RIGHT);
		assert.strictEqual(editor.getText(), "!npm run ");
		editor.handleInput(ALT_RIGHT);
		assert.strictEqual(editor.getText(), "!npm run build");
	});

	it("does nothing when the cursor is not at the end, and setText clears it", () => {
		const editor = editorWith("!ls", "!ls -la");
		editor.handleInput("\x1b[D");
		editor.handleInput(RIGHT);
		assert.strictEqual(editor.getText(), "!ls");
		editor.setText("!l");
		assert.strictEqual(editor.getInlineSuggestion(), undefined);
	});

	it("clips the ghost to the row", () => {
		const editor = new Editor(new TuiMainScreen(new VirtualTerminal()), defaultEditorTheme);
		for (const ch of "!a") editor.handleInput(ch);
		editor.setInlineSuggestion(`!a${"b".repeat(200)}`);
		for (const row of editor.render(20)) assert.ok(visibleWidth(row) <= 20, row);
	});
});

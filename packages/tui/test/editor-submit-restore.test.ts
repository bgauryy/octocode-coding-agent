import assert from "node:assert";
import { describe, it } from "node:test";
import { Editor } from "../src/components/editor.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { defaultEditorTheme } from "./test-themes.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

const paste = (editor: Editor, text: string) => editor.handleInput(`\x1b[200~${text}\x1b[201~`);
const type = (editor: Editor, text: string) => {
	for (const char of text) editor.handleInput(char);
};
const UNDO = "\x1f";
const UP = "\x1b[A";

function createEditor() {
	const editor = new Editor(new TuiMainScreen(new VirtualTerminal(80, 24)), defaultEditorTheme);
	const submitted: string[] = [];
	editor.onSubmit = (text) => submitted.push(text);
	return { editor, submitted };
}

const big = Array.from({ length: 30 }, (_, i) => `row ${i}`).join("\n");

describe("restoring a refused submit", () => {
	it("puts back the draft with its paste marker, whitespace, cursor and undo", () => {
		const { editor, submitted } = createEditor();
		const { editor: reference } = createEditor();
		for (const target of [editor, reference]) {
			type(target, "  see ");
			paste(target, big);
			type(target, " now  ");
			target.handleInput("\x1b[D"); // cursor one to the left
		}
		const before = { text: editor.getText(), cursor: editor.getCursor(), expanded: editor.getExpandedText() };
		editor.handleInput("\r");
		assert.strictEqual(submitted[0], `see ${big} now`);
		assert.strictEqual(editor.getText(), "");

		editor.restoreSubmitted(submitted[0]);
		assert.strictEqual(editor.getText(), before.text);
		assert.strictEqual(editor.getText(), "  see [paste #1 +30 lines] now  ");
		assert.deepStrictEqual(editor.getCursor(), before.cursor);
		assert.strictEqual(editor.getExpandedText(), before.expanded);
		// Submitting again sends the same text.
		editor.handleInput("\r");
		assert.strictEqual(submitted[1], submitted[0]);
		editor.restoreSubmitted(submitted[1]);
		// Undo walks back through the same steps as a draft that was never submitted.
		const trail = (target: Editor) => {
			const texts = [target.getText()];
			for (let i = 0; i < 20; i++) {
				target.handleInput(UNDO);
				texts.push(target.getText());
			}
			return texts;
		};
		assert.deepStrictEqual(trail(editor), trail(reference));
	});

	it("falls back to the text when it is not what the editor sent, or the editor was edited since", () => {
		const { editor, submitted } = createEditor();
		paste(editor, big);
		editor.handleInput("\r");
		editor.restoreSubmitted("something else");
		assert.strictEqual(editor.getText(), "something else");

		editor.setText("");
		paste(editor, big);
		editor.handleInput("\r");
		type(editor, "typed");
		editor.restoreSubmitted(submitted[1]);
		assert.strictEqual(editor.getText(), big);
	});
});

describe("prompt history with pastes", () => {
	it("recalls a submitted paste as its marker and submits the same text", () => {
		const { editor, submitted } = createEditor();
		type(editor, "fix ");
		paste(editor, `${big}\n\n`);
		editor.handleInput("\r");
		editor.addToHistory(submitted[0]);
		type(editor, "draft ");
		paste(editor, "x".repeat(1500));

		editor.handleInput(UP);
		editor.handleInput(UP);
		// 30 rows and one blank line: the newline that ends the paste starts no line of its own.
		assert.strictEqual(editor.getText(), "fix [paste #1 +31 lines]");
		editor.handleInput("\r");
		assert.strictEqual(submitted[1], submitted[0]);

		// Going back down restores the draft and its own paste.
		editor.addToHistory(submitted[1]);
		type(editor, "z");
		assert.strictEqual(editor.getText(), "z");
	});

	it("returns from browsing to the draft with its paste intact", () => {
		const { editor, submitted } = createEditor();
		type(editor, "first");
		editor.handleInput("\r");
		editor.addToHistory(submitted[0]);
		paste(editor, big);
		editor.handleInput(UP); // to the start of the line
		editor.handleInput(UP);
		assert.strictEqual(editor.getText(), "first");
		editor.handleInput("\x1b[B");
		assert.strictEqual(editor.getText(), "[paste #1 +30 lines]");
		assert.strictEqual(editor.getExpandedText(), big);
	});

	it("keeps one entry for the same text and shows a large prompt from elsewhere as one marker", () => {
		const { editor, submitted } = createEditor();
		editor.addToHistory(big);
		editor.addToHistory(big);
		editor.handleInput(UP);
		assert.strictEqual(editor.getText(), "[paste #1 +30 lines]");
		editor.handleInput(UP);
		assert.strictEqual(editor.getText(), "[paste #1 +30 lines]");
		editor.handleInput("\r");
		assert.strictEqual(submitted[0], big);
	});

	it("keeps a long typed prompt as text", () => {
		const { editor, submitted } = createEditor();
		const long = "word ".repeat(300).trim();
		type(editor, long);
		editor.handleInput("\r");
		editor.addToHistory(submitted[0]);
		editor.handleInput(UP);
		assert.strictEqual(editor.getText(), long);
	});
});

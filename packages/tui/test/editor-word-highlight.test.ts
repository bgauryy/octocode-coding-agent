import assert from "node:assert";
import { describe, it } from "node:test";
import { Editor } from "../src/components/editor.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { visibleWidth } from "../src/utils/width.ts";
import { defaultEditorTheme } from "./test-themes.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

const known = new Set(["research"]);
function editorWith(text: string): Editor {
	const editor = new Editor(new TuiMainScreen(new VirtualTerminal()), defaultEditorTheme);
	editor.wordHighlight = {
		find: (line) =>
			[...line.matchAll(/\p{L}+/gu)]
				.filter((m) => known.has(m[0]))
				.map((m) => ({ start: m.index, end: m.index + m[0].length })),
		style: (s) => `<${s}>`,
	};
	for (const ch of text) editor.handleInput(ch);
	return editor;
}
const rows = (editor: Editor, width = 40) => editor.render(width).slice(1, -1).join("\n");

describe("Editor word highlight", () => {
	it("styles a known word, not an unknown or partial one", () => {
		assert.ok(rows(editorWith("do research now")).includes("do <research> now"));
		assert.ok(!rows(editorWith("do researc now")).includes("<"));
		assert.ok(!rows(editorWith("do foo now")).includes("<"));
	});

	it("follows edits and deletes", () => {
		const editor = editorWith("research");
		assert.ok(rows(editor).includes("<research>"));
		editor.handleInput("\x7f");
		assert.ok(!rows(editor).includes("<"));
		editor.handleInput("h");
		assert.ok(rows(editor).includes("<research>"));
	});

	it("keeps the cursor cell unstyled and its position", () => {
		const editor = editorWith("research x");
		for (let i = 0; i < 4; i++) editor.handleInput("\x1b[D");
		const row = rows(editor);
		assert.ok(row.includes("<resea>") || row.includes("<resear"), row);
		assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 6 });
	});

	it("leaves wide characters and wrapping alone", () => {
		const plain = editorWith("研究 research 日本語 research tail");
		const styled = rows(plain, 12);
		const stripped = styled.replace(/[<>]/g, "");
		const bare = new Editor(new TuiMainScreen(new VirtualTerminal()), defaultEditorTheme);
		for (const ch of "研究 research 日本語 research tail") bare.handleInput(ch);
		assert.strictEqual(stripped, rows(bare, 12));
		for (const line of styled.split("\n")) assert.ok(visibleWidth(line.replace(/[<>]/g, "")) <= 12);
	});
});

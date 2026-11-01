import assert from "node:assert";
import { describe, it } from "node:test";
import { Editor } from "../src/components/editor.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { defaultEditorTheme } from "./test-themes.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

/** An editor whose own top border names itself, as a subclass overriding it would. */
class LabelledEditor extends Editor {
	protected override renderTopBorder(width: number, hiddenLineCount: number): string {
		return `own-top ${width} ${hiddenLineCount}`;
	}
}

describe("Editor border decorator", () => {
	it("draws both border rows through the decorator, which can fall back to the editor's own", () => {
		const editor = new LabelledEditor(new TuiMainScreen(new VirtualTerminal()), defaultEditorTheme);
		editor.setText("one\ntwo");
		const calls: string[] = [];
		editor.borderDecorator = (edge, width, hidden, standard) => {
			calls.push(`${edge} ${width} ${hidden}`);
			return edge === "top" ? `[${standard()}]` : "bottom!";
		};
		const lines = editor.render(20);
		assert.deepStrictEqual(calls, ["top 20 0", "bottom 20 0"]);
		assert.strictEqual(lines[0], "[own-top 20 0]");
		assert.strictEqual(editor.visibleLineCount, 2);
		assert.strictEqual(lines[editor.visibleLineCount + 1], "bottom!");

		editor.borderDecorator = undefined;
		assert.strictEqual(editor.render(20)[0], "own-top 20 0");
	});
});

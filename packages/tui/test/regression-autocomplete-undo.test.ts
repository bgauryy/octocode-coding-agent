import assert from "node:assert";
import { describe, it } from "node:test";
import { Editor } from "../src/components/editor.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { defaultEditorTheme } from "./test-themes.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

function createEditor(): Editor {
	return new Editor(new TuiMainScreen(new VirtualTerminal(80, 24)), defaultEditorTheme);
}

async function settle(): Promise<void> {
	for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
}

describe("Editor autocomplete after a provider failure", () => {
	it("keeps serving later requests and leaves no unhandled rejection", async () => {
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => unhandled.push(reason);
		process.on("unhandledRejection", onUnhandled);
		try {
			const editor = createEditor();
			let calls = 0;
			editor.setAutocompleteProvider({
				async getSuggestions(lines, _line, col) {
					calls++;
					if (calls === 1) throw new Error("provider failed once");
					return { items: [{ value: "help", label: "help" }], prefix: (lines[0] ?? "").slice(0, col) };
				},
				applyCompletion: (lines, cursorLine, cursorCol) => ({ lines, cursorLine, cursorCol }),
			});

			editor.handleInput("/");
			await settle();
			assert.strictEqual(editor.isShowingAutocomplete(), false, "a failed request shows no list");

			editor.handleInput("\x7f");
			editor.handleInput("/");
			await settle();
			assert.strictEqual(calls, 2, "the next request reaches the provider");
			assert.strictEqual(editor.isShowingAutocomplete(), true);
			assert.deepStrictEqual(unhandled, []);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});
});

describe("Editor undo with a large paste", () => {
	it("does not copy the paste content into every undo step", () => {
		const editor = createEditor();
		const paste = "x".repeat(5_000_000);
		editor.handleInput(`\x1b[200~${paste}\x1b[201~`);
		const before = process.memoryUsage().heapUsed;
		for (let i = 0; i < 100; i++) {
			editor.handleInput("a");
			editor.handleInput(" ");
		}
		const growthMb = (process.memoryUsage().heapUsed - before) / 1e6;
		// Before the fix every snapshot held its own 5 MB copy: about 500 MB for these 200 keys.
		assert.ok(growthMb < 100, `heap grew ${growthMb.toFixed(0)} MB`);
	});

	it("restores text and paste content step by step", () => {
		const editor = createEditor();
		const paste = "y".repeat(2000);
		editor.handleInput(`\x1b[200~${paste}\x1b[201~`);
		const marker = editor.getText();
		editor.handleInput(" ");
		editor.handleInput("b");
		assert.strictEqual(editor.getExpandedText(), `${paste} b`);
		editor.handleInput("\x1f"); // ctrl+- undo
		assert.strictEqual(editor.getText(), marker);
		assert.strictEqual(editor.getExpandedText(), paste);
		editor.handleInput("\x1f");
		assert.strictEqual(editor.getText(), "");
		editor.handleInput("\x1f");
		assert.strictEqual(editor.getText(), "");
	});
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AutocompleteSuggestions } from "../src/autocomplete/types.ts";
import { Editor } from "../src/components/editor.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { defaultEditorTheme } from "./test-themes.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

async function settle(): Promise<void> {
	for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
}

describe("autocomplete cancellation", () => {
	for (const lateFailure of [false, true]) {
		it(`serves a replacement request before an aborted provider ${lateFailure ? "rejects" : "resolves"}`, async () => {
			const tui = new TuiMainScreen(new VirtualTerminal(80, 24));
			const editor = new Editor(tui, defaultEditorTheme);
			let finish!: (value: AutocompleteSuggestions | null) => void;
			let fail!: (error: Error) => void;
			let calls = 0;
			let firstSignal: AbortSignal | undefined;
			const first = new Promise<AutocompleteSuggestions | null>((resolve, reject) => {
				finish = resolve;
				fail = reject;
			});
			editor.setAutocompleteProvider({
				getSuggestions: async (_lines, _line, _col, options) => {
					if (++calls === 1) {
						firstSignal = options.signal;
						return first;
					}
					return { prefix: "/", items: [{ value: "/help", label: "help" }] };
				},
				applyCompletion: (lines, cursorLine, cursorCol) => ({ lines, cursorLine, cursorCol }),
			});
			try {
				editor.handleInput("/");
				await settle();
				assert.equal(calls, 1);
				editor.handleInput("\x7f");
				editor.handleInput("/");
				await settle();
				assert.equal(firstSignal?.aborted, true);
				assert.equal(calls, 2, "an aborted request must release the request queue");
				assert.equal(editor.isShowingAutocomplete(), true);
				if (lateFailure) fail(new Error("late provider failure"));
				else finish({ prefix: "/", items: [{ value: "/stale", label: "stale" }] });
				await settle();
				const output = editor.render(80).join("\n");
				assert.ok(output.includes("help"));
				assert.ok(!output.includes("stale"));
			} finally {
				finish(null);
				editor.setAutocompleteProvider({
					getSuggestions: async () => null,
					applyCompletion: (lines, cursorLine, cursorCol) => ({ lines, cursorLine, cursorCol }),
				});
				tui.stop();
				await settle();
			}
		});
	}
});

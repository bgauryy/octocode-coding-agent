import assert from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { CombinedAutocompleteProvider } from "../src/autocomplete.ts";
import { resetFileIndexCache } from "../src/autocomplete/file-index.ts";
import type { AutocompleteProvider } from "../src/autocomplete/types.ts";
import { Editor } from "../src/components/editor.ts";
import { SelectList } from "../src/components/select-list.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { stripTerminalSequences } from "../src/utils.ts";
import { defaultEditorTheme } from "./test-themes.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

const ESC = "\x1b";
const settle = (ms = 80) => new Promise((resolve) => setTimeout(resolve, ms));

describe("@ file picker keys and rows", () => {
	let dir: string;
	let editor: Editor;
	let submitted: string[];

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "at-picker-"));
		resetFileIndexCache();
		for (const file of ["src/alpha.ts", "src/beta.ts", "src/deep/gamma.ts", "README.md"]) {
			mkdirSync(dirname(join(dir, file)), { recursive: true });
			writeFileSync(join(dir, file), "x");
		}
		submitted = [];
		editor = new Editor(new TuiMainScreen(new VirtualTerminal(80, 24)), defaultEditorTheme);
		editor.setAutocompleteProvider(new CombinedAutocompleteProvider([], dir));
		editor.onSubmit = (text) => submitted.push(text);
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
		resetFileIndexCache();
	});

	/** Lets the request finish: the first index build is a subprocess, slower under a loaded suite. */
	const idle = async () => {
		for (let waited = 0; waited < 3000 && editor.hasPendingAutocomplete(); waited += 20) await settle(20);
	};
	const type = async (text: string) => {
		for (const char of text) editor.handleInput(char);
		await settle();
		await idle();
	};
	const rendered = () => stripTerminalSequences(editor.render(80).join("\n"));

	it("Esc closes the list and keeps the text; the next letter does not reopen it", async () => {
		await type("@src");
		assert.ok(editor.isShowingAutocomplete());
		editor.handleInput(ESC);
		assert.strictEqual(editor.isShowingAutocomplete(), false);
		assert.strictEqual(editor.getText(), "@src");
		await type("/");
		await type("a");
		assert.strictEqual(editor.getText(), "@src/a");
		assert.strictEqual(editor.isShowingAutocomplete(), false);
	});

	it("a new @ reopens a dismissed list", async () => {
		await type("@src");
		editor.handleInput(ESC);
		await type(" @al");
		assert.ok(editor.isShowingAutocomplete());
	});

	it("Tab reopens a dismissed list", async () => {
		await type("@alp");
		editor.handleInput(ESC);
		await type("h");
		assert.strictEqual(editor.isShowingAutocomplete(), false);
		editor.handleInput("\t");
		await settle();
		assert.ok(editor.isShowingAutocomplete() || editor.getText() === "@src/alpha.ts ");
	});

	it("leaving the token ends the dismissal", async () => {
		await type("@src");
		editor.handleInput(ESC);
		await type(" ");
		await type("@x");
		editor.handleInput(ESC);
		await type(" ab @be");
		assert.ok(editor.isShowingAutocomplete());
	});

	it("Tab on a directory drills in and lists its children", async () => {
		await type("@sr");
		assert.ok(rendered().includes("src/"));
		editor.handleInput("\t");
		await settle();
		assert.strictEqual(editor.getText(), "@src/");
		assert.ok(editor.isShowingAutocomplete());
		assert.ok(rendered().includes("alpha.ts"));
	});

	it("Right on a directory drills in", async () => {
		await type("@sr");
		editor.handleInput("\x1b[C");
		await settle();
		assert.strictEqual(editor.getText(), "@src/");
		assert.ok(rendered().includes("beta.ts"));
	});

	it("Enter inserts the selected file and never submits", async () => {
		await type("@alph");
		editor.handleInput("\r");
		assert.deepStrictEqual(submitted, []);
		assert.strictEqual(editor.getText(), "@src/alpha.ts ");
	});

	it("shows a no-match row instead of closing, and keeps typed text", async () => {
		await type("@zzzqq");
		assert.ok(editor.isShowingAutocomplete());
		assert.ok(rendered().includes('No files match "zzzqq"'));
		assert.strictEqual(editor.getText(), "@zzzqq");
	});

	it("shows the key hint row: actions only, in the lowercase key format", async () => {
		await type("@src");
		assert.ok(rendered().includes("tab/enter insert · esc close"));
		assert.ok(!rendered().includes("↑↓"));
	});

	it("Ctrl+N and Ctrl+P move the selection", async () => {
		await type("@src/");
		editor.handleInput("\x0e");
		editor.handleInput("\r");
		const second = editor.getText();
		await type(" @src/");
		editor.handleInput("\x0e");
		editor.handleInput("\x10");
		editor.handleInput("\r");
		assert.ok(second.startsWith("@src/"));
		assert.notStrictEqual(editor.getText().split(" ")[1], second.trim());
	});

	it("Esc during a pending request cancels it, keeps text and does not reach the interrupt path", async () => {
		let release: (() => void) | undefined;
		let aborted = false;
		const provider: AutocompleteProvider = {
			async getSuggestions(_l, _c, _o, options) {
				options.signal.addEventListener("abort", () => {
					aborted = true;
				});
				await new Promise<void>((resolve) => {
					release = resolve;
				});
				return null;
			},
			applyCompletion: (lines, cursorLine, cursorCol) => ({ lines, cursorLine, cursorCol }),
		};
		editor.setAutocompleteProvider(provider);
		await type("@a");
		assert.ok(editor.hasPendingAutocomplete());
		editor.handleInput(ESC);
		assert.strictEqual(editor.hasPendingAutocomplete(), false);
		assert.ok(aborted);
		assert.strictEqual(editor.getText(), "@a");
		release?.();
		await settle();
		assert.strictEqual(editor.isShowingAutocomplete(), false);
	});

	it("shows indexing progress while the provider reports it", async () => {
		let status: string | null = "Indexing… 12 345 files";
		let release: (() => void) | undefined;
		editor.setAutocompleteProvider({
			indexingStatus: () => status,
			async getSuggestions() {
				await new Promise<void>((resolve) => {
					release = resolve;
				});
				return null;
			},
			applyCompletion: (lines, cursorLine, cursorCol) => ({ lines, cursorLine, cursorCol }),
		});
		await type("@a");
		assert.ok(rendered().includes("Indexing… 12 345 files"));
		editor.handleInput("\r");
		assert.deepStrictEqual(submitted, []);
		status = null;
		release?.();
		await settle();
		assert.ok(rendered().includes('No files match "a"'));
	});
});

describe("SelectList path rows", () => {
	const theme = {
		selectedText: (t: string) => `<S>${t}</S>`,
		description: (t: string) => `<D>${t}</D>`,
		scrollInfo: (t: string) => t,
		noMatch: (t: string) => t,
		matchHighlight: (t: string) => `<M>${t}</M>`,
		directory: (t: string) => `<Dir>${t}</Dir>`,
	};

	it("highlights matched basename characters and dims the parent path", () => {
		const list = new SelectList(
			[
				{ value: "a", label: "alpha.ts", description: "src/alpha.ts", kind: "file", matches: [0, 1] },
				{ value: "b", label: "beta.ts", description: "src/beta.ts", kind: "file", matches: [0, 1] },
				{ value: "c", label: "deep/", description: "src/deep", kind: "directory", matches: [0] },
			],
			5,
			theme,
		);
		const [first, second, third] = list.render(60);
		// The selected row keeps the selected colour and bolds the match.
		assert.ok(first.includes("\x1b[1mal\x1b[22mpha.ts"));
		assert.ok(second.includes("<M>be</M>ta.ts"));
		assert.ok(second.includes("<D>  src/</D>"));
		assert.ok(third.includes("<M>d</M>") && third.includes("<Dir>eep/</Dir>"));
	});

	it("shows per-list empty text and a hint beside the scroll info", () => {
		const empty = new SelectList([], 5, theme, {}, { emptyText: 'No files match "q"' });
		assert.deepStrictEqual(empty.render(40), ['  No files match "q"']);
		const items = Array.from({ length: 8 }, (_, i) => ({ value: `${i}`, label: `f${i}`, kind: "file" as const }));
		const hinted = new SelectList(items, 3, theme, {}, { hint: "Esc close" });
		assert.ok(hinted.render(60).at(-1)?.includes("Esc close"));
		assert.ok(!hinted.render(10).at(-1)?.includes("Esc close"));
	});
});

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { setKeybindings, TuiMainScreen } from "@octocodeai/octocode-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultEditorTheme } from "../../tui/test/test-themes.ts";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { CustomEditor } from "../src/modes/interactive/components/custom-editor.ts";
import { rewritePastedImagePaths } from "../src/modes/interactive/interactive-mode/paste-image-paths.ts";

const PASTE = (text: string) => `\x1b[200~${text}\x1b[201~`;

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "paste-image-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
	setKeybindings(new KeybindingsManager());
});

function file(...parts: string[]): string {
	const path = join(dir, ...parts);
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, "x");
	return path;
}

function setup(input: string[] = ["text", "image"]) {
	const keybindings = new KeybindingsManager();
	setKeybindings(keybindings);
	const editor = new CustomEditor(new TuiMainScreen(new VirtualTerminal()), defaultEditorTheme, keybindings);
	const showWarning = vi.fn<(message: string) => void>();
	const showStatus = vi.fn<(message: string) => void>();
	const host = { session: { model: { input }, sessionManager: { getCwd: () => dir } }, showWarning, showStatus };
	editor.onPasteText = (text) => rewritePastedImagePaths(host as never, text);
	return { editor, showWarning, showStatus };
}

describe("pasting image paths", () => {
	it("a plain image path is inserted as that path", () => {
		const png = file("shot.png");
		const { editor, showWarning, showStatus } = setup();
		editor.handleInput(PASTE(png));
		expect(editor.getText()).toBe(png);
		expect(showWarning).not.toHaveBeenCalled();
		expect(showStatus).toHaveBeenCalledExactlyOnceWith("1 image attaches when you send.");
	});

	it("backslash-escaped spaces become one quoted path", () => {
		const png = file("My Photos", "a b.PNG");
		const { editor } = setup();
		editor.handleInput(PASTE(png.replace(/ /g, "\\ ")));
		expect(editor.getText()).toBe(`'${png}'`);
	});

	it("a quoted path with spaces becomes one quoted path", () => {
		const jpg = file("My Photos", "a b.jpg");
		const { editor } = setup();
		editor.handleInput(PASTE(`"${jpg}"`));
		expect(editor.getText()).toBe(`'${jpg}'`);
	});

	it("a file:// URL becomes its path", () => {
		const webp = file("My Photos", "c.webp");
		const { editor } = setup();
		editor.handleInput(PASTE(pathToFileURL(webp).href));
		expect(editor.getText()).toBe(`'${webp}'`);
	});

	it("several files each become a path and one status line counts them", () => {
		const a = file("a.png");
		const b = file("b dir", "b.gif");
		const { editor, showStatus, showWarning } = setup();
		editor.handleInput(PASTE(`${a} ${b.replace(/ /g, "\\ ")}`));
		expect(editor.getText()).toBe(`${a} '${b}'`);
		expect(showStatus).toHaveBeenCalledExactlyOnceWith("2 images attach when you send.");
		expect(showWarning).not.toHaveBeenCalled();
	});

	it("a non-image path stays text unchanged", () => {
		const txt = file("notes.txt");
		const { editor, showWarning, showStatus } = setup();
		editor.handleInput(PASTE(txt));
		expect(editor.getText()).toBe(txt);
		expect(showWarning).not.toHaveBeenCalled();
		expect(showStatus).not.toHaveBeenCalled();
	});

	it("a missing image file stays text unchanged", () => {
		const missing = join(dir, "gone.png");
		const { editor } = setup();
		editor.handleInput(PASTE(missing.replace(/ /g, "\\ ")));
		expect(editor.getText()).toBe(missing);
	});

	it("one non-image among images leaves the whole paste unchanged", () => {
		const a = file("a.png");
		const { editor } = setup();
		const text = `${a} ${join(dir, "nope.txt")}`;
		editor.handleInput(PASTE(text));
		expect(editor.getText()).toBe(text);
	});

	it("a model without image input keeps the path text and shows one hint", () => {
		const png = file("My Photos", "a b.png");
		const { editor, showWarning, showStatus } = setup(["text"]);
		const pasted = png.replace(/ /g, "\\ ");
		editor.handleInput(PASTE(pasted));
		expect(editor.getText()).toBe(pasted);
		expect(showWarning).toHaveBeenCalledExactlyOnceWith("This model cannot take images: the pasted path stays text.");
		expect(showStatus).not.toHaveBeenCalled();
	});
});

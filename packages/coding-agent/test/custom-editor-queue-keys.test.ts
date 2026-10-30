import { setKeybindings, TuiMainScreen } from "@octocodeai/octocode-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultEditorTheme } from "../../tui/test/test-themes.ts";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { CustomEditor } from "../src/modes/interactive/components/custom-editor.ts";

const UP = "\x1b[A";
const ALT_UP = "\x1b[1;3A";

afterEach(() => {
	setKeybindings(new KeybindingsManager());
});

function createEditor() {
	const keybindings = new KeybindingsManager();
	setKeybindings(keybindings);
	const editor = new CustomEditor(new TuiMainScreen(new VirtualTerminal()), defaultEditorTheme, keybindings);
	const dequeue = vi.fn();
	editor.onAction("app.message.dequeue", dequeue);
	return { editor, dequeue };
}

describe("Up arrow and queued messages", () => {
	it("Up in a multi-line draft moves the cursor and never recalls a queued message", () => {
		const { editor, dequeue } = createEditor();
		editor.setText("first line\nsecond line");
		editor.handleInput(UP);
		expect(editor.getText()).toBe("first line\nsecond line");
		expect(editor.getCursor().line).toBe(0);
		expect(dequeue).not.toHaveBeenCalled();
	});

	it("Up on an empty editor recalls prompt history, not the queue", () => {
		const { editor, dequeue } = createEditor();
		editor.addToHistory("previous prompt");
		editor.handleInput(UP);
		expect(editor.getText()).toBe("previous prompt");
		expect(dequeue).not.toHaveBeenCalled();
	});

	it("the dequeue key runs the dequeue action instead of moving the cursor or browsing history", () => {
		const { editor, dequeue } = createEditor();
		editor.addToHistory("previous prompt");
		editor.handleInput(ALT_UP);
		expect(dequeue).toHaveBeenCalledOnce();
		expect(editor.getText()).toBe("");
	});

	it("Up on an empty editor opens the queue list when the hook takes it", () => {
		const { editor } = createEditor();
		editor.addToHistory("previous prompt");
		const onEmptyUp = vi.fn(() => true);
		editor.onEmptyUp = onEmptyUp;
		editor.handleInput(UP);
		expect(onEmptyUp).toHaveBeenCalledOnce();
		expect(editor.getText()).toBe("");
	});

	it("Up browses history when the queue is empty (the hook declines)", () => {
		const { editor } = createEditor();
		editor.addToHistory("previous prompt");
		editor.onEmptyUp = vi.fn(() => false);
		editor.handleInput(UP);
		expect(editor.getText()).toBe("previous prompt");
	});

	it("Up with any draft never asks for the queue list", () => {
		const { editor } = createEditor();
		const onEmptyUp = vi.fn(() => true);
		editor.onEmptyUp = onEmptyUp;
		editor.setText("draft");
		editor.handleInput(UP);
		editor.setText(" ");
		editor.handleInput(UP);
		expect(onEmptyUp).not.toHaveBeenCalled();
	});
});

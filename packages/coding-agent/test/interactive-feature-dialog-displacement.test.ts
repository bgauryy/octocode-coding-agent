import { beforeAll, describe, expect, test, vi } from "vitest";
import { Container, type TUI } from "../../tui/src/tui.ts";
import { TuiMainScreen } from "../../tui/src/tui-main-screen.ts";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { CustomEditor } from "../src/theme/custom-editor.ts";
import * as extensionDialogs from "../src/modes/interactive/interactive-mode/dialogs.ts";
import type { DialogSelectorComponent } from "../src/modes/interactive/components/dialog-selector.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { getEditorTheme, initTheme } from "../src/theme/theme.ts";
import { createUiStore } from "../src/modes/interactive/state/store.ts";
import { createFakeHost } from "./interactive-mode-host.ts";

const PENDING = Symbol("pending");

/** The promise's value, or PENDING when it has not settled after the microtask queue drained. */
async function settled<T>(promise: Promise<T>): Promise<T | typeof PENDING> {
	return Promise.race([promise, new Promise<typeof PENDING>((resolve) => setTimeout(() => resolve(PENDING), 20))]);
}

/** Type `text` into the open extension input and press Enter. */
function submitInput(host: { inputDialog?: { handleInput(data: string): void } }, text: string): void {
	for (const char of text) host.inputDialog?.handleInput(char);
	host.inputDialog?.handleInput("\r");
}

function createDialogHost() {
	const ui: TUI = new TuiMainScreen(new VirtualTerminal(80, 24));
	const keybindings = KeybindingsManager.create();
	const editor = new CustomEditor(ui, getEditorTheme(), keybindings);
	const editorContainer = new Container();
	editorContainer.addChild(editor);
	const setBlocked = vi.fn();
	const host = createFakeHost({
		ui,
		editor,
		editorContainer,
		keybindings,
		programStatus: { setBlocked },
		settingsManager: { getExternalEditorCommand: () => undefined },
		uiStore: createUiStore(),
		selectorDialog: undefined,
		inputDialog: undefined,
		editorDialog: undefined,
		disposeActiveSelector: vi.fn(),
		toggleToolOutputExpansion: vi.fn(),
	});
	return { host, editor, editorContainer, setBlocked };
}

describe("extension dialogs share one editor slot", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	test("the blocked status is a question unless the caller reports a permission", () => {
		const { host, setBlocked } = createDialogHost();
		void extensionDialogs.showSelectorDialog(host, "Pick", ["A"]);
		expect(setBlocked).toHaveBeenLastCalledWith("feature-dialog", expect.objectContaining({ kind: "question" }));
		void extensionDialogs.showSelectorDialog(host, "Run bash?", ["Allow once"], undefined, {
			kind: "permission",
			message: "Run bash?",
		});
		expect(setBlocked).toHaveBeenLastCalledWith("feature-dialog", expect.objectContaining({ kind: "permission" }));
		void extensionDialogs.showConfirmDialog(host, "Sure?", "msg");
		expect(setBlocked).toHaveBeenLastCalledWith("feature-dialog", expect.objectContaining({ kind: "question" }));
	});

	test("a confirmation is the ask card approvals use: question, quoted message, numbered No then Yes", async () => {
		const { host } = createDialogHost();
		const answer = extensionDialogs.showConfirmDialog(host, "Allow paid judging?", "Costs at most $0.05.");
		// The fake host declares the slot empty; the dialog fills it.
		const selector = host.selectorDialog as unknown as DialogSelectorComponent;
		const shown = selector
			.render(80)
			.join("\n")
			.replace(/\x1b\[[0-9;]*m/g, "");
		expect(shown).toContain("Allow paid judging?");
		expect(shown).toContain("│ Costs at most $0.05.");
		expect(shown).toMatch(/› 1\. No[\s\S]*2\. Yes/);
		expect(shown).toContain("1-2 pick · enter confirm");
		expect(shown).not.toContain("choose");
		selector.handleInput("2");
		selector.handleInput("\r");
		expect(await settled(answer)).toBe(true);
	});

	test("a dialog displaced by another one answers undefined instead of waiting forever", async () => {
		const { host, editorContainer } = createDialogHost();
		const first = extensionDialogs.showSelectorDialog(host, "First", ["A", "B"]);
		const second = extensionDialogs.showInputDialog(host, "Second");

		expect(await settled(first)).toBeUndefined();
		expect(editorContainer.children).toEqual([host.inputDialog]);
		expect(await settled(second)).toBe(PENDING);

		submitInput(host, "typed");
		expect(await settled(second)).toBe("typed");
	});

	test("hiding the open dialog from outside, as resetFeatureUI does on reload or session replacement, answers it", async () => {
		const { host, editor, editorContainer, setBlocked } = createDialogHost();
		const selector = extensionDialogs.showSelectorDialog(host, "Pick", ["A"]);
		const confirm = extensionDialogs.showConfirmDialog(host, "Replace", "Continue?");
		expect(await settled(selector)).toBeUndefined();

		host.hideSelectorDialog();
		expect(await settled(confirm)).toBe(false);
		expect(editorContainer.children).toEqual([editor]);
		expect(setBlocked).toHaveBeenLastCalledWith("feature-dialog", undefined);

		const text = extensionDialogs.showEditorDialog(host, "Edit", "draft");
		host.hideEditorDialog();
		expect(await settled(text)).toBeUndefined();
	});

	test("a dialog answered normally does not cancel the next one", async () => {
		const { host } = createDialogHost();
		const first = extensionDialogs.showInputDialog(host, "First");
		submitInput(host, "one");
		expect(await settled(first)).toBe("one");

		const second = extensionDialogs.showInputDialog(host, "Second");
		expect(await settled(second)).toBe(PENDING);
		submitInput(host, "two");
		expect(await settled(second)).toBe("two");
	});
});

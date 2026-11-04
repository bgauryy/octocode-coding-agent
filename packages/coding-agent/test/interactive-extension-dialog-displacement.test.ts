import { beforeAll, describe, expect, test, vi } from "vitest";
import { Container, type TUI } from "../../tui/src/tui.ts";
import { TuiMainScreen } from "../../tui/src/tui-main-screen.ts";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { CustomEditor } from "../src/modes/interactive/components/custom-editor.ts";
import * as extensionDialogs from "../src/modes/interactive/interactive-mode/extension-dialogs.ts";
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
function submitInput(host: { extensionInput?: { handleInput(data: string): void } }, text: string): void {
	for (const char of text) host.extensionInput?.handleInput(char);
	host.extensionInput?.handleInput("\r");
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
		extensionSelector: undefined,
		extensionInput: undefined,
		extensionEditor: undefined,
		disposeActiveSelector: vi.fn(),
		toggleToolOutputExpansion: vi.fn(),
	});
	return { host, editor, editorContainer, setBlocked };
}

describe("extension dialogs share one editor slot", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	test("a dialog displaced by another one answers undefined instead of waiting forever", async () => {
		const { host, editorContainer } = createDialogHost();
		const first = extensionDialogs.showExtensionSelector(host, "First", ["A", "B"]);
		const second = extensionDialogs.showExtensionInput(host, "Second");

		expect(await settled(first)).toBeUndefined();
		expect(editorContainer.children).toEqual([host.extensionInput]);
		expect(await settled(second)).toBe(PENDING);

		submitInput(host, "typed");
		expect(await settled(second)).toBe("typed");
	});

	test("hiding the open dialog from outside, as resetExtensionUI does on reload or session replacement, answers it", async () => {
		const { host, editor, editorContainer, setBlocked } = createDialogHost();
		const selector = extensionDialogs.showExtensionSelector(host, "Pick", ["A"]);
		const confirm = extensionDialogs.showExtensionConfirm(host, "Replace", "Continue?");
		expect(await settled(selector)).toBeUndefined();

		host.hideExtensionSelector();
		expect(await settled(confirm)).toBe(false);
		expect(editorContainer.children).toEqual([editor]);
		expect(setBlocked).toHaveBeenLastCalledWith("extension-dialog", undefined);

		const text = extensionDialogs.showExtensionEditor(host, "Edit", "draft");
		host.hideExtensionEditor();
		expect(await settled(text)).toBeUndefined();
	});

	test("a dialog answered normally does not cancel the next one", async () => {
		const { host } = createDialogHost();
		const first = extensionDialogs.showExtensionInput(host, "First");
		submitInput(host, "one");
		expect(await settled(first)).toBe("one");

		const second = extensionDialogs.showExtensionInput(host, "Second");
		expect(await settled(second)).toBe(PENDING);
		submitInput(host, "two");
		expect(await settled(second)).toBe("two");
	});
});

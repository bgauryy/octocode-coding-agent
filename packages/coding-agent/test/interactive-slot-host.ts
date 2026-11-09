/**
 * A real main-screen renderer on a virtual terminal with the editor in its slot, wired as an interactive-mode host, so a
 * test can open a command's view through `ctx.ui.custom` and displace it with a dialog, a selector or the reset.
 */

import { vi } from "vitest";
import { Container, type TUI } from "../../tui/src/tui.ts";
import { TuiMainScreen } from "../../tui/src/tui-main-screen.ts";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import type { ExtensionUIContext } from "../src/core/features/types.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { CustomEditor } from "../src/theme/custom-editor.ts";
import { getEditorTheme } from "../src/theme/theme.ts";
import { createUiStore } from "../src/modes/interactive/state/store.ts";
import { createFakeHost } from "./interactive-mode-host.ts";

export const PENDING = Symbol("pending");

/** The promise's value, or PENDING when it has not settled shortly after. */
export async function settled<T>(promise: Promise<T>, ms = 50): Promise<T | typeof PENDING> {
	return Promise.race([promise, new Promise<typeof PENDING>((resolve) => setTimeout(() => resolve(PENDING), ms))]);
}

/** Call `initTheme` before creating one. */
export function createSlotHost() {
	const terminal = new VirtualTerminal(100, 30);
	const ui: TUI = new TuiMainScreen(terminal);
	const keybindings = KeybindingsManager.create();
	const editor = new CustomEditor(ui, getEditorTheme(), keybindings);
	const editorContainer = new Container();
	editorContainer.addChild(editor);
	ui.addChild(editorContainer);
	const host = createFakeHost({
		ui,
		editor,
		defaultEditor: editor,
		editorContainer,
		keybindings,
		programStatus: { setBlocked: vi.fn() },
		settingsManager: { getExternalEditorCommand: () => undefined },
		extensionSelector: undefined,
		extensionInput: undefined,
		extensionEditor: undefined,
		uiStore: createUiStore(),
		activeSelectorDispose: undefined,
		toggleToolOutputExpansion: vi.fn(),
		// What `resetExtensionUI` touches besides the editor slot.
		editorComponentFactory: undefined,
		activeStatusIndicator: undefined,
		defaultWorkingMessage: "Working",
		extensionWidgetsAbove: new Map(),
		extensionWidgetsBelow: new Map(),
		autocompleteProviderWrappers: [],
		footerDataProvider: { clearExtensionStatuses: vi.fn() },
		clearExtensionTerminalInputListeners: vi.fn(),
		setExtensionFooter: vi.fn(),
		setExtensionHeader: vi.fn(),
		renderWidgets: vi.fn(),
		setupAutocompleteProvider: vi.fn(),
		updateTerminalTitle: vi.fn(),
		setWorkingIndicator: vi.fn(),
		setHiddenThinkingLabel: vi.fn(),
	});
	ui.start();
	/** `ctx.ui.custom` as interactive mode provides it. */
	const custom: ExtensionUIContext["custom"] = (factory, options) => host.showExtensionCustom(factory, options);
	const screen = async (): Promise<string> => {
		await terminal.waitForRender();
		return terminal.getViewport().join("\n");
	};
	return { host, terminal, ui, editor, editorContainer, custom, screen };
}

export type SlotHost = ReturnType<typeof createSlotHost>;

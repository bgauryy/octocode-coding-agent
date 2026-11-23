/**
 * A real main-screen renderer on a virtual terminal with the editor in its slot, wired as an interactive-mode host, so a
 * test can open a command's view through `ctx.ui.custom` and displace it with a dialog, a selector or the reset.
 */

import { vi } from "vitest";
import { Container, type TUI } from "../../tui/src/tui.ts";
import { TuiMainScreen } from "../../tui/src/tui-main-screen.ts";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import type { SessionUI } from "../src/core/features/types.ts";
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
		programStatus: { setBlocked: vi.fn<(...args: never[]) => void>() },
		settingsManager: { getExternalEditorCommand: () => undefined },
		selectorDialog: undefined,
		inputDialog: undefined,
		editorDialog: undefined,
		uiStore: createUiStore(),
		activeSelectorDispose: undefined,
		toggleToolOutputExpansion: vi.fn<(...args: never[]) => void>(),
		// What `resetFeatureUI` touches besides the editor slot.
		editorComponentFactory: undefined,
		activeStatusIndicator: undefined,
		featureWidgetsAbove: new Map(),
		featureWidgetsBelow: new Map(),
		autocompleteProviderWrappers: [],
		footerDataProvider: { clearFeatureStatuses: vi.fn<(...args: never[]) => void>() },
		clearFeatureTerminalInputListeners: vi.fn<(...args: never[]) => void>(),
		setFeatureFooter: vi.fn<(...args: never[]) => void>(),
		setFeatureHeader: vi.fn<(...args: never[]) => void>(),
		renderWidgets: vi.fn<(...args: never[]) => void>(),
		setupAutocompleteProvider: vi.fn<(...args: never[]) => void>(),
		updateTerminalTitle: vi.fn<(...args: never[]) => void>(),
		setWorkingIndicator: vi.fn<(...args: never[]) => void>(),
	});
	ui.start();
	/** `ctx.ui.custom` as interactive mode provides it. */
	const custom: SessionUI["custom"] = (factory, options) => host.showCustomDialog(factory, options);
	const screen = async (): Promise<string> => {
		await terminal.waitForRender();
		return terminal.getViewport().join("\n");
	};
	return { host, terminal, ui, editor, editorContainer, custom, screen };
}

export type SlotHost = ReturnType<typeof createSlotHost>;

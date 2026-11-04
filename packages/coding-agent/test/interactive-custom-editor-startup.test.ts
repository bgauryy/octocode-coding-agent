import { Container, setKeybindings, TuiMainScreen } from "@octocodeai/octocode-tui";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { CustomEditor } from "../src/modes/interactive/components/custom-editor.ts";
import {
	handleStartupSubmit,
	setupEditorSubmitHandler,
} from "../src/modes/interactive/interactive-mode/command-dispatch.ts";
import { setCustomEditorComponent } from "../src/modes/interactive/interactive-mode/extension-chrome.ts";
import { setupKeyHandlers } from "../src/modes/interactive/interactive-mode/input-handlers.ts";
import { bindEditorState } from "../src/modes/interactive/state/bind-editor.ts";
import { createUiStore } from "../src/modes/interactive/state/store.ts";
import { getEditorTheme, initTheme, theme } from "../src/theme/theme.ts";
import { createFakeHost, heldStore } from "./interactive-mode-host.ts";

function createStartupHost() {
	const keybindings = new KeybindingsManager();
	setKeybindings(keybindings);
	const ui = new TuiMainScreen(new VirtualTerminal());
	const defaultEditor = new CustomEditor(ui, getEditorTheme(), keybindings);
	const host = createFakeHost({
		ui,
		keybindings,
		defaultEditor,
		editor: defaultEditor,
		editorContainer: new Container(),
		disposeActiveSelector: vi.fn(),
		showStatus: vi.fn(),
		shutdown: vi.fn(),
		toggleToolOutputExpansion: vi.fn(),
		flushPendingBashComponents: vi.fn(),
		pendingUserInputs: [] as string[],
		session: { isStreaming: false, isBashRunning: false, isCompacting: false },
		uiStore: createUiStore(),
	});
	bindEditorState(host);
	defaultEditor.onSubmit = (text) => handleStartupSubmit(host, text);
	setCustomEditorComponent(host, (tui, theme, keys) => new CustomEditor(tui, theme, keys));
	return host;
}

beforeEach(() => initTheme("dark"));

describe("custom editor installed during startup", () => {
	it("keeps early input and accepts commands once startup completes", async () => {
		const host = createStartupHost();
		await host.editor.onSubmit?.("early prompt");
		expect(host.editor.getText()).toBe("early prompt");
		expect(host.showStatus).toHaveBeenCalledWith("Startup is still in progress");
		host.showStatus.mockClear();

		setupKeyHandlers(host);
		setupEditorSubmitHandler(host);
		await host.editor.onSubmit?.("/quit");

		expect(host.shutdown).toHaveBeenCalledOnce();
		expect(host.editor.getText()).toBe("");
		expect(host.showStatus).not.toHaveBeenCalled();
	});

	it("enables app shortcuts and shell-mode feedback after startup", () => {
		const host = createStartupHost();
		host.editor.handleInput("\x0f");
		expect(host.toggleToolOutputExpansion).not.toHaveBeenCalled();

		setupKeyHandlers(host);
		host.editor.handleInput("\x0f");
		expect(host.toggleToolOutputExpansion).toHaveBeenCalledOnce();
		host.editor.handleInput("!");
		expect(host.uiStore.getState().editor.bashMode).toBe(true);
		expect(host.editor.borderColor?.("x")).toBe(theme.getBashModeBorderColor()("x"));
	});

	it("opens the queued-messages list on Up in the empty replacement editor", () => {
		const host = createStartupHost();
		const queued = [{ id: "q1", mode: "steer", text: "queued", imageCount: 0, source: "user" }];
		Object.assign(host.session, { getQueuedInputs: () => queued });
		const showQueueManager = vi.fn(() => true);
		Object.assign(host, { uiStore: heldStore(), showQueueManager });
		setupKeyHandlers(host);
		expect(host.editor).not.toBe(host.defaultEditor);

		host.editor.handleInput("\x1b[A");
		expect(showQueueManager).toHaveBeenCalledWith("last");

		showQueueManager.mockClear();
		queued.length = 0;
		host.editor.handleInput("\x1b[A");
		expect(showQueueManager).not.toHaveBeenCalled();
	});
});

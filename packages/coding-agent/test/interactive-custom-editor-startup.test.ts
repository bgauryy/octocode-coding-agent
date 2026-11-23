import { Container, setKeybindings, TuiMainScreen } from "@octocodeai/octocode-tui";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { CustomEditor } from "../src/theme/custom-editor.ts";
import {
	cancelStartupSubmit,
	dispatchStartupSubmit,
	handleStartupSubmit,
	setupEditorSubmitHandler,
} from "../src/modes/interactive/interactive-mode/command-dispatch.ts";
import { setCustomEditorComponent } from "../src/modes/interactive/interactive-mode/feature-chrome.ts";
import { setupKeyHandlers } from "../src/modes/interactive/interactive-mode/input-handlers.ts";
import { bindEditorState } from "../src/modes/interactive/state/bind-editor.ts";
import { createUiStore } from "../src/modes/interactive/state/store.ts";
import { getEditorTheme, initTheme, theme } from "../src/theme/theme.ts";
import { createFakeHost, heldStore } from "./interactive-mode-host.ts";
import { selectSubmittedInputs } from "../src/modes/interactive/state/input-slice.ts";

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
		showWorkingStatusIndicator: vi.fn(),
		session: { isStreaming: false, isBashRunning: false, isCompacting: false, getQueuedInputs: () => [] },
		uiStore: createUiStore(),
		editorChangeListeners: new Set<(text: string) => void>(),
	});
	bindEditorState(host);
	defaultEditor.onSubmit = (text) => handleStartupSubmit(host, text);
	defaultEditor.onEscape = () => cancelStartupSubmit(host);
	setCustomEditorComponent(host, (tui, theme, keys) => new CustomEditor(tui, theme, keys));
	return host;
}

beforeEach(() => initTheme("dark"));

describe("custom editor installed during startup", () => {
	it("keeps early input and accepts commands once startup completes", async () => {
		const host = createStartupHost();
		await host.editor.onSubmit?.("early prompt");
		expect(host.editor.getText()).toBe("early prompt");
		expect(host.showStatus).toHaveBeenCalledWith("Sends when startup finishes · esc cancels");
		host.editor.setText("");
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

/** Startup becoming ready, as `initInteractiveMode` does it: real handlers, then the queued submit. */
async function finishStartup(host: ReturnType<typeof createStartupHost>): Promise<void> {
	setupKeyHandlers(host);
	setupEditorSubmitHandler(host);
	dispatchStartupSubmit(host);
	await settle();
}

/** The submit handler awaits its compaction check before it queues the prompt. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

const typeText = (host: ReturnType<typeof createStartupHost>, text: string) => {
	for (const char of text) host.editor.handleInput(char);
};

describe("Enter during startup", () => {
	it("keeps the prompt in the editor and sends it exactly once when startup is ready", async () => {
		const host = createStartupHost();
		typeText(host, "first");
		host.editor.handleInput("\r");
		expect(host.editor.getText()).toBe("first");
		expect(selectSubmittedInputs(host.uiStore.getState())).toEqual([]);
		// A second Enter replaces the queued submit instead of adding one.
		host.editor.handleInput("\r");

		await finishStartup(host);
		dispatchStartupSubmit(host);
		await settle();

		expect(selectSubmittedInputs(host.uiStore.getState())).toEqual(["first"]);
		expect(host.editor.getText()).toBe("");
	});

	it("Esc cancels the queued submit and keeps the text", async () => {
		const host = createStartupHost();
		typeText(host, "draft");
		host.editor.handleInput("\r");
		host.editor.handleInput("\x1b");
		expect(host.showStatus).toHaveBeenLastCalledWith("Not sent: the prompt stays in the editor");

		await finishStartup(host);

		expect(selectSubmittedInputs(host.uiStore.getState())).toEqual([]);
		expect(host.editor.getText()).toBe("draft");
	});

	it("does not send text the user changed or cleared after Enter", async () => {
		const edited = createStartupHost();
		typeText(edited, "half");
		edited.editor.handleInput("\r");
		typeText(edited, " more");
		await finishStartup(edited);
		expect(selectSubmittedInputs(edited.uiStore.getState())).toEqual([]);
		expect(edited.editor.getText()).toBe("half more");

		const cleared = createStartupHost();
		typeText(cleared, "gone");
		cleared.editor.handleInput("\r");
		cleared.editor.setText("");
		await finishStartup(cleared);
		expect(selectSubmittedInputs(cleared.uiStore.getState())).toEqual([]);
	});

	it("sends a prompt an editor submitted untrimmed, and says why a changed one stays", () => {
		const duckTyped = () => {
			let text = "";
			const sent: string[] = [];
			const editor = {
				getText: () => text,
				setText: (next: string) => {
					text = next;
				},
				handleInput: () => {},
				render: () => [],
				invalidate: () => {},
				onSubmit: (submitted: string) => sent.push(submitted),
			};
			const host = createFakeHost({ editor, showStatus: vi.fn() });
			return { host, editor, sent };
		};
		const raw = duckTyped();
		handleStartupSubmit(raw.host, "hello \n");
		dispatchStartupSubmit(raw.host);
		expect(raw.sent).toEqual(["hello \n"]);
		expect(raw.editor.getText()).toBe("");

		const changed = duckTyped();
		handleStartupSubmit(changed.host, "hello");
		changed.editor.setText("hello again");
		dispatchStartupSubmit(changed.host);
		expect(changed.sent).toEqual([]);
		expect(changed.editor.getText()).toBe("hello again");
		expect(changed.host.showStatus).toHaveBeenLastCalledWith(
			"Not sent: the prompt changed after Enter and stays in the editor",
		);
	});

	it("keeps a paste marker in the editor and sends the pasted text", async () => {
		const host = createStartupHost();
		const pasted = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
		typeText(host, "see ");
		host.editor.handleInput(`\x1b[200~${pasted}\x1b[201~`);
		host.editor.handleInput("\r");
		expect(host.editor.getText()).toBe("see [paste #1 +20 lines]");
		expect(host.editor.getCursor()).toEqual({ line: 0, col: "see [paste #1 +20 lines]".length });

		await finishStartup(host);

		expect(selectSubmittedInputs(host.uiStore.getState())).toEqual([`see ${pasted}`]);
		// The prompt history keeps the marker; recalling it submits the same text.
		host.editor.handleInput("\x1b[A");
		expect(host.editor.getText()).toBe("see [paste #1 +20 lines]");
		host.editor.handleInput("\r");
		await settle();
		expect(selectSubmittedInputs(host.uiStore.getState())).toEqual([`see ${pasted}`, `see ${pasted}`]);
	});
});

describe("refused submits and typed runs in the app editor", () => {
	const big = Array.from({ length: 25 }, (_, i) => `row ${i}`).join("\n");
	const ready = () => {
		const host = createStartupHost();
		Object.assign(host, { showWarning: vi.fn(), getSlashCommands: () => [] });
		Object.assign(host.session, { sessionManager: { getCwd: () => process.cwd() } });
		setupKeyHandlers(host);
		setupEditorSubmitHandler(host);
		return host;
	};

	it("puts an unknown command back with its paste marker", async () => {
		const host = ready();
		typeText(host, "/nosuch ");
		host.editor.handleInput(`\x1b[200~${big}\x1b[201~`);
		host.editor.handleInput("\r");
		await settle();
		expect(host.showWarning).toHaveBeenCalledWith(expect.stringContaining("Unknown command /nosuch"));
		expect(host.editor.getText()).toBe("/nosuch [paste #1 +25 lines]");
		expect(host.editor.getExpandedText?.()).toBe(`/nosuch ${big}`);
	});

	it("puts a shell command back with its paste marker while another one runs", async () => {
		const host = ready();
		host.session.isBashRunning = true;
		typeText(host, "!cat <<'X' ");
		host.editor.handleInput(`\x1b[200~${big}\x1b[201~`);
		host.editor.handleInput("\r");
		await settle();
		expect(host.editor.getText()).toBe("!cat <<'X' [paste #1 +25 lines]");
		expect(host.editor.getExpandedText?.()).toBe(`!cat <<'X' ${big}`);
	});

	it("keeps pasted text when an extension installs its own editor", () => {
		const host = createStartupHost();
		host.editor.handleInput(`\x1b[200~${big}\x1b[201~`);
		setCustomEditorComponent(host, (tui, theme, keys) => new CustomEditor(tui, theme, keys));
		expect(host.editor.getText()).toBe(big);
	});
});

import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { Container, type TUI } from "../../tui/src/tui.ts";
import { TuiMainScreen } from "../../tui/src/tui-main-screen.ts";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { CustomEditor } from "../src/theme/custom-editor.ts";
import { showSessionSelector } from "../src/modes/interactive/interactive-mode/session-navigation.ts";
import { getEditorTheme, initTheme } from "../src/theme/theme.ts";
import { createUiStore } from "../src/modes/interactive/state/store.ts";
import { createFakeHost } from "./interactive-mode-host.ts";

const TAB = "\t";

beforeAll(() => initTheme("dark"));
afterEach(() => vi.restoreAllMocks());

describe("/resume session picker displaced by another view", () => {
	test("an extension dialog opening over the picker aborts its listing and clears its status timer", async () => {
		// This folder's listing fails at once, which arms the header's 4 s error status; the all-folders listing never ends.
		vi.spyOn(SessionManager, "list").mockRejectedValue(new Error("disk gone"));
		let allSignal: AbortSignal | undefined;
		vi.spyOn(SessionManager, "listAll").mockImplementation(((_onProgress: unknown, signal?: AbortSignal) => {
			allSignal = signal;
			return new Promise(() => {});
		}) as typeof SessionManager.listAll);
		const armed: unknown[] = [];
		const realSetTimeout = globalThis.setTimeout;
		vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number, ...rest: unknown[]) => {
			const handle = realSetTimeout(fn, ms, ...rest);
			if (ms === 4000) armed.push(handle);
			return handle;
		}) as typeof setTimeout);
		const cleared = vi.spyOn(globalThis, "clearTimeout");

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
			editorContainer,
			keybindings,
			programStatus: { setBlocked: vi.fn() },
			extensionSelector: undefined,
			uiStore: createUiStore(),
			activeSelectorDispose: undefined,
			sessionManager: {
				getCwd: () => "/work/s5c-repo",
				getSessionDir: () => "/tmp/s5c-sessions",
				getSessionFile: () => "/tmp/s5c-sessions/current.jsonl",
				usesDefaultSessionDir: () => true,
			},
		});
		ui.start();
		try {
			showSessionSelector(host);
			await vi.waitFor(async () => {
				await terminal.waitForRender();
				expect(terminal.getViewport().join("\n")).toContain("Failed to load sessions: disk gone");
			});
			expect(armed).toHaveLength(1);
			// Tab switches to all folders, whose listing keeps running.
			terminal.sendInput(TAB);
			await vi.waitFor(() => expect(allSignal).toBeDefined());
			expect(allSignal?.aborted).toBe(false);

			// An extension dialog takes the editor slot.
			const answer = host.showExtensionSelector("Extension question", ["yes", "no"]);
			await terminal.waitForRender();
			expect(terminal.getViewport().join("\n")).toContain("Extension question");

			expect(allSignal?.aborted).toBe(true);
			expect(cleared).toHaveBeenCalledWith(armed[0]);
			host.hideExtensionSelector();
			await answer;
		} finally {
			ui.stop();
		}
	});
});

import { beforeAll, describe, expect, test, vi } from "vitest";
import { Container, type TUI } from "../../tui/src/tui.ts";
import { TuiMainScreen } from "../../tui/src/tui-main-screen.ts";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { CustomEditor } from "../src/modes/interactive/components/custom-editor.ts";
import * as extensionDialogs from "../src/modes/interactive/interactive-mode/extension-dialogs.ts";
import { getEditorTheme, initTheme } from "../src/theme/theme.ts";
import { createFakeHost } from "./interactive-mode-host.ts";

const CTRL_G = "\x07";

/** Press a key in the open extension editor dialog. */
function press(host: { extensionEditor?: { handleInput(data: string): void } }, key: string): void {
	host.extensionEditor?.handleInput(key);
}

function openEditorDialog(command: string) {
	const terminal = new VirtualTerminal(100, 30);
	const ui: TUI = new TuiMainScreen(terminal);
	const keybindings = KeybindingsManager.create();
	const editorContainer = new Container();
	editorContainer.addChild(new CustomEditor(ui, getEditorTheme(), keybindings));
	ui.addChild(editorContainer);
	const host = createFakeHost({
		ui,
		editorContainer,
		keybindings,
		programStatus: { setBlocked: vi.fn() },
		settingsManager: { getExternalEditorCommand: () => command },
		extensionSelector: undefined,
		extensionInput: undefined,
		extensionEditor: undefined,
		disposeActiveSelector: vi.fn(),
	});
	const answer = extensionDialogs.showExtensionEditor(host, "Edit plan", "draft");
	ui.start();
	return { host, terminal, ui, answer };
}

describe("extension editor dialog: external editor", () => {
	beforeAll(() => initTheme("dark"));

	test("an editor command that cannot start is reported in the dialog, which stays open with its text", async () => {
		const { host, terminal, ui } = openEditorDialog("/nonexistent/octocode-s5b-editor");
		press(host, CTRL_G);
		await vi.waitFor(
			async () => {
				await terminal.waitForRender();
				expect(terminal.getViewport().join("\n")).toContain("External editor failed:");
			},
			{ timeout: 5000, interval: 25 },
		);
		const screen = terminal.getViewport().join("\n");
		expect(screen).toContain("ENOENT");
		expect(screen).toContain("Edit plan");
		expect(screen).toContain("draft");
		ui.stop();
	});

	test("an editor that exits non-zero (a deliberate cancel) adds no notice", async () => {
		const { host, terminal, ui } = openEditorDialog("false");
		const restart = vi.spyOn(ui, "start");
		press(host, CTRL_G);
		await vi.waitFor(() => expect(restart).toHaveBeenCalled(), { timeout: 5000, interval: 25 });
		await terminal.waitForRender();
		expect(terminal.getViewport().join("\n")).not.toContain("External editor failed");
		ui.stop();
	});
});

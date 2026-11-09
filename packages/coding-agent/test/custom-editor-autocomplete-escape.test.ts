import { setKeybindings, TuiMainScreen } from "@octocodeai/octocode-tui";
import { afterEach, describe, expect, it } from "vitest";
import { defaultEditorTheme } from "../../tui/test/test-themes.ts";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { CustomEditor } from "../src/theme/custom-editor.ts";

afterEach(() => {
	setKeybindings(new KeybindingsManager());
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 60));

describe("CustomEditor Escape with the @ picker", () => {
	it("cancels a pending request without calling the interrupt handler", async () => {
		const keybindings = new KeybindingsManager();
		setKeybindings(keybindings);
		const editor = new CustomEditor(new TuiMainScreen(new VirtualTerminal()), defaultEditorTheme, keybindings);
		let release: (() => void) | undefined;
		editor.setAutocompleteProvider({
			getSuggestions: () =>
				new Promise((resolve) => {
					release = () => resolve(null);
				}),
			applyCompletion: (lines, cursorLine, cursorCol) => ({ lines, cursorLine, cursorCol }),
		});
		let interrupts = 0;
		editor.onEscape = () => {
			interrupts++;
		};

		editor.handleInput("@");
		editor.handleInput("a");
		await settle();
		expect(editor.hasPendingAutocomplete()).toBe(true);

		editor.handleInput("\x1b");
		expect(interrupts).toBe(0);
		expect(editor.hasPendingAutocomplete()).toBe(false);
		expect(editor.getText()).toBe("@a");
		release?.();
		await settle();

		// With nothing pending or open, Escape reaches the agent again.
		editor.handleInput("\x1b");
		expect(interrupts).toBe(1);
	});

	it("keeps Ctrl+P and Ctrl+N for the open list instead of model cycling", async () => {
		const keybindings = new KeybindingsManager();
		setKeybindings(keybindings);
		const editor = new CustomEditor(new TuiMainScreen(new VirtualTerminal()), defaultEditorTheme, keybindings);
		editor.setAutocompleteProvider({
			getSuggestions: async () => ({
				prefix: "@",
				items: [
					{ value: "@a", label: "a", kind: "file" },
					{ value: "@b", label: "b", kind: "file" },
				],
			}),
			applyCompletion: (lines, cursorLine, cursorCol, item) => ({
				lines: [item.value],
				cursorLine,
				cursorCol: cursorCol + item.value.length,
			}),
		});
		let cycles = 0;
		editor.onAction("app.model.cycleForward", () => {
			cycles++;
		});
		editor.handleInput("@");
		await settle();
		expect(editor.isShowingAutocomplete()).toBe(true);
		editor.handleInput("\x0e"); // Ctrl+N
		editor.handleInput("\x10"); // Ctrl+P
		expect(cycles).toBe(0);
	});
});

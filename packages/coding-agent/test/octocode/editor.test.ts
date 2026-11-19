import {
	CombinedAutocompleteProvider,
	type EditorTheme,
	stripTerminalSequences,
	TuiMainScreen,
	visibleWidth,
} from "@octocodeai/octocode-tui";
import { describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../../tui/test/virtual-terminal.ts";
import type { FeatureContext } from "../../src/core/features/index.ts";
import { KeybindingsManager } from "../../src/core/keybindings.ts";
import { DialogSelectorComponent } from "../../src/modes/interactive/components/dialog-selector.ts";
import { CustomEditor } from "../../src/theme/custom-editor.ts";
import { initTheme } from "../../src/theme/theme.ts";
import {
	BOX_MIN_WIDTH,
	decorateEditor,
	hintText,
	labelledRule,
	promptLabel,
	registerEditor,
	withHint,
} from "../../src/octocode/ui/editor.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";

const identity = (text: string): string => text;
type EditorFactory = NonNullable<ReturnType<FeatureContext["ui"]["getEditorComponent"]>>;
const editorTheme: EditorTheme = {
	borderColor: identity,
	selectList: {
		selectedText: identity,
		description: identity,
		scrollInfo: identity,
		noMatch: identity,
	},
};

/** Runs the installed Octocode TuiBase input router without starting a physical terminal. */
function terminal() {
	const tui = new TuiMainScreen(new VirtualTerminal(100, 30));
	tui.requestRender = vi.fn();
	const input = (data: string) => Reflect.get(tui, "handleTerminalInput").call(tui, data);
	return { tui, input, keys: new KeybindingsManager() };
}

describe("permission shortcut in the Octocode editor", () => {
	it("forwards the thinking toggle to the host's action once per press without changing the draft", async () => {
		initTheme("dark", false);
		const fake = fakeHost();
		const ctx = fakeCtx({ cwd: "/private/tmp/editor" });
		registerEditor(fake.api, { cycle: vi.fn() });
		await fake.fire("session_start", {}, ctx);
		const { tui, input, keys } = terminal();
		const editor = ctx.ui.getEditorComponent()!(tui, editorTheme, keys) as CustomEditor;
		const toggle = vi.fn();
		editor.onAction("app.thinking.toggle", toggle);
		expect(editor.embedWorkingStatus).toBe(false);
		tui.setFocus(editor);
		input("draft");
		input("\x14");
		expect(toggle).toHaveBeenCalledTimes(1);
		// Repeat and release events of the held key do not toggle again.
		input("\x1b[116;5:2u");
		input("\x1b[116;5:3u");
		expect(toggle).toHaveBeenCalledTimes(1);
		keys.setUserBindings({ "app.thinking.toggle": "ctrl+y" });
		input("\x19");
		expect(toggle).toHaveBeenCalledTimes(2);
		expect(editor.getText()).toBe("draft");
	});

	it("cycles once per press, leaves text and thinking intact, and delegates Tab and other actions", async () => {
		const fake = fakeHost();
		const cycle = vi.fn();
		const ctx = fakeCtx({ cwd: "/private/tmp/editor" });
		registerEditor(fake.api, { cycle });
		await fake.fire("session_start", {}, ctx);
		const { tui, input, keys } = terminal();
		const editor = ctx.ui.getEditorComponent()!(tui, editorTheme, keys) as CustomEditor;
		const thinking = vi.fn();
		const model = vi.fn();
		editor.onAction("app.thinking.cycle", thinking);
		editor.onAction("app.model.select", model);
		const complete = vi.fn(async () => null);
		editor.setAutocompleteProvider({
			getSuggestions: complete,
			applyCompletion: () => ({ lines: ["completed"], cursorLine: 0, cursorCol: 9 }),
		});
		tui.setFocus(editor);
		input("draft");
		keys.setUserBindings({ "app.thinking.toggle": "shift+tab" });
		input("\x1b[Z");
		input("\x1b[9;2u");
		input("\x1b[9;2:2u");
		input("\x1b[9;2:3u");
		expect(cycle).toHaveBeenCalledTimes(2);
		expect(cycle).toHaveBeenLastCalledWith(ctx);
		expect(thinking).not.toHaveBeenCalled();
		expect(editor.getText()).toBe("draft");
		input("\t");
		await Promise.resolve();
		expect(complete).toHaveBeenCalled();
		input("\x0c");
		expect(model).toHaveBeenCalledOnce();
		keys.setUserBindings({ "app.permission.cycle": "ctrl+y" });
		input("\x1b[Z");
		expect(cycle).toHaveBeenCalledTimes(2);
		input("\x19");
		expect(cycle).toHaveBeenCalledTimes(3);
		expect(editor.getText()).toBe("draft");
	});

	it("keeps permission unchanged while a real Octocode approval selector owns focus", async () => {
		initTheme("dark", false);
		const fake = fakeHost();
		const cycle = vi.fn();
		const ctx = fakeCtx({ cwd: "/private/tmp/editor" });
		registerEditor(fake.api, { cycle });
		await fake.fire("session_start", {}, ctx);
		const { tui, input, keys } = terminal();
		const editor = ctx.ui.getEditorComponent()!(tui, editorTheme, keys);
		const selected = vi.fn();
		const cancelled = vi.fn();
		const selector = new DialogSelectorComponent("Approve?", ["Allow once", "Deny"], selected, cancelled);
		tui.setFocus(selector);
		input("\x1b[Z");
		input("\t");
		input("\x1b[B");
		input("\r");
		expect(selected).toHaveBeenCalledWith("Deny");
		expect(cancelled).not.toHaveBeenCalled();
		expect(cycle).not.toHaveBeenCalled();
		tui.setFocus(editor);
		input("\x1b[Z");
		expect(cycle).toHaveBeenCalledOnce();
	});

	it("chains a prior factory without replacing its editor or input behavior; an unmarked prior handler receives a typed run one key at a time, in order", async () => {
		const fake = fakeHost();
		const cycle = vi.fn();
		const ctx = fakeCtx({ cwd: "/private/tmp/editor" });
		const { tui, input, keys } = terminal();
		const original = new CustomEditor(tui, editorTheme, keys);
		const originalInput = vi.spyOn(original, "handleInput");
		const factory: EditorFactory = vi.fn(() => original);
		ctx.ui.setEditorComponent(factory);
		registerEditor(fake.api, { cycle });
		await fake.fire("session_start", {}, ctx);
		const editor = ctx.ui.getEditorComponent()!(tui, editorTheme, keys);
		expect(editor).toBe(original);
		expect(factory).toHaveBeenCalledWith(tui, editorTheme, keys);
		tui.setFocus(editor);
		input("hello");
		input("\x1b[Z");
		expect(editor.getText()).toBe("hello");
		// A typed run reaches an unmarked prior handler one key at a time, in order, as a terminal sends keys.
		expect(originalInput.mock.calls.map(([data]) => data)).toEqual(["h", "e", "l", "l", "o"]);
		expect(originalInput).not.toHaveBeenCalledWith("\x1b[Z");
		expect(cycle).toHaveBeenCalledOnce();
		// A caller that hands the editor several characters directly still reaches the prior handler in one call.
		editor.handleInput(" world");
		expect(originalInput).toHaveBeenLastCalledWith(" world");
		expect(editor.getText()).toBe("hello world");
	});

	it("leaves a chained editor as typing key by key does when a run arrives at once", async () => {
		const run = async (send: (input: (data: string) => void) => void) => {
			const fake = fakeHost();
			const ctx = fakeCtx({ cwd: "/private/tmp/editor" });
			const { tui, input, keys } = terminal();
			const original = new CustomEditor(tui, editorTheme, keys);
			const originalInput = vi.spyOn(original, "handleInput");
			ctx.ui.setEditorComponent(vi.fn(() => original));
			registerEditor(fake.api, { cycle: vi.fn() });
			await fake.fire("session_start", {}, ctx);
			const editor = ctx.ui.getEditorComponent()!(tui, editorTheme, keys);
			tui.setFocus(editor);
			send(input);
			return {
				text: editor.getText(),
				cursor: (editor as CustomEditor).getCursor(),
				calls: originalInput.mock.calls.map(([data]) => data),
			};
		};
		const together = await run((input) => input("hello world"));
		const apart = await run((input) => {
			for (const char of "hello world") input(char);
		});
		expect(together).toEqual(apart);
		expect(together.text).toBe("hello world");
	});

	it("runs its own key inside a typed run once, in order, with the characters around it in place", async () => {
		const fake = fakeHost();
		const ctx = fakeCtx({ cwd: "/private/tmp/editor" });
		registerEditor(fake.api, { cycle: vi.fn() });
		await fake.fire("session_start", {}, ctx);
		const { tui, input, keys } = terminal();
		const editor = ctx.ui.getEditorComponent()!(tui, editorTheme, keys) as CustomEditor;
		const seen: string[] = [];
		editor.onAction("app.thinking.toggle", () => seen.push(editor.getText()));
		tui.setFocus(editor);
		keys.setUserBindings({ "app.thinking.toggle": "~" });
		input("ab~cd");
		expect(seen).toEqual(["ab"]);
		expect(editor.getText()).toBe("abcd");
		expect(editor.getCursor()).toEqual({ line: 0, col: 4 });
		// Bindings changed after the editor was made count at once.
		keys.setUserBindings({ "app.thinking.toggle": "!" });
		input("x!y~");
		expect(seen).toEqual(["ab", "abcdx"]);
		expect(editor.getText()).toBe("abcdxy~");
	});

	it("sends the keys after an app key that opens an overlay to the overlay, not the editor", async () => {
		// The app editor alone (its own action handler) and wrapped by Octocode (the wrapper takes the key).
		for (const wrapped of [false, true]) {
			const fake = fakeHost();
			const ctx = fakeCtx({ cwd: "/private/tmp/editor" });
			registerEditor(fake.api, { cycle: vi.fn() });
			await fake.fire("session_start", {}, ctx);
			const { tui, input, keys } = terminal();
			const editor = wrapped
				? (ctx.ui.getEditorComponent()!(tui, editorTheme, keys) as CustomEditor)
				: new CustomEditor(tui, editorTheme, keys);
			const overlayKeys: string[] = [];
			const overlay = { render: () => [], invalidate: () => {}, handleInput: (data: string) => overlayKeys.push(data) };
			editor.onAction("app.thinking.toggle", () => tui.showOverlay(overlay));
			tui.setFocus(editor);
			keys.setUserBindings({ "app.thinking.toggle": "?" });
			input("ab?cd");
			expect(editor.getText(), `wrapped ${wrapped}`).toBe("ab");
			expect(overlayKeys, `wrapped ${wrapped}`).toEqual(["c", "d"]);
		}
	});

	it("keeps the installed factory across session changes and uses the latest context", async () => {
		const fake = fakeHost();
		const cycle = vi.fn<(ctx: FeatureContext) => void>();
		const ctx = fakeCtx({ cwd: "/private/tmp/first" });
		registerEditor(fake.api, { cycle });
		await fake.fire("session_start", {}, ctx);
		const factory = ctx.ui.getEditorComponent()!;
		const { tui, input, keys } = terminal();
		const editor = factory(tui, editorTheme, keys);
		tui.setFocus(editor);
		const next = { ...fakeCtx({ cwd: "/private/tmp/second" }), ui: ctx.ui };
		await fake.fire("session_start", { reason: "resume" }, next);
		expect(ctx.ui.getEditorComponent()).toBe(factory);
		input("\x1b[Z");
		expect(cycle).toHaveBeenCalledExactlyOnceWith(next);
		await fake.fire("session_start", {}, next);
		expect(ctx.ui.getEditorComponent()).toBe(factory);
		input("\x1b[Z");
		expect(cycle).toHaveBeenCalledTimes(2);
	});

	it("shows the hint in a fresh session until the first run, and not in a session with messages", async () => {
		const fake = fakeHost();
		const ctx = fakeCtx({ cwd: "/private/tmp/editor" });
		Reflect.set(ctx.ui, "theme", { fg: (_color: string, text: string) => text });
		registerEditor(fake.api, { cycle: vi.fn() });
		await fake.fire("session_start", {}, ctx);
		const { tui, keys } = terminal();
		const editor = ctx.ui.getEditorComponent()!(tui, editorTheme, keys) as CustomEditor;
		const row = () => editor.render(100)[1];
		expect(row()).toContain("Ask about any code");
		await fake.fire("agent_start", {}, ctx);
		expect(row()).not.toContain("Ask about any code");
		const resumed = fakeCtx({ cwd: "/private/tmp/editor" });
		Reflect.set(resumed.ui, "theme", { fg: (_color: string, text: string) => text });
		resumed.sessionManager.getBranch = (() => [{ type: "message" }]) as never;
		await fake.fire("session_start", {}, resumed);
		expect(resumed.ui.getEditorComponent()!(tui, editorTheme, keys).render(100)[1]).not.toContain("Ask about any code");
		await fake.fire("session_tree", {}, ctx);
		expect(row()).toContain("Ask about any code");
	});

	it.each([
		{ mode: "rpc", hasUI: true },
		{ mode: "print", hasUI: false },
	])("does not install an editor in $mode", async (options) => {
		const fake = fakeHost();
		const ctx = fakeCtx({ cwd: "/private/tmp/editor", ...options });
		const install = vi.spyOn(ctx.ui, "setEditorComponent");
		registerEditor(fake.api, { cycle: vi.fn() });
		await fake.fire("session_start", {}, ctx);
		expect(install).not.toHaveBeenCalled();
		expect(ctx.ui.getEditorComponent()).toBeUndefined();
	});
});

describe("Octocode prompt box", () => {
	const CODES: Record<string, number> = { error: 31, accent: 35, muted: 90, dim: 2 };
	const tagged = { fg: (color: string, text: string) => `\x1b[${CODES[color] ?? 39}m${text}\x1b[39m` };
	const painted = (code: number, text: string) => `\x1b[${code}m${text}\x1b[39m`;
	const plain = (line: string) => stripTerminalSequences(line);
	function boxed(hint = { value: true }) {
		const { tui, input, keys } = terminal();
		const editor = decorateEditor(
			new CustomEditor(tui, editorTheme, keys, { embedWorkingStatus: true }),
			() => tagged,
			() => hint.value,
		);
		tui.setFocus(editor);
		return { editor, input, hint };
	}
	/** Column `x` of row `y` in the box at `width`, as a terminal reports a left click there. */
	const click = (editor: CustomEditor, x: number, y: number, width = 60) => {
		editor.handleMouse({ type: "press", button: "left", x, y, width, height: 10 } as never);
		return editor.handleMouse({ type: "click", button: "left", x, y, width, height: 10 } as never);
	};

	it("draws a closed box with the idle label and the hint while empty, every row exactly the width", () => {
		const { editor } = boxed();
		const lines = editor.render(80);
		const text = lines.map(plain);
		expect(text[0]).toMatch(/^╭── octocode ─+╮$/);
		expect(text[1]).toMatch(/^│ .*Ask about any code · \/ commands · @ files · ! shell +│$/);
		// The footer is the one home of the permission mode: the bottom border stays a plain rule.
		expect(text[2]).toMatch(/^╰─+╯$/);
		expect(text.map((line) => visibleWidth(line))).toEqual([80, 80, 80]);
		expect(lines[1]).toContain(painted(90, "Ask about any code").slice(0, -5));
	});

	it("shows the skills a word points to in the bottom rule while the cursor is on it, and clears it after", () => {
		const { tui, input, keys } = terminal();
		const editor = decorateEditor(
			new CustomEditor(tui, editorTheme, keys, { embedWorkingStatus: true }),
			() => tagged,
			() => false,
			(line, column) => (line.slice(0, column).endsWith("debug") ? "debug → octocode-debugging" : undefined),
		);
		tui.setFocus(editor);
		input("debug");
		expect(plain(editor.render(60).at(-1) ?? "")).toContain("debug → octocode-debugging");
		input(" ");
		expect(plain(editor.render(60).at(-1) ?? "")).toMatch(/^╰─+╯$/);
	});

	it("drops the hint on the first keystroke and keeps the typed text inside the box", () => {
		const { editor, input } = boxed();
		input("hello");
		const text = editor.render(60).map(plain);
		expect(text[1]).toMatch(/^│ hello +│$/);
		expect(text.join("\n")).not.toContain("Ask about any code");
	});

	it("keeps the accent border and uses Octocode’s colour for a ! command", () => {
		const { editor, input } = boxed();
		editor.borderColor = (text) => painted(36, text);
		const lines = editor.render(60);
		expect(lines[0].startsWith(painted(35, "╭─"))).toBe(true);
		expect(plain(lines[2])).toMatch(/^╰─+╯$/);
		input("!ls");
		expect(editor.render(60)[0].startsWith(painted(36, "╭─"))).toBe(true);
		expect(plain(editor.render(60)[0])).toMatch(/^╭── ! shell ─+╮$/);
	});

	it("names the ! modes in the top border instead of the idle label", () => {
		const theme = { fg: (_color: string, text: string) => text };
		expect(promptLabel("", theme)).toBe(" octocode ");
		expect(promptLabel("  !ls", theme)).toBe(" ! shell ");
		expect(promptLabel("!!ls", theme)).toBe(" !! shell · no context ");
	});

	it("gives the top border to Octocode’s working line during a run", () => {
		const { editor } = boxed();
		editor.setWorkingStatusIndicator({ renderInBorder: () => "Working", renderSpinnerInBorder: () => "⠋" });
		const top = plain(editor.render(60)[0]);
		expect(top).toMatch(/^╭─── Working ─+╮$/);
		expect(top).not.toContain("octocode");
		editor.setWorkingStatusIndicator(undefined);
		expect(plain(editor.render(60)[0])).toContain(" octocode ");
	});

	it("places the cursor where a click lands inside the box", () => {
		const { editor, input } = boxed();
		input("hello world");
		editor.render(60);
		click(editor, 2 + 3, 1);
		input("X");
		expect(editor.getText()).toBe("helXlo world");
	});

	it.each([
		{ where: "the left border", x: 0, expected: "Xhello world" },
		{ where: "the left padding", x: 1, expected: "Xhello world" },
		{ where: "the first text column", x: 2, expected: "Xhello world" },
		{ where: "the right border", x: 59, expected: "hello worldX" },
	])("places the cursor at the nearest text column for a click on $where", ({ x, expected }) => {
		const { editor, input } = boxed();
		input("hello world");
		editor.render(60);
		click(editor, x, 1);
		input("X");
		expect(editor.getText()).toBe(expected);
	});

	it("accepts the autocomplete row a click lands on, under the box", async () => {
		const { editor } = boxed();
		editor.setAutocompleteProvider(
			new CombinedAutocompleteProvider(
				[
					{ name: "help", description: "Show help" },
					{ name: "hello", description: "Say hello" },
				],
				"/private/tmp/editor",
			),
		);
		editor.setText("");
		for (const key of "/he") editor.handleInput(key);
		await vi.waitFor(() => expect(editor.isShowingAutocomplete()).toBe(true));
		const lines = editor.render(60).map(plain);
		const row = lines.findIndex((line, index) => index > 2 && line.includes("hello"));
		expect(row).toBeGreaterThan(2);
		// Autocomplete rows sit two columns in, aligned with the text above.
		expect(lines[row].startsWith("  ")).toBe(true);
		click(editor, lines[row].indexOf("hello"), row);
		expect(editor.getText()).toMatch(/^\/hello/);
	});

	it("shows the hint only while `hint()` holds (the conversation has not started)", () => {
		const { editor, hint } = boxed();
		expect(plain(editor.render(80)[1])).toContain("Ask about any code");
		hint.value = false;
		expect(plain(editor.render(80)[1])).toMatch(/^│ \S? +│$/);
	});

	it("keeps Octocode’s scroll indicators when the text overflows", () => {
		const { editor } = boxed();
		editor.setText(Array.from({ length: 20 }, (_, line) => `line ${line}`).join("\n"));
		const text = editor.render(60).map(plain);
		expect(text[0].startsWith("╭─")).toBe(true);
		expect(text[0]).toContain("↑");
		expect(text[0]).not.toContain("octocode");
		expect(text.every((line) => visibleWidth(line) === 60)).toBe(true);
	});

	it("steps aside below the minimum width: Octocode’s plain rules, no labels, no hint", () => {
		const { editor } = boxed();
		const text = editor.render(BOX_MIN_WIDTH - 1).map(plain);
		expect(text[0]).toBe("─".repeat(BOX_MIN_WIDTH - 1));
		expect(text.join("")).not.toMatch(/[╭│╰]|octocode|Ask/);
	});

	it("boxes from the minimum width up, every row exactly the width", () => {
		const { editor, input } = boxed();
		for (const width of [BOX_MIN_WIDTH, 40]) {
			const text = editor.render(width).map(plain);
			expect(text[0].startsWith("╭─")).toBe(true);
			expect(text.every((line) => visibleWidth(line) === width)).toBe(true);
		}
		input("a prompt long enough to wrap inside the narrow box");
		const text = editor.render(BOX_MIN_WIDTH).map(plain);
		expect(text.length).toBeGreaterThan(3);
		expect(text.every((line) => visibleWidth(line) === BOX_MIN_WIDTH)).toBe(true);
	});

	it("shortens the hint part by part and keeps labels inside the rule", () => {
		expect(hintText(200)).toBe("Ask about any code · / commands · @ files · ! shell");
		expect(hintText(40)).toBe("Ask about any code · / commands");
		expect(plain(hintText(10))).toBe("Ask about…");
		expect(labelledRule(20, " left ", " right ", (text) => text)).toBe("─ left ───── right ─");
		expect(visibleWidth(labelledRule(10, " a long label ", " right ", (text) => text))).toBe(10);
		expect(withHint("ab   ", 5, tagged as never)).toBe("ab   ");
	});
});

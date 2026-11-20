import { afterEach, beforeAll, describe, expect, type Mock, test, vi } from "vitest";
import { type Component, Container, type TUI } from "../../tui/src/tui.ts";
import { TuiMainScreen } from "../../tui/src/tui-main-screen.ts";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { CustomEditor } from "../src/theme/custom-editor.ts";
import { pickSession } from "../src/modes/interactive/interactive-mode/session-picker.ts";
import { getEditorTheme, initTheme } from "../src/theme/theme.ts";
import { createUiStore } from "../src/modes/interactive/state/store.ts";
import { createFakeHost } from "./interactive-mode-host.ts";

const PENDING = Symbol("pending");

/** The promise's value, or PENDING when it has not settled shortly after. */
async function settled<T>(promise: Promise<T>): Promise<T | typeof PENDING> {
	return Promise.race([promise, new Promise<typeof PENDING>((resolve) => setTimeout(() => resolve(PENDING), 20))]);
}

beforeAll(() => initTheme("dark"));
afterEach(() => vi.restoreAllMocks());

/** A real main-screen renderer on a virtual terminal, with the editor in its slot. */
function createHost(extra: object = {}) {
	const terminal = new VirtualTerminal(80, 24);
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
		settingsManager: { getExternalEditorCommand: () => undefined },
		selectorDialog: undefined,
		inputDialog: undefined,
		editorDialog: undefined,
		uiStore: createUiStore(),
		activeSelectorDispose: undefined,
		toggleToolOutputExpansion: vi.fn(),
		sessionManager: {
			getCwd: () => "/work/s5d-repo",
			getSessionDir: () => "/tmp/s5d-sessions",
			getSessionFile: () => "/tmp/s5d-sessions/current.jsonl",
			usesDefaultSessionDir: () => true,
		},
		...extra,
	});
	ui.start();
	return { host, terminal, editor, editorContainer, ui };
}

/** A custom component showing `label`, with a dispose spy. */
function view(label: string): Component & { dispose: Mock<() => void> } {
	return { render: () => [label], invalidate: () => {}, dispose: vi.fn<() => void>() };
}

/** Open `component` with `ctx.ui.custom` semantics and wait until it holds the editor slot. */
async function openCustom<T>(env: ReturnType<typeof createHost>, component: Component) {
	let done: ((result: T) => void) | undefined;
	const result = env.host.showCustomDialog<T>((_tui, _theme, _keys, close) => {
		done = close;
		return component;
	});
	await vi.waitFor(() => expect(env.editorContainer.children).toEqual([component]));
	return { result, done: (value: T) => done?.(value) };
}

async function screen(terminal: VirtualTerminal): Promise<string> {
	await terminal.waitForRender();
	return terminal.getViewport().join("\n");
}

describe("ctx.ui.custom components closed by whatever takes their place or resets the extension UI", () => {
	test("a page opened with no run behind it clears the Working row Enter showed; a streaming run keeps it", async () => {
		for (const streaming of [false, true]) {
			const clear = vi.fn<(kind?: string) => void>();
			const env = createHost({
				session: { isStreaming: streaming },
				activeStatusIndicator: { kind: "working" },
				clearStatusIndicator: clear,
			});
			try {
				await openCustom<string>(env, view("a page"));
				expect(clear.mock.calls).toEqual(streaming ? [] : [["working"]]);
			} finally {
				env.ui.stop();
			}
		}
	});

	test("an extension dialog taking its slot disposes it and resolves it undefined", async () => {
		const env = createHost();
		try {
			const first = view("first custom view");
			const custom = await openCustom<string>(env, first);
			expect(await screen(env.terminal)).toContain("first custom view");

			const answer = env.host.showSelectorDialog("Extension question", ["yes", "no"]);
			const shown = await screen(env.terminal);
			expect(shown).toContain("Extension question");
			expect(shown).not.toContain("first custom view");

			expect(await settled(custom.result)).toBeUndefined();
			expect(first.dispose).toHaveBeenCalledTimes(1);
			// A late done from the displaced component neither settles it again nor disposes it again.
			custom.done("late");
			expect(await custom.result).toBeUndefined();
			expect(first.dispose).toHaveBeenCalledTimes(1);
			expect(await settled(answer)).toBe(PENDING);
			env.host.hideSelectorDialog();
			expect(await settled(answer)).toBeUndefined();
			expect(env.editorContainer.children).toEqual([env.editor]);
		} finally {
			env.ui.stop();
		}
	});

	test("a built-in selector or another custom component taking its slot settles it; the newcomer stays open", async () => {
		const env = createHost();
		try {
			const first = view("first custom view");
			const firstOpen = await openCustom<string>(env, first);
			const selectorDispose = vi.fn();
			const selector = view("built-in selector");
			env.host.showSelector(() => ({ component: selector, focus: selector, dispose: selectorDispose }));
			expect(await settled(firstOpen.result)).toBeUndefined();
			expect(first.dispose).toHaveBeenCalledTimes(1);
			expect(await screen(env.terminal)).toContain("built-in selector");

			const second = view("second custom view");
			const secondOpen = await openCustom<string>(env, second);
			expect(selectorDispose).toHaveBeenCalledTimes(1);
			const third = view("third custom view");
			const thirdOpen = await openCustom<string>(env, third);
			expect(await settled(secondOpen.result)).toBeUndefined();
			expect(second.dispose).toHaveBeenCalledTimes(1);
			expect(await settled(thirdOpen.result)).toBe(PENDING);
			expect(third.dispose).not.toHaveBeenCalled();

			thirdOpen.done("picked");
			expect(await thirdOpen.result).toBe("picked");
			expect(third.dispose).toHaveBeenCalledTimes(1);
			expect(env.editorContainer.children).toEqual([env.editor]);
		} finally {
			env.ui.stop();
		}
	});

	test("a component closed normally leaves nothing behind for the next displacement to settle", async () => {
		const env = createHost();
		try {
			const first = view("first custom view");
			const firstOpen = await openCustom<string>(env, first);
			firstOpen.done("one");
			expect(await firstOpen.result).toBe("one");

			const answer = env.host.showInputDialog("Name?");
			expect(await settled(answer)).toBe(PENDING);
			expect(first.dispose).toHaveBeenCalledTimes(1);
			env.host.hideInputDialog();
			expect(await settled(answer)).toBeUndefined();
		} finally {
			env.ui.stop();
		}
	});

	test("the editor draft comes back with its paste markers after a component closes", async () => {
		const env = createHost();
		try {
			const pasted = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
			env.editor.handleInput(`\x1b[200~${pasted}\x1b[201~`);
			const open = await openCustom<string>(env, view("custom"));
			open.done("one");
			expect(await open.result).toBe("one");
			expect(env.editor.getText()).toBe("[paste #1 +20 lines]");
			expect(env.editor.getExpandedText()).toBe(pasted);
		} finally {
			env.ui.stop();
		}
	});

	test("a component whose factory calls done before returning is disposed once and leaves the editor in place", async () => {
		const env = createHost();
		try {
			const early = view("early custom view");
			const result = env.host.showCustomDialog<string>((_tui, _theme, _keys, done) => {
				done("at once");
				return early;
			});
			expect(await result).toBe("at once");
			await vi.waitFor(() => expect(early.dispose).toHaveBeenCalledTimes(1));
			expect(env.editorContainer.children).toEqual([env.editor]);

			const late = view("async custom view");
			const asyncResult = env.host.showCustomDialog<string>(async (_tui, _theme, _keys, done) => {
				done("before ready");
				return late;
			});
			expect(await asyncResult).toBe("before ready");
			await vi.waitFor(() => expect(late.dispose).toHaveBeenCalledTimes(1));
			expect(env.editorContainer.children).toEqual([env.editor]);
			expect(await screen(env.terminal)).not.toContain("custom view");
			expect(early.dispose).toHaveBeenCalledTimes(1);
		} finally {
			env.ui.stop();
		}
	});

	test("an extension dialog displaced by a custom component answers undefined", async () => {
		const env = createHost();
		try {
			const answer = env.host.showConfirmDialog("Delete", "Really?");
			const custom = view("custom over dialog");
			const open = await openCustom<string>(env, custom);
			expect(await settled(answer)).toBe(false);
			expect(env.host.selectorDialog).toBeUndefined();
			expect(await screen(env.terminal)).toContain("custom over dialog");
			expect(await settled(open.result)).toBe(PENDING);
			open.done("ok");
			expect(await open.result).toBe("ok");
		} finally {
			env.ui.stop();
		}
	});

	test("ctx.ui.pickSession displaced by an extension dialog resolves undefined and stops its listing", async () => {
		let listSignal: AbortSignal | undefined;
		vi.spyOn(SessionManager, "list").mockImplementation(((
			_cwd: string,
			_dir: string,
			_onProgress: unknown,
			signal?: AbortSignal,
		) => {
			listSignal = signal;
			return new Promise(() => {});
		}) as typeof SessionManager.list);
		const env = createHost();
		try {
			const picked = pickSession(env.host, {});
			await vi.waitFor(() => expect(listSignal).toBeDefined());
			expect(listSignal?.aborted).toBe(false);

			const answer = env.host.showSelectorDialog("Extension question", ["yes"]);
			expect(await settled(picked)).toBeUndefined();
			expect(listSignal?.aborted).toBe(true);
			env.host.hideSelectorDialog();
			expect(await settled(answer)).toBeUndefined();
		} finally {
			env.ui.stop();
		}
	});

	test("the reset on reload or session replacement closes every custom overlay and the custom component in the slot", async () => {
		const env = createHost({
			editorComponentFactory: undefined,
			activeStatusIndicator: undefined,
			defaultWorkingMessage: "Working",
			featureWidgetsAbove: new Map(),
			featureWidgetsBelow: new Map(),
			autocompleteProviderWrappers: [],
			footerDataProvider: { clearFeatureStatuses: vi.fn() },
			clearFeatureTerminalInputListeners: vi.fn(),
			setFeatureFooter: vi.fn(),
			setFeatureHeader: vi.fn(),
			renderWidgets: vi.fn(),
			setupAutocompleteProvider: vi.fn(),
			updateTerminalTitle: vi.fn(),
			setWorkingIndicator: vi.fn(),
		});
		Object.assign(env.host, { defaultEditor: env.editor });
		try {
			const slot = view("slot custom view");
			const slotOpen = await openCustom<string>(env, slot);
			const lower = view("lower overlay");
			const upper = view("upper overlay");
			const lowerResult = env.host.showCustomDialog<string>(() => lower, { overlay: true });
			const upperResult = env.host.showCustomDialog<string>(() => upper, { overlay: true });
			await vi.waitFor(async () => expect(await screen(env.terminal)).toContain("upper overlay"));

			env.host.resetFeatureUI();
			for (const result of [slotOpen.result, lowerResult, upperResult]) {
				expect(await settled(result)).toBeUndefined();
			}
			for (const component of [slot, lower, upper]) expect(component.dispose).toHaveBeenCalledTimes(1);
			const shown = await screen(env.terminal);
			expect(shown).not.toContain("overlay");
			expect(shown).not.toContain("slot custom view");
			expect(env.editorContainer.children).toEqual([env.editor]);
		} finally {
			env.ui.stop();
		}
	});
});

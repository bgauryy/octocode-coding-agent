import { homedir } from "node:os";
import * as path from "node:path";
import {
	type AutocompleteProvider,
	CombinedAutocompleteProvider,
	getKeybindings,
	setKeybindings,
} from "@octocodeai/octocode-tui";
import { beforeAll, describe, expect, onTestFinished, test, vi } from "vitest";
import { type Component, Container, type Focusable, type TUI } from "../../tui/src/tui.ts";
import { TuiMainScreen } from "../../tui/src/tui-main-screen.ts";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import type { AutocompleteProviderFactory } from "../src/core/features/types.ts";
import { createEventBus, type EventBus } from "@octocodeai/octocode-agent-core";
import { setMcpSessionStatus } from "../../mcp/src/status.ts";
import type { QuietStartup } from "../src/core/settings-manager.ts";
import type { SourceInfo } from "../src/core/source-info.ts";
import type { AuthSelectorProvider } from "../src/modes/interactive/components/oauth-selector.ts";
import * as autocomplete from "../src/modes/interactive/interactive-mode/autocomplete.ts";
import * as display from "../src/modes/interactive/interactive-mode/display.ts";
import * as extensionContext from "../src/modes/interactive/interactive-mode/session-ui.ts";
import * as extensionDialogs from "../src/modes/interactive/interactive-mode/dialogs.ts";
import * as loadedResources from "../src/modes/interactive/interactive-mode/loaded-resources.ts";
import * as resourceGroups from "../src/modes/interactive/interactive-mode/resource-groups.ts";
import * as resourcePaths from "../src/modes/interactive/interactive-mode/resource-paths.ts";
import * as statusIndicators from "../src/modes/interactive/interactive-mode/status-indicators.ts";
import { initTheme } from "../src/theme/theme.ts";
import type { ToolStatus } from "../src/utils/tools-manager.ts";
import { createFakeHost } from "./interactive-mode-host.ts";
import { bindViewState } from "../src/modes/interactive/state/bind-view.ts";
import { createUiStore } from "../src/modes/interactive/state/store.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";

function renderLastLine(container: Container, width = 120): string {
	const last = container.children[container.children.length - 1];
	if (!last) return "";
	return last.render(width).join("\n");
}

/** Rendered rows as plain text: listing rows colour their label, count and summary separately. */
function renderAll(container: Container, width = 120): string {
	return container.children
		.flatMap((child) => child.render(width))
		.join("\n")
		.replace(/\u001b\[[0-9;]*m/g, "");
}

class TestFocusableComponent implements Component, Focusable {
	focused = false;
	inputs: string[] = [];
	private readonly label: string;
	private text = "";

	constructor(label: string) {
		this.label = label;
	}

	handleInput(data: string): void {
		this.inputs.push(data);
	}

	getText(): string {
		return this.text;
	}

	setText(text: string): void {
		this.text = text;
	}

	render(): string[] {
		return [this.label];
	}

	invalidate(): void {}
}

async function flushTui(tui: TUI, terminal: VirtualTerminal): Promise<void> {
	tui.requestRender(true);
	await Promise.resolve();
	await terminal.waitForRender();
}

function normalizeRenderedOutput(container: Container, width = 220): string {
	return renderAll(container, width)
		.replace(/\u001b\[[0-9;]*m/g, "")
		.replace(/\\/g, "/")
		.split("\n")
		.map((line) => line.replace(/\s+$/g, ""))
		.join("\n")
		.trim();
}

type FeatureFixture = {
	path: string;
	sourceInfo?: SourceInfo;
};

describe("InteractiveMode.showStatus", () => {
	beforeAll(() => {
		// showStatus uses the global theme instance
		initTheme("dark");
	});

	test("coalesces immediately-sequential status messages", () => {
		const fakeThis: any = {
			chatContainer: new Container(),
			ui: { requestRender: vi.fn() },
			lastStatusSpacer: undefined,
			lastStatusText: undefined,
		};

		statusIndicators.showStatus(createFakeHost(fakeThis), "STATUS_ONE");
		expect(fakeThis.chatContainer.children).toHaveLength(2);
		expect(renderLastLine(fakeThis.chatContainer)).toContain("STATUS_ONE");

		statusIndicators.showStatus(createFakeHost(fakeThis), "STATUS_TWO");
		// second status updates the previous line instead of appending
		expect(fakeThis.chatContainer.children).toHaveLength(2);
		expect(renderLastLine(fakeThis.chatContainer)).toContain("STATUS_TWO");
		expect(renderLastLine(fakeThis.chatContainer)).not.toContain("STATUS_ONE");
	});

	test("appends a new status line if something else was added in between", () => {
		const fakeThis: any = {
			chatContainer: new Container(),
			ui: { requestRender: vi.fn() },
			lastStatusSpacer: undefined,
			lastStatusText: undefined,
		};

		statusIndicators.showStatus(createFakeHost(fakeThis), "STATUS_ONE");
		expect(fakeThis.chatContainer.children).toHaveLength(2);

		// Something else gets added to the chat in between status updates
		fakeThis.chatContainer.addChild({ render: () => ["OTHER"], invalidate: () => {} });
		expect(fakeThis.chatContainer.children).toHaveLength(3);

		statusIndicators.showStatus(createFakeHost(fakeThis), "STATUS_TWO");
		// adds spacer + text
		expect(fakeThis.chatContainer.children).toHaveLength(5);
		expect(renderLastLine(fakeThis.chatContainer)).toContain("STATUS_TWO");
	});

	test("keeps each status line's own text after invalidation", () => {
		const fakeThis: any = {
			chatContainer: new Container(),
			ui: { requestRender: vi.fn() },
			lastStatusSpacer: undefined,
			lastStatusText: undefined,
		};

		statusIndicators.showStatus(createFakeHost(fakeThis), "Model set to A");
		fakeThis.chatContainer.addChild({ render: () => ["(assistant reply)"], invalidate: () => {} });
		statusIndicators.showStatus(createFakeHost(fakeThis), "Model set to B");
		// A theme change or settings change invalidates every component.
		fakeThis.chatContainer.invalidate();

		const first = fakeThis.chatContainer.children[1].render(120).join("\n");
		expect(first).toContain("Model set to A");
		expect(first).not.toContain("Model set to B");
		expect(renderLastLine(fakeThis.chatContainer)).toContain("Model set to B");
	});

	test("a coalesced status line keeps its latest text after invalidation", () => {
		const fakeThis: any = {
			chatContainer: new Container(),
			ui: { requestRender: vi.fn() },
			lastStatusSpacer: undefined,
			lastStatusText: undefined,
		};

		statusIndicators.showStatus(createFakeHost(fakeThis), "STATUS_ONE");
		statusIndicators.showStatus(createFakeHost(fakeThis), "STATUS_TWO");
		fakeThis.chatContainer.invalidate();

		expect(fakeThis.chatContainer.children).toHaveLength(2);
		expect(renderLastLine(fakeThis.chatContainer)).toContain("STATUS_TWO");
		expect(renderLastLine(fakeThis.chatContainer)).not.toContain("STATUS_ONE");
	});

	const CONTROLS = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/;
	const withoutColors = (text: string) => text.replace(/\u001b\[[0-9;]*m/g, "");

	test("strips terminal controls from status text, such as a host name", () => {
		const fakeThis: any = { chatContainer: new Container(), ui: { requestRender: vi.fn() } };

		statusIndicators.showStatus(createFakeHost(fakeThis), "Signed out on github.com\u001b]0;pwned\u0007\u001b[2J.");

		const line = withoutColors(renderLastLine(fakeThis.chatContainer));
		expect(line).toContain("Signed out on github.com");
		expect(line).not.toMatch(CONTROLS);
	});

	test("draws a validated link as OSC 8 and shows any other link as plain text", () => {
		const fakeThis: any = { chatContainer: new Container(), ui: { requestRender: vi.fn() } };
		const host = createFakeHost(fakeThis);

		statusIndicators.showStatus(host, ["Share URL: ", { url: "https://example.test/s?id=1" }]);
		expect(renderLastLine(fakeThis.chatContainer)).toContain(
			"\u001b]8;;https://example.test/s?id=1\u001b\\https://example.test/s?id=1\u001b]8;;\u001b\\",
		);

		fakeThis.chatContainer.addChild({ render: () => ["(reply)"], invalidate: () => {} });
		statusIndicators.showStatus(host, [
			"Links: ",
			{ url: "javascript:alert(1)", label: "run" },
			" ",
			{ url: "https://example.test/\u001b]0;pwned\u0007" },
		]);
		const line = withoutColors(renderLastLine(fakeThis.chatContainer));
		expect(line).toContain("Links: run https://example.test/");
		expect(line).not.toMatch(CONTROLS);
	});
});

describe("InteractiveMode.showManagedToolStatus", () => {
	beforeAll(() => initTheme("dark"));

	test("renders tool updates as one contiguous group", () => {
		const fakeThis: any = {
			chatContainer: new Container(),
			ui: { requestRender: vi.fn() },
			uiStore: createUiStore(),
			lastStatusSpacer: undefined,
			lastStatusText: undefined,
		};
		const showManagedToolStatus = (context: any, status: ToolStatus) =>
			statusIndicators.showManagedToolStatus(createFakeHost(context), status);

		showManagedToolStatus(fakeThis, { type: "info", message: "fd downloading" });
		showManagedToolStatus(fakeThis, { type: "info", message: "rg downloading" });
		showManagedToolStatus(fakeThis, { type: "warning", message: "rg failed" });

		expect(fakeThis.chatContainer.children).toHaveLength(4);
		expect(normalizeRenderedOutput(fakeThis.chatContainer)).toBe(
			"fd downloading\n rg downloading\n Warning: rg failed",
		);
	});
});

describe("InteractiveMode.setToolsExpanded", () => {
	test("applies expansion state to the active header and chat entries", () => {
		const header = { setExpanded: vi.fn() };
		const loadedResourcesChild = { setExpanded: vi.fn() };
		const chatChild = { setExpanded: vi.fn() };
		const footerDataProvider = { setFeatureStatus: vi.fn() };
		const fakeThis: any = {
			uiStore: createUiStore(),
			customHeader: undefined,
			builtInHeader: header,
			loadedResourcesContainer: { children: [loadedResourcesChild] },
			chatContainer: { children: [chatChild] },
			footerDataProvider,
			ui: { requestRender: vi.fn() },
			showStatus: vi.fn(),
		};

		const host = createFakeHost(fakeThis);
		bindViewState(host);
		fakeThis.uiStore.getState().setToolsExpanded(true);

		expect(fakeThis.uiStore.getState().view.toolsExpanded).toBe(true);
		expect(header.setExpanded).toHaveBeenCalledWith(true);
		expect(loadedResourcesChild.setExpanded).toHaveBeenCalledWith(true);
		expect(chatChild.setExpanded).toHaveBeenCalledWith(true);
		// The acknowledgement is a status line in the messages list; the footer shows state only.
		expect(fakeThis.showStatus).toHaveBeenCalledWith("Output: expanded");
		expect(footerDataProvider.setFeatureStatus).not.toHaveBeenCalled();
	});

	test("says each toggle once in the messages list and keeps a burst on one line", () => {
		initTheme("dark");
		const fakeThis: any = {
			uiStore: createUiStore(),
			builtInHeader: undefined,
			loadedResourcesContainer: { children: [] },
			chatContainer: new Container(),
			footerDataProvider: { setFeatureStatus: vi.fn() },
			ui: { requestRender: vi.fn() },
		};
		const host = createFakeHost(fakeThis);
		bindViewState(host);

		fakeThis.uiStore.getState().setToolsExpanded(true);
		fakeThis.uiStore.getState().setToolsExpanded(true);
		fakeThis.uiStore.getState().setToolsExpanded(false);
		// A spacer and one line: the second toggle replaced the first in place; an unchanged state said nothing.
		expect(fakeThis.chatContainer.children).toHaveLength(2);
		expect(normalizeRenderedOutput(fakeThis.chatContainer)).toBe("Output: collapsed");
		expect(fakeThis.footerDataProvider.setFeatureStatus).not.toHaveBeenCalled();
	});
});

describe("InteractiveMode.createSessionUI setTheme", () => {
	test("persists theme changes to settings manager", () => {
		initTheme("dark");

		let currentTheme = "dark";
		const settingsManager = {
			getTheme: vi.fn(() => currentTheme),
			setTheme: vi.fn((theme: string) => {
				currentTheme = theme;
			}),
		};
		const fakeThis: any = {
			session: { settingsManager },
			settingsManager,
			themeController: {
				setThemeInstance: vi.fn(() => ({ success: true })),
				setThemeName: vi.fn(() => {
					fakeThis.ui.requestRender();
					return { success: true };
				}),
			},
			ui: { requestRender: vi.fn() },
		};

		const uiContext = extensionContext.createSessionUI(createFakeHost(fakeThis));
		const result = uiContext.setTheme("light");

		expect(result.success).toBe(true);
		expect(fakeThis.themeController.setThemeName).toHaveBeenCalledWith("light");
		expect(settingsManager.setTheme).toHaveBeenCalledWith("light");
		expect(currentTheme).toBe("light");
		expect(fakeThis.ui.requestRender).toHaveBeenCalledTimes(1);
	});

	test("does not persist invalid theme names", () => {
		initTheme("dark");

		const settingsManager = {
			getTheme: vi.fn(() => "dark"),
			setTheme: vi.fn(),
		};
		const fakeThis: any = {
			session: { settingsManager },
			settingsManager,
			themeController: {
				setThemeInstance: vi.fn(() => ({ success: true })),
				setThemeName: vi.fn(() => ({ success: false, error: "Theme not found" })),
			},
			ui: { requestRender: vi.fn() },
		};

		const uiContext = extensionContext.createSessionUI(createFakeHost(fakeThis));
		const result = uiContext.setTheme("__missing_theme__");

		expect(result.success).toBe(false);
		expect(fakeThis.themeController.setThemeName).toHaveBeenCalledWith("__missing_theme__");
		expect(settingsManager.setTheme).not.toHaveBeenCalled();
		expect(fakeThis.ui.requestRender).not.toHaveBeenCalled();
	});
});

describe("InteractiveMode.showCustomDialog", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	test("overlay custom UI reclaims input after non-overlay custom UI closes", async () => {
		const terminal = new VirtualTerminal(80, 24);
		const ui: TUI = new TuiMainScreen(terminal);
		const editorContainer = new Container();
		const editor = new TestFocusableComponent("EDITOR");
		const palette = new TestFocusableComponent("PALETTE");
		const overlay = new TestFocusableComponent("OVERLAY");
		const replacement = new TestFocusableComponent("REPLACEMENT");
		let closeOverlay: (value: string) => void = () => {
			throw new Error("closeOverlay was not initialized");
		};
		let closeReplacement: (value: string) => void = () => {
			throw new Error("closeReplacement was not initialized");
		};
		const fakeThis = {
			editor,
			editorContainer,
			keybindings: {},
			ui,
			uiStore: createUiStore(),
			disposeActiveSelector: vi.fn(),
		};
		const showCustomDialog = <T>(
			factory: (tui: TUI, theme: unknown, keybindings: unknown, done: (result: T) => void) => Component,
			options?: { overlay?: boolean },
		): Promise<T | undefined> => extensionDialogs.showCustomDialog(createFakeHost(fakeThis), factory, options);

		editorContainer.addChild(editor);
		ui.addChild(editorContainer);
		ui.addChild(palette);
		ui.setFocus(palette);
		ui.start();
		try {
			const overlayPromise = showCustomDialog<string>(
				(_tui, _theme, _keybindings, done) => {
					closeOverlay = done;
					return overlay;
				},
				{ overlay: true },
			);
			await flushTui(ui, terminal);
			expect(overlay.focused).toBe(true);

			const replacementPromise = showCustomDialog<string>((_tui, _theme, _keybindings, done) => {
				closeReplacement = done;
				return replacement;
			});
			await flushTui(ui, terminal);
			expect(replacement.focused).toBe(true);

			closeReplacement("done");
			await replacementPromise;
			await flushTui(ui, terminal);
			terminal.sendInput("x");
			await flushTui(ui, terminal);

			expect(overlay.inputs).toEqual(["x"]);
			expect(editor.inputs).toEqual([]);
			expect(overlay.focused).toBe(true);

			closeOverlay("closed");
			await overlayPromise;
		} finally {
			ui.stop();
		}
	});

	// Closing a lower overlay removed the topmost overlay instead.
	test.each([
		{ lowerKind: "capturing", nonCapturing: false },
		{ lowerKind: "non-capturing", nonCapturing: true },
	])(
		"closing a lower $lowerKind overlay custom UI removes its own overlay, not the topmost one",
		async ({ nonCapturing }) => {
			const terminal = new VirtualTerminal(80, 24);
			const ui: TUI = new TuiMainScreen(terminal);
			const editorContainer = new Container();
			const editor = new TestFocusableComponent("EDITOR");
			const lower = new TestFocusableComponent("LOWER");
			const upper = new TestFocusableComponent("UPPER");
			let closeLower: (value: string) => void = () => {
				throw new Error("closeLower was not initialized");
			};
			let closeUpper: (value: string) => void = () => {
				throw new Error("closeUpper was not initialized");
			};
			const fakeThis = {
				editor,
				editorContainer,
				keybindings: {},
				ui,
				disposeActiveSelector: vi.fn(),
			};
			const showCustomDialog = <T>(
				factory: (tui: TUI, theme: unknown, keybindings: unknown, done: (result: T) => void) => Component,
				options?: { overlay?: boolean; overlayOptions?: { nonCapturing?: boolean } },
			): Promise<T | undefined> => extensionDialogs.showCustomDialog(createFakeHost(fakeThis), factory, options);

			editorContainer.addChild(editor);
			ui.addChild(editorContainer);
			ui.setFocus(editor);
			ui.start();
			try {
				const lowerPromise = showCustomDialog<string>(
					(_tui, _theme, _keybindings, done) => {
						closeLower = done;
						return lower;
					},
					{ overlay: true, overlayOptions: { nonCapturing } },
				);
				await flushTui(ui, terminal);
				const upperPromise = showCustomDialog<string>(
					(_tui, _theme, _keybindings, done) => {
						closeUpper = done;
						return upper;
					},
					{ overlay: true },
				);
				await flushTui(ui, terminal);
				expect(upper.focused).toBe(true);

				closeLower("lower closed");
				await expect(lowerPromise).resolves.toBe("lower closed");
				await flushTui(ui, terminal);

				const viewport = terminal.getViewport().join("\n");
				expect(viewport).toContain("UPPER");
				expect(viewport).not.toContain("LOWER");
				terminal.sendInput("x");
				await flushTui(ui, terminal);
				expect(upper.inputs).toEqual(["x"]);
				expect(lower.inputs).toEqual([]);

				closeUpper("upper closed");
				await expect(upperPromise).resolves.toBe("upper closed");
				await flushTui(ui, terminal);
				expect(ui.hasOverlay()).toBe(false);
				expect(editor.focused).toBe(true);
			} finally {
				ui.stop();
			}
		},
	);
});

describe("InteractiveMode.createSessionUI addAutocompleteProvider", () => {
	test("stores wrapper factories and rebuilds autocomplete immediately", () => {
		const wrapper: AutocompleteProviderFactory = (current) => current;
		const fakeThis = {
			autocompleteProviderWrappers: [] as AutocompleteProviderFactory[],
			setupAutocompleteProvider: vi.fn(),
		};

		const uiContext = extensionContext.createSessionUI(createFakeHost(fakeThis));
		uiContext.addAutocompleteProvider(wrapper);

		expect(fakeThis.autocompleteProviderWrappers).toEqual([wrapper]);
		expect(fakeThis.setupAutocompleteProvider).toHaveBeenCalledTimes(1);
	});
});

describe("InteractiveMode.setupAutocompleteProvider", () => {
	test("stacks wrapper factories over a fresh base provider", () => {
		const defaultEditor = { setAutocompleteProvider: vi.fn() };
		const customEditor = { setAutocompleteProvider: vi.fn() };
		const calls: string[] = [];

		const wrap1: AutocompleteProviderFactory = (current): AutocompleteProvider => ({
			async getSuggestions(lines, cursorLine, cursorCol, options) {
				calls.push("getSuggestions:wrap1");
				return current.getSuggestions(lines, cursorLine, cursorCol, options);
			},
			applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
				calls.push("applyCompletion:wrap1");
				return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
			},
			shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
				calls.push("shouldTrigger:wrap1");
				return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
			},
		});
		const wrap2: AutocompleteProviderFactory = (current): AutocompleteProvider => ({
			async getSuggestions(lines, cursorLine, cursorCol, options) {
				calls.push("getSuggestions:wrap2");
				return current.getSuggestions(lines, cursorLine, cursorCol, options);
			},
			applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
				calls.push("applyCompletion:wrap2");
				return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
			},
			shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
				calls.push("shouldTrigger:wrap2");
				return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
			},
		});

		const fakeThis = {
			createBaseAutocompleteProvider: () => new CombinedAutocompleteProvider([], "/tmp/project", undefined),
			defaultEditor,
			editor: customEditor,
			autocompleteProviderWrappers: [wrap1, wrap2],
		};

		autocomplete.setupAutocompleteProvider(createFakeHost(fakeThis));

		expect(defaultEditor.setAutocompleteProvider).toHaveBeenCalledTimes(1);
		expect(customEditor.setAutocompleteProvider).toHaveBeenCalledTimes(1);
		const provider = defaultEditor.setAutocompleteProvider.mock.calls[0]?.[0] as AutocompleteProvider;
		expect(provider).toBe(customEditor.setAutocompleteProvider.mock.calls[0]?.[0]);
		expect(provider.shouldTriggerFileCompletion?.(["foo"], 0, 3)).toBe(true);
		expect(calls).toEqual(["shouldTrigger:wrap2", "shouldTrigger:wrap1"]);
	});

	test("merges triggerCharacters from wrapper factories", () => {
		const defaultEditor = { setAutocompleteProvider: vi.fn() };
		const customEditor = { setAutocompleteProvider: vi.fn() };
		const passThrough =
			(triggerCharacters: string[]): AutocompleteProviderFactory =>
			(current) => ({
				triggerCharacters,
				getSuggestions: (lines, cursorLine, cursorCol, options) =>
					current.getSuggestions(lines, cursorLine, cursorCol, options),
				applyCompletion: (lines, cursorLine, cursorCol, item, prefix) =>
					current.applyCompletion(lines, cursorLine, cursorCol, item, prefix),
			});

		const fakeThis = {
			createBaseAutocompleteProvider: () => new CombinedAutocompleteProvider([], "/tmp/project", undefined),
			defaultEditor,
			editor: customEditor,
			autocompleteProviderWrappers: [passThrough(["$"]), passThrough(["!"])],
		};

		autocomplete.setupAutocompleteProvider(createFakeHost(fakeThis));

		const provider = defaultEditor.setAutocompleteProvider.mock.calls[0]?.[0] as AutocompleteProvider;
		expect(provider.triggerCharacters).toEqual(["$", "!"]);
	});
});

describe("InteractiveMode.createBaseAutocompleteProvider", () => {
	test("matches model command arguments across provider/model order", async () => {
		type TestModel = { id: string; provider: string; name: string };
		type FakeInteractiveMode = {
			session: {
				scopedModels: Array<{ model: TestModel }>;
				modelRuntime: { getAvailableSnapshot: () => TestModel[] };
				promptTemplates: [];
				featureHost: { getRegisteredCommands: () => [] };
				resourceLoader: { getSkills: () => { skills: [] } };
			};
			settingsManager: { getEnableSkillCommands: () => boolean };
			skillCommands: Map<string, string>;
			sessionManager: { getCwd: () => string };
		};

		const models = [
			{ id: "gpt-5.2-codex", provider: "github-copilot", name: "GPT-5.2 Codex" },
			{ id: "gpt-5.5", provider: "openai-codex", name: "GPT-5.5" },
		];
		const fakeThis: FakeInteractiveMode = {
			session: {
				scopedModels: [],
				modelRuntime: { getAvailableSnapshot: () => models },
				promptTemplates: [],
				featureHost: { getRegisteredCommands: () => [] },
				resourceLoader: { getSkills: () => ({ skills: [] }) },
			},
			settingsManager: { getEnableSkillCommands: () => false },
			skillCommands: new Map(),
			sessionManager: { getCwd: () => "/tmp" },
		};

		const provider = autocomplete.createBaseAutocompleteProvider(createFakeHost(fakeThis));
		const line = "/model codexgpt";
		const suggestions = await provider.getSuggestions([line], 0, line.length, {
			signal: new AbortController().signal,
		});

		expect(suggestions?.items.map((item) => item.value)).toEqual([
			"openai-codex/gpt-5.5",
			"github-copilot/gpt-5.2-codex",
		]);
	});

	test.each(["providers"])("matches /%s arguments by provider id, name and Pi configuration", async (command) => {
		type FakeInteractiveMode = {
			session: {
				scopedModels: [];
				modelRuntime: { getAvailableSnapshot: () => [] };
				promptTemplates: [];
				featureHost: { getRegisteredCommands: () => [] };
				resourceLoader: { getSkills: () => { skills: [] } };
			};
			settingsManager: { getEnableSkillCommands: () => boolean };
			skillCommands: Map<string, string>;
			sessionManager: { getCwd: () => string };
			getLoginProviderOptions: () => AuthSelectorProvider[];
		};

		const fakeThis: FakeInteractiveMode = {
			session: {
				scopedModels: [],
				modelRuntime: { getAvailableSnapshot: () => [] },
				promptTemplates: [],
				featureHost: { getRegisteredCommands: () => [] },
				resourceLoader: { getSkills: () => ({ skills: [] }) },
			},
			settingsManager: { getEnableSkillCommands: () => false },
			skillCommands: new Map(),
			sessionManager: { getCwd: () => "/tmp" },
			getLoginProviderOptions: () => [
				{ id: "anthropic", name: "Anthropic", authType: "oauth", subscription: true },
				{ id: "anthropic", name: "Anthropic", authType: "api_key", subscription: true },
				{ id: "openai", name: "OpenAI", authType: "api_key" },
				{ id: "openai-codex", name: "OpenAI Codex", authType: "oauth" },
				{ id: "openrouter", name: "OpenRouter", authType: "oauth", subscription: false },
			],
		};

		const provider = autocomplete.createBaseAutocompleteProvider(createFakeHost(fakeThis));
		const line = `/${command} subscription anthrop`;
		const suggestions = await provider.getSuggestions([line], 0, line.length, {
			signal: new AbortController().signal,
		});

		expect(suggestions?.items).toEqual([
			{
				value: "anthropic",
				label: "anthropic",
				description: "Anthropic · subscription/API key",
			},
		]);

		// OAuth sign-in without a subscription, such as OpenRouter, is an account.
		const accountLine = `/${command} openrouter`;
		const accountSuggestions = await provider.getSuggestions([accountLine], 0, accountLine.length, {
			signal: new AbortController().signal,
		});
		expect(accountSuggestions?.items).toEqual([
			{ value: "openrouter", label: "openrouter", description: "OpenRouter · account" },
		]);
		const piLine = `/${command} config`;
		const piSuggestions = await provider.getSuggestions([piLine], 0, piLine.length, {
			signal: new AbortController().signal,
		});
		expect(piSuggestions?.items).toEqual([
			{ value: "pi", label: "pi", description: "Pi (config) · import credentials and use configured models" },
		]);
		const codexLine = "/providers codex";
		const codexSuggestions = await provider.getSuggestions([codexLine], 0, codexLine.length, {
			signal: new AbortController().signal,
		});
		expect(codexSuggestions?.items.map((item) => item.value)).toEqual(["openai-codex", "runner:codex"]);
		const runnerLine = "/providers runner:";
		const runnerSuggestions = await provider.getSuggestions([runnerLine], 0, runnerLine.length, {
			signal: new AbortController().signal,
		});
		expect(runnerSuggestions?.items.map((item) => item.value)).toEqual([
			"runner:claude-code",
			"runner:codex",
			"runner:opencode",
			"runner:gemini",
			"runner:agy",
			"runner:cursor",
		]);
		expect(runnerSuggestions?.items.every((item) => item.description?.includes("external agent"))).toBe(true);
		const runnerItem = codexSuggestions!.items.find((item) => item.value === "runner:codex")!;
		expect(
			provider.applyCompletion([codexLine], 0, codexLine.length, runnerItem, codexSuggestions!.prefix).lines,
		).toEqual(["/providers runner:codex"]);
	});
});
describe("InteractiveMode.showLoadedResources", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	function createShowLoadedResourcesThis(options: {
		quietStartup: QuietStartup;
		verbose?: boolean;
		toolsExpanded?: boolean;
		cwd?: string;
		contextFiles?: Array<{ path: string; content?: string }>;
		systemPromptSource?: { path: string };
		appendSystemPromptSources?: Array<{ path: string }>;
		features?: FeatureFixture[];
		skills?: Array<{ filePath: string; name: string }>;
		skillDiagnostics?: Array<{ type: "warning" | "error" | "collision"; message: string }>;
		useRealScopeGroups?: boolean;
		events?: EventBus;
		featureWarnings?: Array<{ path: string; warning: string; listedInContext?: boolean }>;
	}) {
		const fakeThis: any = {
			options: { verbose: options.verbose ?? false },
			uiStore: createUiStore({ view: { toolsExpanded: options.toolsExpanded ?? false } }),
			loadedResourcesContainer: new Container(),
			ui: { requestRender: vi.fn() },
			chatContainer: new Container(),
			settingsManager: {
				getQuietStartup: () => options.quietStartup,
				isProjectTrusted: () => true,
				getSettings: () => ({}),
			},
			sessionManager: {
				getCwd: () => options.cwd ?? "/tmp/project",
			},
			session: {
				promptTemplates: [],
				featureHost: {
					getCommandDiagnostics: () => [],
				},
				resourceLoader: {
					getEventBus: () => options.events,
					getPathMetadata: () => new Map(),
					getAgentsFiles: () => ({ agentsFiles: options.contextFiles ?? [] }),
					getSystemPromptSource: () => options.systemPromptSource,
					getAppendSystemPromptSources: () => options.appendSystemPromptSources ?? [],
					getSkills: () => ({
						skills: options.skills ?? [],
						diagnostics: options.skillDiagnostics ?? [],
					}),
					getPrompts: () => ({ prompts: [], diagnostics: [] }),
					getFeatures: () => ({
						features: options.features ?? [],
						errors: [],
						warnings: options.featureWarnings,
						runtime: {},
					}),
					getThemes: () => ({ themes: [], diagnostics: [] }),
				},
			},
			formatDisplayPath: (p: string) => resourcePaths.formatDisplayPath(p),
			formatFeatureDisplayPath: (p: string) => resourcePaths.formatFeatureDisplayPath(createFakeHost(fakeThis), p),
			formatContextPath: (p: string) => resourcePaths.formatContextPath(createFakeHost(fakeThis), p),
			getStartupExpansionState: () => display.getStartupExpansionState(createFakeHost(fakeThis)),
			shouldShowStartupDetails: () => display.shouldShowStartupDetails(createFakeHost(fakeThis)),
			buildScopeGroups: () => [],
			formatScopeGroups: () => "resource-list",
			isPackageSource: (sourceInfo?: SourceInfo) => resourceGroups.isPackageSource(sourceInfo),
			getShortPath: (p: string, sourceInfo?: SourceInfo) =>
				resourcePaths.getShortPath(createFakeHost(fakeThis), p, sourceInfo),
			getCompactPathLabel: (p: string, sourceInfo?: SourceInfo) =>
				resourcePaths.getCompactPathLabel(createFakeHost(fakeThis), p, sourceInfo),
			getCompactPackageSourceLabel: (sourceInfo?: SourceInfo) => resourcePaths.getCompactPackageSourceLabel(sourceInfo),
			getCompactFeatureLabel: (p: string, sourceInfo?: SourceInfo) =>
				resourcePaths.getCompactFeatureLabel(createFakeHost(fakeThis), p, sourceInfo),
			getCompactDisplayPathSegments: (p: string) =>
				resourcePaths.getCompactDisplayPathSegments(createFakeHost(fakeThis), p),
			getCompactNonPackageFeatureLabel: (
				p: string,
				index: number,
				allPaths: Array<{ path: string; segments: string[] }>,
			) => resourcePaths.getCompactNonPackageFeatureLabel(createFakeHost(fakeThis), p, index, allPaths),
			getCompactFeatureLabels: (features: FeatureFixture[]) =>
				resourcePaths.getCompactFeatureLabels(createFakeHost(fakeThis), features),
			formatDiagnostics: () => "diagnostics",
			getBuiltInCommandConflictDiagnostics: () => [],
		};

		if (options.useRealScopeGroups) {
			fakeThis.getScopeGroup = (sourceInfo?: SourceInfo) => resourceGroups.getScopeGroup(sourceInfo);
			fakeThis.buildScopeGroups = (items: Array<{ path: string; sourceInfo?: SourceInfo }>) =>
				resourceGroups.buildScopeGroups(createFakeHost(fakeThis), items);
			fakeThis.formatScopeGroups = (...args: Parameters<typeof resourceGroups.formatScopeGroups>) =>
				resourceGroups.formatScopeGroups(...args);
		}

		return fakeThis;
	}

	function createSourceInfo(
		filePath: string,
		options: {
			source: string;
			scope: "user" | "project" | "temporary";
			origin: "package" | "top-level";
			baseDir?: string;
		},
	): SourceInfo {
		return {
			path: filePath,
			source: options.source,
			scope: options.scope,
			origin: options.origin,
			baseDir: options.baseDir,
		};
	}

	function createFeatureFixtures(): FeatureFixture[] {
		return [
			{
				path: "/tmp/project/.octocode/extensions/answer.ts",
				sourceInfo: createSourceInfo("/tmp/project/.octocode/extensions/answer.ts", {
					source: "local",
					scope: "project",
					origin: "top-level",
					baseDir: "/tmp/project/.octocode/extensions",
				}),
			},
			{
				path: "/tmp/project/.octocode/extensions/local-index/index.ts",
				sourceInfo: createSourceInfo("/tmp/project/.octocode/extensions/local-index/index.ts", {
					source: "local",
					scope: "project",
					origin: "top-level",
					baseDir: "/tmp/project/.octocode/extensions",
				}),
			},
			{
				path: "/tmp/agent/extensions/user-index/index.ts",
				sourceInfo: createSourceInfo("/tmp/agent/extensions/user-index/index.ts", {
					source: "local",
					scope: "user",
					origin: "top-level",
					baseDir: "/tmp/agent/extensions",
				}),
			},
			{
				path: "/tmp/project/.octocode/npm/node_modules/pi-markdown-preview/extensions/index.ts",
				sourceInfo: createSourceInfo(
					"/tmp/project/.octocode/npm/node_modules/pi-markdown-preview/extensions/index.ts",
					{
						source: "npm:pi-markdown-preview",
						scope: "project",
						origin: "package",
						baseDir: "/tmp/project/.octocode/npm/node_modules/pi-markdown-preview",
					},
				),
			},
			{
				path: "/tmp/project/.octocode/npm/node_modules/@scope/pi-scoped/extensions/index.ts",
				sourceInfo: createSourceInfo("/tmp/project/.octocode/npm/node_modules/@scope/pi-scoped/extensions/index.ts", {
					source: "npm:@scope/pi-scoped",
					scope: "project",
					origin: "package",
					baseDir: "/tmp/project/.octocode/npm/node_modules/@scope/pi-scoped",
				}),
			},
			{
				path: "/tmp/project/.octocode/git/github.com/HazAT/pi-interactive-subagents/extensions/index.ts",
				sourceInfo: createSourceInfo(
					"/tmp/project/.octocode/git/github.com/HazAT/pi-interactive-subagents/extensions/index.ts",
					{
						source: "git:github.com/HazAT/pi-interactive-subagents",
						scope: "project",
						origin: "package",
						baseDir: "/tmp/project/.octocode/git/github.com/HazAT/pi-interactive-subagents",
					},
				),
			},
			{
				path: "/tmp/project/.octocode/git/github.com/HazAT/pi-interactive-subagents/extensions/subagents/index.ts",
				sourceInfo: createSourceInfo(
					"/tmp/project/.octocode/git/github.com/HazAT/pi-interactive-subagents/extensions/subagents/index.ts",
					{
						source: "git:github.com/HazAT/pi-interactive-subagents",
						scope: "project",
						origin: "package",
						baseDir: "/tmp/project/.octocode/git/github.com/HazAT/pi-interactive-subagents",
					},
				),
			},
			{
				path: "/tmp/temp/cli-extension.ts",
				sourceInfo: createSourceInfo("/tmp/temp/cli-extension.ts", {
					source: "cli",
					scope: "temporary",
					origin: "top-level",
					baseDir: "/tmp/temp",
				}),
			},
		];
	}

	test("folds budgets into rows and keeps model commands and the legend", () => {
		const fake = createShowLoadedResourcesThis({
			quietStartup: false,
			contextFiles: [{ path: "/tmp/AGENTS.md", content: "rules" }],
			skills: [{ filePath: "/tmp/skill/SKILL.md", name: "review" }],
		});
		fake.session.model = { id: "test-model", contextWindow: 100 };
		fake.session.modelRuntime = { getAvailableSnapshot: () => [{ provider: "local", id: "test-model" }] };
		fake.session.systemPrompt = `<project_context>\n${"a".repeat(100)}\n</project_context>\n<available_skills>\n${"b".repeat(100)}\n</available_skills>`;
		loadedResources.showLoadedResources(createFakeHost(fake), { force: true });
		const output = renderAll(fake.loadedResourcesContainer);
		expect(output).toMatch(/Context\s+⚠/);
		expect(output).toMatch(/Skills\s+⚠/);
		expect(output).toContain("/2 chars");
		expect(output).not.toMatch(/Skill list too long|Context files too long/);
		// Counts read as words: one provider and one model are singular.
		expect(output).toContain("test-model · 1 provider · 1 model · /model · /providers");
		expect(output).toContain("(ctrl+o to toggle details)");
		expect(output).not.toMatch(/Hooks|Plugins/);
	});

	test("shows a compact resource listing by default", () => {
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			skills: [{ filePath: "/tmp/skill/SKILL.md", name: "commit" }],
		});

		loadedResources.showLoadedResources(createFakeHost(fakeThis), {
			force: false,
		});

		const output = renderAll(fakeThis.loadedResourcesContainer);
		expect(output).toMatch(/^Skills\s+✓ 1/m);
		// Names are for ctrl+o: collapsed, the section is one row with a count and where the skills came from.
		// The size is the skill tool's listing line for the one skill, counted against the budget.
		expect(output).toMatch(/Skills\s+✓ 1\s+52\/5.0k chars.*octocode context check/);
		expect(output).not.toContain("commit");
		expect(normalizeRenderedOutput(fakeThis.loadedResourcesContainer, 100)).toBe(
			[
				"Skills   ✓ 1  52/5.0k chars · octocode context check · /harness",
				"Model    ⚠ 1  none selected · 0 providers · 0 models · /model · /providers",
				"Harness  ✓ 3  on: .agents, root .mcp.json, Pi · off: Claude Code, Codex, Cursor · /harness",
				"✓ ready  ⚠ needs action · (ctrl+o to toggle details)",
			].join("\n"),
		);
	});

	test("shows full resource listing when expanded", () => {
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			toolsExpanded: true,
			skills: [{ filePath: "/tmp/skill/SKILL.md", name: "commit" }],
		});

		loadedResources.showLoadedResources(createFakeHost(fakeThis), {
			force: false,
		});

		const output = renderAll(fakeThis.loadedResourcesContainer);
		expect(output).toMatch(/^Skills\s+✓ 1/m);
		expect(output).toMatch(/commit\s+\/tmp\/skill\/SKILL\.md/);
	});

	test("shows full resource listing on verbose startup even when tool output is collapsed", () => {
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: true,
			verbose: true,
			toolsExpanded: false,
			skills: [{ filePath: "/tmp/skill/SKILL.md", name: "commit" }],
		});

		loadedResources.showLoadedResources(createFakeHost(fakeThis), {
			force: false,
		});

		const output = renderAll(fakeThis.loadedResourcesContainer);
		expect(output).toMatch(/^Skills\s+✓ 1/m);
		expect(output).toMatch(/commit\s+\/tmp\/skill\/SKILL\.md/);
	});

	test("lists MCP servers after skills without repainting for connection state, which the details show live", () => {
		const events = createEventBus();
		const server = {
			name: "octocode",
			enabled: true,
			state: "connecting",
			exposure: "direct" as const,
			toolCount: 0,
			source: "built-in Octocode",
		};
		setMcpSessionStatus(events, [server, { ...server, name: "docs", enabled: false }]);
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			events,
			skills: [{ filePath: "/tmp/skill/SKILL.md", name: "research" }],
		});
		loadedResources.showLoadedResources(createFakeHost(fakeThis));
		const rows = [...fakeThis.loadedResourcesContainer.children];
		const render = () => renderAll(fakeThis.loadedResourcesContainer);
		const initial = render();
		expect(initial.indexOf("Skills")).toBeLessThan(initial.indexOf("MCP "));
		expect(initial).toMatch(/^MCP\s+✓ 2\s+1 on \(octocode\) · 1 off \(docs\)/m);
		expect(initial).toContain("1 off (docs)");
		expect(initial).not.toContain("connecting");
		// A connection state that moves on after the row scrolled off must not touch the row: the renderer would clear and
		// redraw the whole scrollback for it.
		setMcpSessionStatus(events, [
			{ ...server, state: "connected", toolCount: 9 },
			{ ...server, name: "docs", enabled: false },
		]);
		expect(render()).toBe(initial);
		expect(fakeThis.ui.requestRender).not.toHaveBeenCalled();
		expect(fakeThis.loadedResourcesContainer.children).toEqual(rows);
		// Expanded (ctrl+o), the details read the current states.
		for (const row of rows) (row as { setExpanded?: (expanded: boolean) => void }).setExpanded?.(true);
		expect(render()).toContain("● octocode connected (9 tools)");
		// A server appearing or a selection change is a change to the listing: the row repaints once.
		setMcpSessionStatus(events, [
			{ ...server, state: "connected", toolCount: 9 },
			{ ...server, name: "docs", enabled: false },
			{ ...server, name: "extra", state: "connected" },
		]);
		expect(fakeThis.ui.requestRender).toHaveBeenCalledTimes(1);
		// A failure is news: it appears in the collapsed row, once.
		for (const row of rows) (row as { setExpanded?: (expanded: boolean) => void }).setExpanded?.(false);
		setMcpSessionStatus(events, [
			{ ...server, state: "failed" },
			{ ...server, name: "docs", enabled: false },
			{ ...server, name: "extra", state: "connected" },
		]);
		expect(fakeThis.ui.requestRender).toHaveBeenCalledTimes(2);
		expect(render()).toMatch(/^MCP\s+✗ 3/m);
		// After the listing is disposed, status changes no longer reach it.
		loadedResources.disposeLoadedResources(fakeThis.loadedResourcesContainer);
		setMcpSessionStatus(events, [{ ...server, name: "other" }]);
		expect(fakeThis.ui.requestRender).toHaveBeenCalledTimes(2);
	});

	test("abbreviates extensions in compact listing", () => {
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			features: [{ path: "/tmp/extensions/answer.ts" }, { path: "/tmp/extensions/btw.ts" }],
		});

		loadedResources.showLoadedResources(createFakeHost(fakeThis), {
			force: false,
		});

		const output = renderAll(fakeThis.loadedResourcesContainer);
		expect(output).toMatch(/^Features\s+✓ 2/m);
		expect(output).toContain("answer.ts, btw.ts");
		expect(output).not.toContain("extensions/answer.ts");
	});

	test("captures mixed extension layouts in compact output", () => {
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			features: createFeatureFixtures(),
			useRealScopeGroups: true,
		});

		loadedResources.showLoadedResources(createFakeHost(fakeThis), {
			force: false,
		});

		expect(normalizeRenderedOutput(fakeThis.loadedResourcesContainer)).toMatchInlineSnapshot(
			`
			"Model     ⚠ 1  none selected · 0 providers · 0 models · /model · /providers
			Features  ✓ 8  @scope/pi-scoped, answer.ts, cli-extension.ts, HazAT/pi-interactive-subagents, HazAT/pi-interactive-subagents:subagents, local-index, pi-markdown-preview, user-index · /harness
			Harness   ✓ 3  on: .agents, root .mcp.json, Pi · off: Claude Code, Codex, Cursor · /harness
			⚠ needs action  ✓ ready · (ctrl+o to toggle details)"
		`,
		);
	});

	test("adds more parent folders until local extension labels are unique", () => {
		const features: FeatureFixture[] = [
			{
				path: "/tmp/alpha/one/index.ts",
				sourceInfo: createSourceInfo("/tmp/alpha/one/index.ts", {
					source: "cli",
					scope: "temporary",
					origin: "top-level",
					baseDir: "/tmp/alpha",
				}),
			},
			{
				path: "/tmp/beta/one/index.ts",
				sourceInfo: createSourceInfo("/tmp/beta/one/index.ts", {
					source: "cli",
					scope: "temporary",
					origin: "top-level",
					baseDir: "/tmp/beta",
				}),
			},
			{
				path: "/tmp/gamma/one/index.ts",
				sourceInfo: createSourceInfo("/tmp/gamma/one/index.ts", {
					source: "cli",
					scope: "temporary",
					origin: "top-level",
					baseDir: "/tmp/gamma",
				}),
			},
		];

		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			features,
			useRealScopeGroups: true,
		});

		loadedResources.showLoadedResources(createFakeHost(fakeThis), {
			force: false,
		});

		expect(normalizeRenderedOutput(fakeThis.loadedResourcesContainer)).toMatchInlineSnapshot(
			`
			"Model     ⚠ 1  none selected · 0 providers · 0 models · /model · /providers
			Features  ✓ 3  alpha/one, beta/one, gamma/one · /harness
			Harness   ✓ 3  on: .agents, root .mcp.json, Pi · off: Claude Code, Codex, Cursor · /harness
			⚠ needs action  ✓ ready · (ctrl+o to toggle details)"
		`,
		);
	});

	test("strips index.ts from local extension label, showing parent dir", () => {
		const features: FeatureFixture[] = [
			{
				path: "/tmp/extensions/plan-mode/index.ts",
				sourceInfo: createSourceInfo("/tmp/extensions/plan-mode/index.ts", {
					source: "local",
					scope: "project",
					origin: "top-level",
					baseDir: "/tmp/extensions",
				}),
			},
		];

		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			features,
			useRealScopeGroups: true,
		});

		loadedResources.showLoadedResources(createFakeHost(fakeThis), {
			force: false,
		});

		expect(normalizeRenderedOutput(fakeThis.loadedResourcesContainer)).toMatchInlineSnapshot(
			`
			"Model     ⚠ 1  none selected · 0 providers · 0 models · /model · /providers
			Features  ✓ 1  plan-mode · /harness
			Harness   ✓ 3  on: .agents, root .mcp.json, Pi · off: Claude Code, Codex, Cursor · /harness
			⚠ needs action  ✓ ready · (ctrl+o to toggle details)"
		`,
		);
	});

	test("strips index.js from local extension label, showing parent dir", () => {
		const features: FeatureFixture[] = [
			{
				path: "/tmp/extensions/plan-mode/index.js",
				sourceInfo: createSourceInfo("/tmp/extensions/plan-mode/index.js", {
					source: "local",
					scope: "project",
					origin: "top-level",
					baseDir: "/tmp/extensions",
				}),
			},
		];

		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			features,
			useRealScopeGroups: true,
		});

		loadedResources.showLoadedResources(createFakeHost(fakeThis), {
			force: false,
		});

		expect(normalizeRenderedOutput(fakeThis.loadedResourcesContainer)).toMatchInlineSnapshot(
			`
			"Model     ⚠ 1  none selected · 0 providers · 0 models · /model · /providers
			Features  ✓ 1  plan-mode · /harness
			Harness   ✓ 3  on: .agents, root .mcp.json, Pi · off: Claude Code, Codex, Cursor · /harness
			⚠ needs action  ✓ ready · (ctrl+o to toggle details)"
		`,
		);
	});

	test("mixed single-file and subdirectory index.ts extensions strip index.ts", () => {
		const features: FeatureFixture[] = [
			{
				path: "/tmp/extensions/webfetch.ts",
				sourceInfo: createSourceInfo("/tmp/extensions/webfetch.ts", {
					source: "local",
					scope: "project",
					origin: "top-level",
					baseDir: "/tmp/extensions",
				}),
			},
			{
				path: "/tmp/extensions/plan-mode/index.ts",
				sourceInfo: createSourceInfo("/tmp/extensions/plan-mode/index.ts", {
					source: "local",
					scope: "project",
					origin: "top-level",
					baseDir: "/tmp/extensions",
				}),
			},
		];

		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			features,
			useRealScopeGroups: true,
		});

		loadedResources.showLoadedResources(createFakeHost(fakeThis), {
			force: false,
		});

		expect(normalizeRenderedOutput(fakeThis.loadedResourcesContainer)).toMatchInlineSnapshot(
			`
			"Model     ⚠ 1  none selected · 0 providers · 0 models · /model · /providers
			Features  ✓ 2  plan-mode, webfetch.ts · /harness
			Harness   ✓ 3  on: .agents, root .mcp.json, Pi · off: Claude Code, Codex, Cursor · /harness
			⚠ needs action  ✓ ready · (ctrl+o to toggle details)"
		`,
		);
	});

	test("multiple index.ts with unique parent dirs need no disambiguation", () => {
		const features: FeatureFixture[] = [
			{
				path: "/tmp/extensions/foo/index.ts",
				sourceInfo: createSourceInfo("/tmp/extensions/foo/index.ts", {
					source: "local",
					scope: "project",
					origin: "top-level",
					baseDir: "/tmp/extensions",
				}),
			},
			{
				path: "/tmp/extensions/bar/index.ts",
				sourceInfo: createSourceInfo("/tmp/extensions/bar/index.ts", {
					source: "local",
					scope: "project",
					origin: "top-level",
					baseDir: "/tmp/extensions",
				}),
			},
		];

		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			features,
			useRealScopeGroups: true,
		});

		loadedResources.showLoadedResources(createFakeHost(fakeThis), {
			force: false,
		});

		expect(normalizeRenderedOutput(fakeThis.loadedResourcesContainer)).toMatchInlineSnapshot(
			`
			"Model     ⚠ 1  none selected · 0 providers · 0 models · /model · /providers
			Features  ✓ 2  bar, foo · /harness
			Harness   ✓ 3  on: .agents, root .mcp.json, Pi · off: Claude Code, Codex, Cursor · /harness
			⚠ needs action  ✓ ready · (ctrl+o to toggle details)"
		`,
		);
	});

	test("multiple index.ts with same parent dir name disambiguated with grandparent", () => {
		const features: FeatureFixture[] = [
			{
				path: "/tmp/alpha/tools/index.ts",
				sourceInfo: createSourceInfo("/tmp/alpha/tools/index.ts", {
					source: "cli",
					scope: "temporary",
					origin: "top-level",
					baseDir: "/tmp/alpha",
				}),
			},
			{
				path: "/tmp/beta/tools/index.ts",
				sourceInfo: createSourceInfo("/tmp/beta/tools/index.ts", {
					source: "cli",
					scope: "temporary",
					origin: "top-level",
					baseDir: "/tmp/beta",
				}),
			},
		];

		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			features,
			useRealScopeGroups: true,
		});

		loadedResources.showLoadedResources(createFakeHost(fakeThis), {
			force: false,
		});

		expect(normalizeRenderedOutput(fakeThis.loadedResourcesContainer)).toMatchInlineSnapshot(
			`
			"Model     ⚠ 1  none selected · 0 providers · 0 models · /model · /providers
			Features  ✓ 2  alpha/tools, beta/tools · /harness
			Harness   ✓ 3  on: .agents, root .mcp.json, Pi · off: Claude Code, Codex, Cursor · /harness
			⚠ needs action  ✓ ready · (ctrl+o to toggle details)"
		`,
		);
	});

	test("non-index file in subdirectory stays as filename", () => {
		const features: FeatureFixture[] = [
			{
				path: "/tmp/extensions/my-ext/main.ts",
				sourceInfo: createSourceInfo("/tmp/extensions/my-ext/main.ts", {
					source: "local",
					scope: "project",
					origin: "top-level",
					baseDir: "/tmp/extensions",
				}),
			},
		];

		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			features,
			useRealScopeGroups: true,
		});

		loadedResources.showLoadedResources(createFakeHost(fakeThis), {
			force: false,
		});

		expect(normalizeRenderedOutput(fakeThis.loadedResourcesContainer)).toMatchInlineSnapshot(
			`
			"Model     ⚠ 1  none selected · 0 providers · 0 models · /model · /providers
			Features  ✓ 1  main.ts · /harness
			Harness   ✓ 3  on: .agents, root .mcp.json, Pi · off: Claude Code, Codex, Cursor · /harness
			⚠ needs action  ✓ ready · (ctrl+o to toggle details)"
		`,
		);
	});

	test("package extensions still strip index.ts correctly (regression guard)", () => {
		const features: FeatureFixture[] = [
			{
				path: "/tmp/project/.octocode/npm/node_modules/pi-markdown-preview/extensions/index.ts",
				sourceInfo: createSourceInfo(
					"/tmp/project/.octocode/npm/node_modules/pi-markdown-preview/extensions/index.ts",
					{
						source: "npm:pi-markdown-preview",
						scope: "project",
						origin: "package",
						baseDir: "/tmp/project/.octocode/npm/node_modules/pi-markdown-preview",
					},
				),
			},
		];

		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			features,
			useRealScopeGroups: true,
		});

		loadedResources.showLoadedResources(createFakeHost(fakeThis), {
			force: false,
		});

		expect(normalizeRenderedOutput(fakeThis.loadedResourcesContainer)).toMatchInlineSnapshot(
			`
			"Model     ⚠ 1  none selected · 0 providers · 0 models · /model · /providers
			Features  ✓ 1  pi-markdown-preview · /harness
			Harness   ✓ 3  on: .agents, root .mcp.json, Pi · off: Claude Code, Codex, Cursor · /harness
			⚠ needs action  ✓ ready · (ctrl+o to toggle details)"
		`,
		);
	});

	test("labels npm sibling extensions relative to the declaring package", () => {
		const features: FeatureFixture[] = [
			{
				path: "/tmp/project/.octocode/npm/node_modules/primary-package/index.ts",
				sourceInfo: createSourceInfo("/tmp/project/.octocode/npm/node_modules/primary-package/index.ts", {
					source: "npm:primary-package",
					scope: "project",
					origin: "package",
					baseDir: "/tmp/project/.octocode/npm/node_modules/primary-package",
				}),
			},
			{
				path: "/tmp/project/.octocode/npm/node_modules/sibling-package/index.ts",
				sourceInfo: createSourceInfo("/tmp/project/.octocode/npm/node_modules/sibling-package/index.ts", {
					source: "npm:primary-package",
					scope: "project",
					origin: "package",
					baseDir: "/tmp/project/.octocode/npm/node_modules/primary-package",
				}),
			},
		];

		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			features,
			useRealScopeGroups: true,
		});

		loadedResources.showLoadedResources(createFakeHost(fakeThis), {
			force: false,
		});

		expect(normalizeRenderedOutput(fakeThis.loadedResourcesContainer)).toMatchInlineSnapshot(
			`
			"Model     ⚠ 1  none selected · 0 providers · 0 models · /model · /providers
			Features  ✓ 2  primary-package, primary-package:../sibling-package · /harness
			Harness   ✓ 3  on: .agents, root .mcp.json, Pi · off: Claude Code, Codex, Cursor · /harness
			⚠ needs action  ✓ ready · (ctrl+o to toggle details)"
		`,
		);
	});

	test("labels Windows npm sibling extensions relative to the declaring package", () => {
		const primaryPath = "C:\\Users\\me\\.pi\\agent\\npm\\node_modules\\primary-package\\index.ts";
		const siblingPath = "C:\\Users\\me\\.pi\\agent\\npm\\node_modules\\sibling-package\\index.ts";
		const baseDir = "C:\\Users\\me\\.pi\\agent\\npm\\node_modules\\primary-package";
		const features: FeatureFixture[] = [
			{
				path: primaryPath,
				sourceInfo: createSourceInfo(primaryPath, {
					source: "npm:primary-package",
					scope: "user",
					origin: "package",
					baseDir,
				}),
			},
			{
				path: siblingPath,
				sourceInfo: createSourceInfo(siblingPath, {
					source: "npm:primary-package",
					scope: "user",
					origin: "package",
					baseDir,
				}),
			},
		];

		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			features,
			useRealScopeGroups: true,
		});

		loadedResources.showLoadedResources(createFakeHost(fakeThis), {
			force: false,
		});

		expect(normalizeRenderedOutput(fakeThis.loadedResourcesContainer)).toMatchInlineSnapshot(
			`
			"Model     ⚠ 1  none selected · 0 providers · 0 models · /model · /providers
			Features  ✓ 2  primary-package, primary-package:../sibling-package · /harness
			Harness   ✓ 3  on: .agents, root .mcp.json, Pi · off: Claude Code, Codex, Cursor · /harness
			⚠ needs action  ✓ ready · (ctrl+o to toggle details)"
		`,
		);
	});

	test("captures mixed extension layouts in expanded output", () => {
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			toolsExpanded: true,
			features: createFeatureFixtures(),
			useRealScopeGroups: true,
		});

		loadedResources.showLoadedResources(createFakeHost(fakeThis), {
			force: false,
		});

		expect(normalizeRenderedOutput(fakeThis.loadedResourcesContainer)).toMatchInlineSnapshot(`
			"Model     ⚠ 1  none selected · 0 providers · 0 models · /model · /providers

			Features  ✓ 8  /harness
			               project
			                 /tmp/project/.octocode/extensions/answer.ts
			                 /tmp/project/.octocode/extensions/local-index
			                 git:github.com/HazAT/pi-interactive-subagents
			                   extensions
			                   extensions/subagents
			                 npm:@scope/pi-scoped
			                   extensions
			                 npm:pi-markdown-preview
			                   extensions
			               user
			                 /tmp/agent/extensions/user-index
			               path
			                 /tmp/temp/cli-extension.ts
			Harness   ✓ 3  on: .agents, root .mcp.json, Pi · off: Claude Code, Codex, Cursor · /harness
			⚠ needs action  ✓ ready · (ctrl+o to toggle details)"
		`);
	});

	test("shows context paths relative to cwd while preserving full external paths", () => {
		const home = homedir();
		const cwd = path.join(home, "Development", "octocodecode");
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			cwd,
			contextFiles: [
				{ path: path.join(home, ".octocode", "agent", "AGENTS.md") },
				{ path: path.join(cwd, "AGENTS.md") },
			],
		});

		loadedResources.showLoadedResources(createFakeHost(fakeThis), {
			force: false,
		});

		const output = renderAll(fakeThis.loadedResourcesContainer).replace(/\\/g, "/");
		expect(output).toMatch(/^Context\s+✓ \d/m);
		expect(output).toContain("0/5.0k chars");
		expect(output).not.toContain(`${cwd.replace(/\\/g, "/")}/AGENTS.md`);
	});

	test("shows system prompt context paths before project context files", () => {
		const cwd = "/tmp/project";
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			cwd,
			systemPromptSource: { path: path.join(cwd, ".octocode", "SYSTEM.md") },
			appendSystemPromptSources: [{ path: path.join(cwd, ".octocode", "APPEND_SYSTEM.md") }],
			contextFiles: [{ path: path.join(cwd, "AGENTS.md") }],
		});

		loadedResources.showLoadedResources(createFakeHost(fakeThis), {
			force: false,
		});

		const output = renderAll(fakeThis.loadedResourcesContainer).replace(/\\/g, "/");
		expect(output).toMatch(/^Context\s+✓ \d/m);
		expect(output).toContain("0/5.0k chars");
	});

	test("shows full context paths when expanded", () => {
		const home = homedir();
		const cwd = path.join(home, "Development", "octocodecode");
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			toolsExpanded: true,
			cwd,
			contextFiles: [
				{ path: path.join(home, ".octocode", "agent", "AGENTS.md") },
				{ path: path.join(cwd, "AGENTS.md") },
			],
		});

		loadedResources.showLoadedResources(createFakeHost(fakeThis), {
			force: false,
		});

		const output = renderAll(fakeThis.loadedResourcesContainer).replace(/\\/g, "/");
		expect(output).toMatch(/^Context\s+✓ \d/m);
		expect(output).toContain("~/.octocode/agent/AGENTS.md");
		expect(output).toContain("~/Development/octocodecode/AGENTS.md");
		expect(output).toContain("project");
	});

	test("hints ctrl+o to expand while the listing is collapsed, and not once it is expanded", () => {
		const original = getKeybindings();
		setKeybindings(new KeybindingsManager());
		onTestFinished(() => setKeybindings(original));
		const contextFiles = [{ path: path.join(homedir(), ".octocode", "agent", "AGENTS.md") }];
		const collapsed = createShowLoadedResourcesThis({ quietStartup: false, contextFiles });
		loadedResources.showLoadedResources(createFakeHost(collapsed), { force: true });
		expect(renderAll(collapsed.loadedResourcesContainer)).toMatch(/ctrl\+o to toggle details/);
		const expanded = createShowLoadedResourcesThis({ quietStartup: false, contextFiles, toolsExpanded: true });
		loadedResources.showLoadedResources(createFakeHost(expanded), { force: true });
		expect(renderAll(expanded.loadedResourcesContainer)).not.toContain("to expand");
		// Toggling the transcript expansion updates the hint in place.
		for (const child of collapsed.loadedResourcesContainer.children)
			(child as { setExpanded?(expanded: boolean): void }).setExpanded?.(true);
		expect(renderAll(collapsed.loadedResourcesContainer)).not.toContain("to expand");
	});

	test("lists a Pi extension that is not loaded once, without the extension issues block", () => {
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			featureWarnings: [
				{ path: "/tmp/.pi/agent/extensions/legacy.ts", warning: "Pi extension, not loaded.", listedInContext: true },
			],
		});
		loadedResources.showLoadedResources(createFakeHost(fakeThis), { force: true });
		expect(renderAll(fakeThis.loadedResourcesContainer)).not.toContain("Feature issues");
		const other = createShowLoadedResourcesThis({
			quietStartup: false,
			featureWarnings: [{ path: "/tmp/pkg/ext.ts", warning: "Ignored extension shipped by package." }],
		});
		loadedResources.showLoadedResources(createFakeHost(other), { force: true });
		expect(renderAll(other.loadedResourcesContainer)).toContain("Feature issues");
	});

	test("does not show verbose listing on quiet startup during reload", () => {
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: true,
			skills: [{ filePath: "/tmp/skill/SKILL.md", name: "commit" }],
		});

		loadedResources.showLoadedResources(createFakeHost(fakeThis), {
			features: [{ path: "/tmp/ext/index.ts" }],
			force: false,
			showDiagnosticsWhenQuiet: true,
		});

		expect(fakeThis.loadedResourcesContainer.children).toHaveLength(0);
	});

	test("hides resource listing but keeps the startup header with header-only quiet startup", () => {
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: "header",
			skills: [{ filePath: "/tmp/skill/SKILL.md", name: "commit" }],
		});

		loadedResources.showLoadedResources(createFakeHost(fakeThis), {
			force: false,
		});

		expect(fakeThis.loadedResourcesContainer.children).toHaveLength(0);
		expect(display.shouldShowStartupHeader(createFakeHost(fakeThis))).toBe(true);
		expect(display.shouldShowStartupDetails(createFakeHost(fakeThis))).toBe(false);
	});

	test("hides the startup header with full quiet startup unless verbose", () => {
		const quiet = createShowLoadedResourcesThis({ quietStartup: true });
		expect(display.shouldShowStartupHeader(createFakeHost(quiet))).toBe(false);
		const verbose = createShowLoadedResourcesThis({ quietStartup: "header", verbose: true });
		expect(display.shouldShowStartupDetails(createFakeHost(verbose))).toBe(true);
	});

	test("folds duplicate-skill collisions into one warning line that wraps whole at narrow widths", () => {
		const collision = (name: string) => ({
			type: "collision" as const,
			message: `name "${name}" collision`,
			collision: {
				resourceType: "skill" as const,
				name,
				winnerPath: `/a/${name}/SKILL.md`,
				loserPath: `/b/${name}/SKILL.md`,
			},
		});
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			skills: [{ filePath: "/tmp/skill/SKILL.md", name: "commit" }],
			skillDiagnostics: [collision("commit"), collision("review"), collision("deploy")],
		});

		loadedResources.showLoadedResources(createFakeHost(fakeThis), { force: false });

		const wide = normalizeRenderedOutput(fakeThis.loadedResourcesContainer, 120);
		// One line says what was skipped, where the winner loads from and how to list them.
		expect(wide).toMatch(/^⚠ 3 duplicate skills skipped, kept \/a \(ctrl\+o lists\)$/m);
		expect(wide).not.toContain("Skill conflicts");
		const narrow = normalizeRenderedOutput(fakeThis.loadedResourcesContainer, 40).split("\n");
		const start = narrow.findIndex((line) => line.startsWith("⚠ 3 duplicate skills"));
		expect(start).toBeGreaterThan(0);
		const wrapped = narrow.slice(start).filter((line) => line.length > 0);
		expect(wrapped.length).toBeGreaterThan(1);
		expect(wrapped.every((line) => line.length <= 40)).toBe(true);
		expect(wrapped.join(" ").replace(/\s+/g, " ")).toContain("(ctrl+o lists)");
	});

	test("separates its blocks by one blank line and leaves the gap after it to what follows", () => {
		const collision = {
			type: "collision" as const,
			message: 'name "commit" collision',
			collision: {
				resourceType: "skill" as const,
				name: "commit",
				winnerPath: "/a/commit/SKILL.md",
				loserPath: "/b/commit/SKILL.md",
			},
		};
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			skills: [{ filePath: "/tmp/skill/SKILL.md", name: "commit" }],
			skillDiagnostics: [collision],
		});

		loadedResources.showLoadedResources(createFakeHost(fakeThis), { force: false });

		// Untrimmed: the transcript and the editor each open with their own blank line.
		const lines = renderAll(fakeThis.loadedResourcesContainer)
			.split("\n")
			.map((line) => line.trimEnd());
		const heading = lines.findIndex((line) => line.startsWith("⚠ 1 duplicate skill skipped"));
		expect(heading).toBeGreaterThan(0);
		expect(lines[heading - 1]).toBe("");
		expect(lines.at(-1)).not.toBe("");
		expect(lines.some((line, index) => line === "" && lines[index + 1] === "")).toBe(false);
	});

	test("still shows diagnostics on quiet startup when requested", () => {
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: true,
			skills: [{ filePath: "/tmp/skill/SKILL.md", name: "commit" }],
			skillDiagnostics: [{ type: "warning", message: "duplicate skill name" }],
		});

		loadedResources.showLoadedResources(createFakeHost(fakeThis), {
			force: false,
			showDiagnosticsWhenQuiet: true,
		});

		const output = renderAll(fakeThis.loadedResourcesContainer);
		expect(output).toContain("⚠ 1 skill file with problems");
		expect(output).not.toMatch(/^Skills\s/m);
	});

	test("strips terminal controls from resource names, paths and diagnostics", () => {
		// File names, skill frontmatter and package data are untrusted: none may reach the terminal as a control sequence.
		const osc = "\u001b]0;pwned\u0007";
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			toolsExpanded: true,
			useRealScopeGroups: true,
			contextFiles: [{ path: `/tmp/project/${osc}AGENTS.md` }],
			skills: [{ filePath: `/tmp/skills/${osc}one/SKILL.md`, name: "one" }],
			features: [{ path: `/tmp/extensions/${osc}ext.ts` }],
			skillDiagnostics: [
				{
					type: "collision",
					message: "collision",
					collision: {
						resourceType: "skill",
						name: `dup${osc}`,
						winnerPath: `/tmp/a/${osc}SKILL.md`,
						loserPath: "/tmp/b/SKILL.md",
					},
				} as never,
				{ type: "error", message: "bad \u001b[2J\u009b31mname", path: `/tmp/c/${osc}SKILL.md` } as never,
			],
		});
		fakeThis.session.promptTemplates = [{ name: `fix\u001b[2J`, filePath: "/tmp/prompts/fix.md" }];
		fakeThis.formatDiagnostics = (...args: [never, never]) =>
			resourceGroups.formatDiagnostics(createFakeHost(fakeThis), ...args);

		loadedResources.showLoadedResources(createFakeHost(fakeThis), { force: true });

		const output = renderAll(fakeThis.loadedResourcesContainer);
		expect(output).toContain("AGENTS.md");
		expect(output).toContain("dup: /tmp/b/SKILL.md");
		expect(output).toContain("bad name");
		expect(output).toContain("/fix");
		expect(output).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/);
	});
});

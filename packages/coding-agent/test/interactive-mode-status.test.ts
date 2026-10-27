import { homedir } from "node:os";
import * as path from "node:path";
import { type AutocompleteProvider, CombinedAutocompleteProvider } from "@octocodeai/octocode-tui";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { type Component, Container, type Focusable, type TUI } from "../../tui/src/tui.ts";
import { TuiMainScreen } from "../../tui/src/tui-main-screen.ts";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import type { AutocompleteProviderFactory } from "../src/core/extensions/types.ts";
import { createEventBus, type EventBus } from "../src/core/event-bus.ts";
import { setMcpSessionStatus } from "../../mcp/src/status.ts";
import type { QuietStartup } from "../src/core/settings-manager.ts";
import type { SourceInfo } from "../src/core/source-info.ts";
import type { AuthSelectorProvider } from "../src/modes/interactive/components/oauth-selector.ts";
import * as autocomplete from "../src/modes/interactive/interactive-mode/autocomplete.ts";
import * as display from "../src/modes/interactive/interactive-mode/display.ts";
import * as extensionContext from "../src/modes/interactive/interactive-mode/extension-context.ts";
import * as extensionDialogs from "../src/modes/interactive/interactive-mode/extension-dialogs.ts";
import * as loadedResources from "../src/modes/interactive/interactive-mode/loaded-resources.ts";
import * as resourceGroups from "../src/modes/interactive/interactive-mode/resource-groups.ts";
import * as resourcePaths from "../src/modes/interactive/interactive-mode/resource-paths.ts";
import * as statusIndicators from "../src/modes/interactive/interactive-mode/status-indicators.ts";
import * as viewState from "../src/modes/interactive/interactive-mode/view-state.ts";
import { initTheme } from "../src/theme/theme.ts";
import type { ToolStatus } from "../src/utils/tools-manager.ts";
import { createFakeHost } from "./interactive-mode-host.ts";

function renderLastLine(container: Container, width = 120): string {
	const last = container.children[container.children.length - 1];
	if (!last) return "";
	return last.render(width).join("\n");
}

function renderAll(container: Container, width = 120): string {
	return container.children.flatMap((child) => child.render(width)).join("\n");
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

type ExtensionFixture = {
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
});

describe("InteractiveMode.showManagedToolStatus", () => {
	beforeAll(() => initTheme("dark"));

	test("renders tool updates as one contiguous group", () => {
		const fakeThis: any = {
			chatContainer: new Container(),
			ui: { requestRender: vi.fn() },
			managedToolStatusStarted: false,
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
		const footerDataProvider = { setExtensionStatus: vi.fn() };
		const fakeThis: any = {
			toolOutputExpanded: false,
			customHeader: undefined,
			builtInHeader: header,
			loadedResourcesContainer: { children: [loadedResourcesChild] },
			chatContainer: { children: [chatChild] },
			footerDataProvider,
			ui: { requestRender: vi.fn() },
			showStatus: vi.fn(),
		};

		viewState.setToolsExpanded(createFakeHost(fakeThis), true);

		expect(fakeThis.toolOutputExpanded).toBe(true);
		expect(header.setExpanded).toHaveBeenCalledWith(true);
		expect(loadedResourcesChild.setExpanded).toHaveBeenCalledWith(true);
		expect(chatChild.setExpanded).toHaveBeenCalledWith(true);
		// The acknowledgement is transient footer text, never a permanent chat line.
		expect(footerDataProvider.setExtensionStatus).toHaveBeenCalledWith("notice", "Tool output: expanded");
		expect(fakeThis.showStatus).not.toHaveBeenCalled();
	});

	test("clears the acknowledgement from the footer after a moment, and a newer one restarts the clock", () => {
		vi.useFakeTimers();
		try {
			const statuses = new Map<string, string>();
			const fakeThis: any = {
				toolOutputExpanded: false,
				builtInHeader: undefined,
				loadedResourcesContainer: { children: [] },
				chatContainer: { children: [] },
				footerDataProvider: {
					setExtensionStatus: (key: string, text: string | undefined) =>
						text === undefined ? statuses.delete(key) : statuses.set(key, text),
				},
				ui: { requestRender: vi.fn() },
			};
			const host = createFakeHost(fakeThis);

			viewState.setToolsExpanded(host, true);
			vi.advanceTimersByTime(1500);
			viewState.setToolsExpanded(host, false);
			vi.advanceTimersByTime(1500);
			expect(statuses.get("notice")).toBe("Tool output: collapsed");
			vi.advanceTimersByTime(600);
			expect(statuses.has("notice")).toBe(false);
			expect(fakeThis.chatContainer.children).toEqual([]);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("InteractiveMode.createExtensionUIContext setTheme", () => {
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

		const uiContext = extensionContext.createExtensionUIContext(createFakeHost(fakeThis));
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

		const uiContext = extensionContext.createExtensionUIContext(createFakeHost(fakeThis));
		const result = uiContext.setTheme("__missing_theme__");

		expect(result.success).toBe(false);
		expect(fakeThis.themeController.setThemeName).toHaveBeenCalledWith("__missing_theme__");
		expect(settingsManager.setTheme).not.toHaveBeenCalled();
		expect(fakeThis.ui.requestRender).not.toHaveBeenCalled();
	});
});

describe("InteractiveMode.showExtensionCustom", () => {
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
			disposeActiveSelector: vi.fn(),
		};
		const showExtensionCustom = <T>(
			factory: (tui: TUI, theme: unknown, keybindings: unknown, done: (result: T) => void) => Component,
			options?: { overlay?: boolean },
		): Promise<T> => extensionDialogs.showExtensionCustom(createFakeHost(fakeThis), factory, options);

		editorContainer.addChild(editor);
		ui.addChild(editorContainer);
		ui.addChild(palette);
		ui.setFocus(palette);
		ui.start();
		try {
			const overlayPromise = showExtensionCustom<string>(
				(_tui, _theme, _keybindings, done) => {
					closeOverlay = done;
					return overlay;
				},
				{ overlay: true },
			);
			await flushTui(ui, terminal);
			expect(overlay.focused).toBe(true);

			const replacementPromise = showExtensionCustom<string>((_tui, _theme, _keybindings, done) => {
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

	// Regression test for #10648: closing a lower overlay removed the topmost overlay instead.
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
			const showExtensionCustom = <T>(
				factory: (tui: TUI, theme: unknown, keybindings: unknown, done: (result: T) => void) => Component,
				options?: { overlay?: boolean; overlayOptions?: { nonCapturing?: boolean } },
			): Promise<T> => extensionDialogs.showExtensionCustom(createFakeHost(fakeThis), factory, options);

			editorContainer.addChild(editor);
			ui.addChild(editorContainer);
			ui.setFocus(editor);
			ui.start();
			try {
				const lowerPromise = showExtensionCustom<string>(
					(_tui, _theme, _keybindings, done) => {
						closeLower = done;
						return lower;
					},
					{ overlay: true, overlayOptions: { nonCapturing } },
				);
				await flushTui(ui, terminal);
				const upperPromise = showExtensionCustom<string>(
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

describe("InteractiveMode.createExtensionUIContext addAutocompleteProvider", () => {
	test("stores wrapper factories and rebuilds autocomplete immediately", () => {
		const wrapper: AutocompleteProviderFactory = (current) => current;
		const fakeThis = {
			autocompleteProviderWrappers: [] as AutocompleteProviderFactory[],
			setupAutocompleteProvider: vi.fn(),
		};

		const uiContext = extensionContext.createExtensionUIContext(createFakeHost(fakeThis));
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
				extensionRunner: { getRegisteredCommands: () => [] };
				resourceLoader: { getSkills: () => { skills: [] } };
			};
			settingsManager: { getEnableSkillCommands: () => boolean };
			skillCommands: Map<string, string>;
			sessionManager: { getCwd: () => string };
			fdPath: null;
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
				extensionRunner: { getRegisteredCommands: () => [] },
				resourceLoader: { getSkills: () => ({ skills: [] }) },
			},
			settingsManager: { getEnableSkillCommands: () => false },
			skillCommands: new Map(),
			sessionManager: { getCwd: () => "/tmp" },
			fdPath: null,
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

	test.each(["providers", "login"])(
		"matches /%s arguments by provider id, name and Pi configuration",
		async (command) => {
			type FakeInteractiveMode = {
				session: {
					scopedModels: [];
					modelRuntime: { getAvailableSnapshot: () => [] };
					promptTemplates: [];
					extensionRunner: { getRegisteredCommands: () => [] };
					resourceLoader: { getSkills: () => { skills: [] } };
				};
				settingsManager: { getEnableSkillCommands: () => boolean };
				skillCommands: Map<string, string>;
				sessionManager: { getCwd: () => string };
				fdPath: null;
				getLoginProviderOptions: () => AuthSelectorProvider[];
			};

			const fakeThis: FakeInteractiveMode = {
				session: {
					scopedModels: [],
					modelRuntime: { getAvailableSnapshot: () => [] },
					promptTemplates: [],
					extensionRunner: { getRegisteredCommands: () => [] },
					resourceLoader: { getSkills: () => ({ skills: [] }) },
				},
				settingsManager: { getEnableSkillCommands: () => false },
				skillCommands: new Map(),
				sessionManager: { getCwd: () => "/tmp" },
				fdPath: null,
				getLoginProviderOptions: () => [
					{ id: "anthropic", name: "Anthropic", authType: "oauth", subscription: true },
					{ id: "anthropic", name: "Anthropic", authType: "api_key", subscription: true },
					{ id: "openai", name: "OpenAI", authType: "api_key" },
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
		},
	);
});
describe("InteractiveMode.showLoadedResources", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	function createShowLoadedResourcesThis(options: {
		quietStartup: QuietStartup;
		verbose?: boolean;
		toolOutputExpanded?: boolean;
		cwd?: string;
		contextFiles?: Array<{ path: string; content?: string }>;
		systemPromptSource?: { path: string };
		appendSystemPromptSources?: Array<{ path: string }>;
		extensions?: ExtensionFixture[];
		skills?: Array<{ filePath: string; name: string }>;
		skillDiagnostics?: Array<{ type: "warning" | "error" | "collision"; message: string }>;
		useRealScopeGroups?: boolean;
		events?: EventBus;
	}) {
		const fakeThis: any = {
			options: { verbose: options.verbose ?? false },
			toolOutputExpanded: options.toolOutputExpanded ?? false,
			loadedResourcesContainer: new Container(),
			chatContainer: new Container(),
			settingsManager: {
				getQuietStartup: () => options.quietStartup,
			},
			sessionManager: {
				getCwd: () => options.cwd ?? "/tmp/project",
			},
			session: {
				promptTemplates: [],
				extensionRunner: {
					getCommandDiagnostics: () => [],
					getShortcutDiagnostics: () => [],
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
					getExtensions: () => ({ extensions: options.extensions ?? [], errors: [], runtime: {} }),
					getThemes: () => ({ themes: [], diagnostics: [] }),
				},
			},
			formatDisplayPath: (p: string) => resourcePaths.formatDisplayPath(p),
			formatExtensionDisplayPath: (p: string) => resourcePaths.formatExtensionDisplayPath(createFakeHost(fakeThis), p),
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
			getCompactExtensionLabel: (p: string, sourceInfo?: SourceInfo) =>
				resourcePaths.getCompactExtensionLabel(createFakeHost(fakeThis), p, sourceInfo),
			getCompactDisplayPathSegments: (p: string) =>
				resourcePaths.getCompactDisplayPathSegments(createFakeHost(fakeThis), p),
			getCompactNonPackageExtensionLabel: (
				p: string,
				index: number,
				allPaths: Array<{ path: string; segments: string[] }>,
			) => resourcePaths.getCompactNonPackageExtensionLabel(createFakeHost(fakeThis), p, index, allPaths),
			getCompactExtensionLabels: (extensions: ExtensionFixture[]) =>
				resourcePaths.getCompactExtensionLabels(createFakeHost(fakeThis), extensions),
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

	function createExtensionFixtures(): ExtensionFixture[] {
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

	test("shows a compact resource listing by default", () => {
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			skills: [{ filePath: "/tmp/skill/SKILL.md", name: "commit" }],
		});

		loadedResources.showLoadedResources(createFakeHost(fakeThis), {
			force: false,
		});

		const output = renderAll(fakeThis.loadedResourcesContainer);
		expect(output).toContain("[Skills]");
		// Names are for ctrl+o: collapsed, the section is one count line.
		expect(output).toMatch(/1 loaded \(.* ?to list\)/);
		expect(output).not.toContain("commit");
		expect(output).not.toContain("resource-list");
	});

	test("shows full resource listing when expanded", () => {
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			toolOutputExpanded: true,
			skills: [{ filePath: "/tmp/skill/SKILL.md", name: "commit" }],
		});

		loadedResources.showLoadedResources(createFakeHost(fakeThis), {
			force: false,
		});

		const output = renderAll(fakeThis.loadedResourcesContainer);
		expect(output).toContain("[Skills]");
		expect(output).toContain("resource-list");
		expect(output).not.toContain("commit");
	});

	test("shows full resource listing on verbose startup even when tool output is collapsed", () => {
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: true,
			verbose: true,
			toolOutputExpanded: false,
			skills: [{ filePath: "/tmp/skill/SKILL.md", name: "commit" }],
		});

		loadedResources.showLoadedResources(createFakeHost(fakeThis), {
			force: false,
		});

		const output = renderAll(fakeThis.loadedResourcesContainer);
		expect(output).toContain("[Skills]");
		expect(output).toContain("resource-list");
		expect(output).not.toContain("commit");
	});

	test("shows current MCP states after skills and refreshes without duplicate sections", () => {
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
		const render = () => {
			loadedResources.showLoadedResources(createFakeHost(fakeThis));
			return renderAll(fakeThis.loadedResourcesContainer);
		};
		const initial = render();
		expect(initial.indexOf("[Skills]")).toBeLessThan(initial.indexOf("[MCPs]"));
		expect(initial).toContain("octocode: connecting");
		expect(initial).toContain("docs: disabled");
		setMcpSessionStatus(events, [
			{ ...server, state: "connected", toolCount: 9 },
			{ ...server, name: "docs", enabled: false },
		]);
		const connected = render();
		expect(connected).toContain("octocode: connected");
		expect(connected).not.toContain("connecting");
		expect(connected.match(/\[MCPs\]/g)).toHaveLength(1);
	});

	test("abbreviates extensions in compact listing", () => {
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			extensions: [{ path: "/tmp/extensions/answer.ts" }, { path: "/tmp/extensions/btw.ts" }],
		});

		loadedResources.showLoadedResources(createFakeHost(fakeThis), {
			force: false,
		});

		const output = renderAll(fakeThis.loadedResourcesContainer);
		expect(output).toContain("[Extensions]");
		expect(output).toContain("answer.ts, btw.ts");
		expect(output).not.toContain("extensions/answer.ts");
	});

	test("captures mixed extension layouts in compact output", () => {
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			extensions: createExtensionFixtures(),
			useRealScopeGroups: true,
		});

		loadedResources.showLoadedResources(createFakeHost(fakeThis), {
			force: false,
		});

		expect(normalizeRenderedOutput(fakeThis.loadedResourcesContainer)).toMatchInlineSnapshot(`
"[Extensions]
  @scope/pi-scoped, answer.ts, cli-extension.ts, HazAT/pi-interactive-subagents, HazAT/pi-interactive-subagents:subagents, local-index, pi-markdown-preview, user-index"`);
	});

	test("adds more parent folders until local extension labels are unique", () => {
		const extensions: ExtensionFixture[] = [
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
			extensions,
			useRealScopeGroups: true,
		});

		loadedResources.showLoadedResources(createFakeHost(fakeThis), {
			force: false,
		});

		expect(normalizeRenderedOutput(fakeThis.loadedResourcesContainer)).toMatchInlineSnapshot(`
"[Extensions]
  alpha/one, beta/one, gamma/one"`);
	});

	test("strips index.ts from local extension label, showing parent dir", () => {
		const extensions: ExtensionFixture[] = [
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
			extensions,
			useRealScopeGroups: true,
		});

		loadedResources.showLoadedResources(createFakeHost(fakeThis), {
			force: false,
		});

		expect(normalizeRenderedOutput(fakeThis.loadedResourcesContainer)).toMatchInlineSnapshot(`
"[Extensions]
  plan-mode"`);
	});

	test("strips index.js from local extension label, showing parent dir", () => {
		const extensions: ExtensionFixture[] = [
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
			extensions,
			useRealScopeGroups: true,
		});

		loadedResources.showLoadedResources(createFakeHost(fakeThis), {
			force: false,
		});

		expect(normalizeRenderedOutput(fakeThis.loadedResourcesContainer)).toMatchInlineSnapshot(`
"[Extensions]
  plan-mode"`);
	});

	test("mixed single-file and subdirectory index.ts extensions strip index.ts", () => {
		const extensions: ExtensionFixture[] = [
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
			extensions,
			useRealScopeGroups: true,
		});

		loadedResources.showLoadedResources(createFakeHost(fakeThis), {
			force: false,
		});

		expect(normalizeRenderedOutput(fakeThis.loadedResourcesContainer)).toMatchInlineSnapshot(`
"[Extensions]
  plan-mode, webfetch.ts"`);
	});

	test("multiple index.ts with unique parent dirs need no disambiguation", () => {
		const extensions: ExtensionFixture[] = [
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
			extensions,
			useRealScopeGroups: true,
		});

		loadedResources.showLoadedResources(createFakeHost(fakeThis), {
			force: false,
		});

		expect(normalizeRenderedOutput(fakeThis.loadedResourcesContainer)).toMatchInlineSnapshot(`
"[Extensions]
  bar, foo"`);
	});

	test("multiple index.ts with same parent dir name disambiguated with grandparent", () => {
		const extensions: ExtensionFixture[] = [
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
			extensions,
			useRealScopeGroups: true,
		});

		loadedResources.showLoadedResources(createFakeHost(fakeThis), {
			force: false,
		});

		expect(normalizeRenderedOutput(fakeThis.loadedResourcesContainer)).toMatchInlineSnapshot(`
"[Extensions]
  alpha/tools, beta/tools"`);
	});

	test("non-index file in subdirectory stays as filename", () => {
		const extensions: ExtensionFixture[] = [
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
			extensions,
			useRealScopeGroups: true,
		});

		loadedResources.showLoadedResources(createFakeHost(fakeThis), {
			force: false,
		});

		expect(normalizeRenderedOutput(fakeThis.loadedResourcesContainer)).toMatchInlineSnapshot(`
"[Extensions]
  main.ts"`);
	});

	test("package extensions still strip index.ts correctly (regression guard)", () => {
		const extensions: ExtensionFixture[] = [
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
			extensions,
			useRealScopeGroups: true,
		});

		loadedResources.showLoadedResources(createFakeHost(fakeThis), {
			force: false,
		});

		expect(normalizeRenderedOutput(fakeThis.loadedResourcesContainer)).toMatchInlineSnapshot(`
"[Extensions]
  pi-markdown-preview"`);
	});

	test("labels npm sibling extensions relative to the declaring package", () => {
		const extensions: ExtensionFixture[] = [
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
			extensions,
			useRealScopeGroups: true,
		});

		loadedResources.showLoadedResources(createFakeHost(fakeThis), {
			force: false,
		});

		expect(normalizeRenderedOutput(fakeThis.loadedResourcesContainer)).toMatchInlineSnapshot(`
"[Extensions]
  primary-package, primary-package:../sibling-package"`);
	});

	test("labels Windows npm sibling extensions relative to the declaring package", () => {
		const primaryPath = "C:\\Users\\me\\.pi\\agent\\npm\\node_modules\\primary-package\\index.ts";
		const siblingPath = "C:\\Users\\me\\.pi\\agent\\npm\\node_modules\\sibling-package\\index.ts";
		const baseDir = "C:\\Users\\me\\.pi\\agent\\npm\\node_modules\\primary-package";
		const extensions: ExtensionFixture[] = [
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
			extensions,
			useRealScopeGroups: true,
		});

		loadedResources.showLoadedResources(createFakeHost(fakeThis), {
			force: false,
		});

		expect(normalizeRenderedOutput(fakeThis.loadedResourcesContainer)).toMatchInlineSnapshot(`
"[Extensions]
  primary-package, primary-package:../sibling-package"`);
	});

	test("captures mixed extension layouts in expanded output", () => {
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			toolOutputExpanded: true,
			extensions: createExtensionFixtures(),
			useRealScopeGroups: true,
		});

		loadedResources.showLoadedResources(createFakeHost(fakeThis), {
			force: false,
		});

		expect(normalizeRenderedOutput(fakeThis.loadedResourcesContainer)).toMatchInlineSnapshot(`
"[Extensions]
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
    /tmp/temp/cli-extension.ts"`);
	});

	test("shows context paths relative to cwd while preserving full external paths", () => {
		const home = homedir();
		const cwd = path.join(home, "Development", "pi-mono");
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
		expect(output).toContain("[Context]");
		expect(output).toContain("~/.octocode/agent/AGENTS.md, AGENTS.md");
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
		expect(output).toContain("[Context]");
		expect(output).toContain(".octocode/SYSTEM.md, .octocode/APPEND_SYSTEM.md, AGENTS.md");
	});

	test("shows full context paths when expanded", () => {
		const home = homedir();
		const cwd = path.join(home, "Development", "pi-mono");
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			toolOutputExpanded: true,
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
		expect(output).toContain("[Context]");
		expect(output).toContain("~/.octocode/agent/AGENTS.md");
		expect(output).toContain("~/Development/pi-mono/AGENTS.md");
		expect(output).not.toContain("~/.octocode/agent/AGENTS.md, AGENTS.md");
	});

	test("does not show verbose listing on quiet startup during reload", () => {
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: true,
			skills: [{ filePath: "/tmp/skill/SKILL.md", name: "commit" }],
		});

		loadedResources.showLoadedResources(createFakeHost(fakeThis), {
			extensions: [{ path: "/tmp/ext/index.ts" }],
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

	test("folds routine duplicate-skill collisions into one short line that wraps under its indent", () => {
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
		expect(wide).toMatch(/\[Skill conflicts\]\n {2}3 skills have duplicates; first found is used \(.*for paths\)/);
		const narrow = normalizeRenderedOutput(fakeThis.loadedResourcesContainer, 40).split("\n");
		const body = narrow.slice(narrow.indexOf("[Skill conflicts]") + 1).filter((line) => line.length > 0);
		expect(body.length).toBeGreaterThan(1);
		expect(body.every((line) => line.startsWith("  "))).toBe(true);
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
		expect(output).toContain("[Skill conflicts]");
		expect(output).not.toContain("[Skills]");
	});
});

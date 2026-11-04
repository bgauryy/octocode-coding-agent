import { Container, type TUI } from "@octocodeai/octocode-tui";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { addMessageToChat } from "../src/modes/interactive/interactive-mode/chat-messages.ts";
import { toggleThinkingBlockVisibility } from "../src/modes/interactive/interactive-mode/view-state.ts";
import { bindRender } from "../src/modes/interactive/state/bind-render.ts";
import { bindViewState } from "../src/modes/interactive/state/bind-view.ts";
import { createUiStore } from "../src/modes/interactive/state/store.ts";
import { initTheme } from "../src/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { createFakeHost } from "./interactive-mode-host.ts";

const rows = (container: Container) => container.render(100).map(stripAnsi);
const lines = Array.from({ length: 30 }, (_, i) => `line-${i}`).join("\n");

function setup() {
	const uiStore = createUiStore();
	const requestRender = vi.fn();
	const ui = { requestRender } as unknown as TUI;
	const chatContainer = new Container();
	const footerDataProvider = { setExtensionStatus: vi.fn() };
	const fake = {
		uiStore,
		ui,
		chatContainer,
		loadedResourcesContainer: new Container(),
		customHeader: undefined,
		builtInHeader: undefined,
		footerDataProvider,
		settingsManager: {
			setHideThinkingBlock: vi.fn(),
			getShowImages: () => false,
			getImageWidthCells: () => 60,
		},
		session: {},
		hiddenThinkingLabel: "Thinking…",
		outputPad: 1,
		streamingComponent: undefined,
		getMarkdownThemeWithSettings: () => undefined,
		getMarkdownTransformers: () => [],
	};
	const host = createFakeHost(fake);
	const unbindView = bindViewState(host);
	const unbindRender = bindRender(uiStore, ui);
	const unbind = () => {
		unbindView();
		unbindRender();
	};
	return { host, uiStore, requestRender, chatContainer, footerDataProvider, ui, unbind };
}

function bashTool(ui: TUI) {
	const tool = new ToolExecutionComponent(
		"bash",
		"t1",
		{ command: "seq 30" },
		{ showImages: false },
		undefined,
		ui,
		process.cwd(),
	);
	tool.markExecutionStarted();
	tool.updateResult({ content: [{ type: "text", text: lines }], isError: false }, false);
	return tool;
}

describe("interactive view store", () => {
	beforeAll(() => initTheme("dark"));
	afterEach(() => vi.useRealTimers());

	it("grows and shrinks tool output with one frame request per real change", () => {
		const { uiStore, requestRender, chatContainer } = setup();
		// The row's own frame requests go to a separate renderer so the binder's are counted alone.
		chatContainer.addChild(bashTool({ requestRender() {} } as unknown as TUI));
		const collapsed = rows(chatContainer).length;

		uiStore.getState().setToolsExpanded(true);
		const expanded = rows(chatContainer).length;
		expect(expanded).toBeGreaterThan(collapsed);
		// Two store changes: the expansion and its footer notice.
		expect(requestRender).toHaveBeenCalledTimes(2);

		uiStore.getState().setToolsExpanded(true);
		expect(requestRender).toHaveBeenCalledTimes(2);

		uiStore.getState().toggleToolsExpanded();
		expect(rows(chatContainer).length).toBe(collapsed);
		expect(requestRender).toHaveBeenCalledTimes(4);
	});

	it("renders rows added after the toggle in the current mode", () => {
		const { host, uiStore, chatContainer } = setup();
		const message = { role: "compactionSummary", summary: lines, tokensBefore: 1, timestamp: 1 } as never;
		addMessageToChat(host, message);
		const collapsed = rows(chatContainer).length;
		uiStore.getState().setToolsExpanded(true);
		addMessageToChat(host, message);
		const both = rows(chatContainer).length;
		expect(both - collapsed).toBeGreaterThan(collapsed);
	});

	it("shows the hidden-thinking label and persists the toggle", () => {
		const { host, chatContainer, requestRender, uiStore } = setup();
		const message = new AssistantMessageComponent(
			{ role: "assistant", content: [{ type: "thinking", thinking: "secret thought" }] } as never,
			false,
		);
		chatContainer.addChild(message);
		expect(rows(chatContainer).join("\n")).toContain("secret thought");

		toggleThinkingBlockVisibility(host);
		expect(uiStore.getState().view.hideThinking).toBe(true);
		expect(rows(chatContainer).join("\n")).not.toContain("secret thought");
		expect(rows(chatContainer).join("\n")).toContain("Reasoning");
		expect(host.settingsManager.setHideThinkingBlock).toHaveBeenCalledWith(true);
		// The hidden flag and its footer notice.
		expect(requestRender).toHaveBeenCalledTimes(2);

		uiStore.getState().setHideThinking(true);
		expect(requestRender).toHaveBeenCalledTimes(2);
	});

	it("mirrors the notice into the footer and clears it after the delay", () => {
		vi.useFakeTimers();
		const { uiStore, footerDataProvider } = setup();
		uiStore.getState().showNotice("hello", 100);
		expect(footerDataProvider.setExtensionStatus).toHaveBeenLastCalledWith("notice", "hello");
		vi.advanceTimersByTime(101);
		expect(footerDataProvider.setExtensionStatus).toHaveBeenLastCalledWith("notice", undefined);
		expect(uiStore.getState().view.notice).toBeUndefined();
	});

	it("stops following the store after unbind", () => {
		const { uiStore, requestRender, unbind } = setup();
		unbind();
		uiStore.getState().setToolsExpanded(true);
		expect(requestRender).not.toHaveBeenCalled();
	});
});

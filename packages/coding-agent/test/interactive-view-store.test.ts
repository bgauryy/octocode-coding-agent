import { Container, type TUI } from "@octocodeai/octocode-tui";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { addMessageToChat } from "../src/modes/interactive/interactive-mode/chat-messages.ts";
import { applicationRenderer } from "../src/modes/interactive/interactive-mode/application-events.ts";
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
		sessionManager: { getCwd: () => "/tmp" },
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
		// Two store changes (the expansion and its notice) and the notice's status line in the messages list.
		expect(requestRender).toHaveBeenCalledTimes(3);
		expect(rows(chatContainer).join("\n")).toContain("Output: expanded");

		uiStore.getState().setToolsExpanded(true);
		expect(requestRender).toHaveBeenCalledTimes(3);

		uiStore.getState().toggleToolsExpanded();
		// The tool row is back to its collapsed height; below it, one spacer and one status line, updated in place.
		expect(rows(chatContainer).length).toBe(collapsed + 2);
		expect(rows(chatContainer).join("\n")).toContain("Output: collapsed");
		expect(rows(chatContainer).join("\n")).not.toContain("Output: expanded");
		expect(requestRender).toHaveBeenCalledTimes(6);
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

	it("seeds resumed assistant rows from the current expansion state", () => {
		const { host, uiStore, chatContainer } = setup();
		uiStore.getState().setToolsExpanded(true);
		const text = Array.from({ length: 140 }, (_, i) => `line ${i}`).join("\n\n");
		addMessageToChat(host, { role: "assistant", content: [{ type: "text", text }], timestamp: 1 } as never);
		expect(rows(chatContainer).join("\n")).toContain("line 70");
		expect(rows(chatContainer).join("\n")).not.toContain("lines hidden");
	});

	it("seeds new live assistant rows from the current expansion state", () => {
		const { host, uiStore, chatContainer } = setup();
		uiStore.getState().setToolsExpanded(true);
		const text = Array.from({ length: 140 }, (_, i) => `line ${i}`).join("\n\n");
		const render = applicationRenderer(host, { readAsset: () => undefined } as never);
		render({ type: "message.started", message: { id: "live", role: "assistant", text, complete: false } } as never);
		expect(rows(chatContainer).join("\n")).toContain("line 70");
		expect(rows(chatContainer).join("\n")).not.toContain("lines hidden");
	});

	it("expands and recollapses assistant output through the view store", () => {
		const { uiStore, chatContainer } = setup();
		const text = Array.from({ length: 140 }, (_, i) => `line ${i}`).join("\n\n");
		const message = new AssistantMessageComponent({ role: "assistant", content: [{ type: "text", text }] } as never);
		chatContainer.addChild(message);
		expect(rows(chatContainer).join("\n")).toContain("lines hidden");
		uiStore.getState().toggleToolsExpanded();
		expect(rows(chatContainer).join("\n")).toContain("line 70");
		uiStore.getState().toggleToolsExpanded();
		expect(rows(chatContainer).join("\n")).toContain("lines hidden");
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
		// A hidden, finished block reads as a past event (assistant-message.ts: "Thought").
		expect(rows(chatContainer).join("\n")).toContain("Thought");
		expect(host.settingsManager.setHideThinkingBlock).toHaveBeenCalledWith(true);
		// The hidden flag, the notice in the store and its status line in the messages list.
		expect(requestRender).toHaveBeenCalledTimes(3);
		expect(rows(chatContainer).join("\n")).toContain("Thinking blocks: hidden");

		uiStore.getState().setHideThinking(true);
		expect(requestRender).toHaveBeenCalledTimes(3);
	});

	it("says each notice in the messages list, never in the footer, and a burst keeps one line", () => {
		const { uiStore, chatContainer, footerDataProvider } = setup();
		uiStore.getState().showNotice("hello");
		expect(rows(chatContainer).filter((row) => row.trim() === "hello")).toHaveLength(1);
		uiStore.getState().showNotice("hello");
		uiStore.getState().showNotice("world");
		const text = rows(chatContainer).join("\n");
		expect(text).toContain("world");
		// Back-to-back notices share the last status line: the latest replaces the earlier ones.
		expect(text).not.toContain("hello");
		expect(footerDataProvider.setExtensionStatus).not.toHaveBeenCalled();
	});

	it("starts a new line once something else reached the messages list", () => {
		const { uiStore, chatContainer } = setup();
		uiStore.getState().showNotice("first");
		chatContainer.addChild(new Container());
		uiStore.getState().showNotice("second");
		const text = rows(chatContainer).join("\n");
		expect(text).toContain("first");
		expect(text).toContain("second");
	});

	it("stops following the store after unbind", () => {
		const { uiStore, requestRender, unbind } = setup();
		unbind();
		uiStore.getState().setToolsExpanded(true);
		expect(requestRender).not.toHaveBeenCalled();
	});
});

import type { AssistantMessage } from "@octocodeai/octocode-ai";
import { Container, type TUI } from "@octocodeai/octocode-tui";
import { describe, expect, it, vi } from "vitest";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.ts";
import { bindViewState } from "../src/modes/interactive/state/bind-view.ts";
import { createUiStore } from "../src/modes/interactive/state/store.ts";
import { initTheme } from "../src/theme/theme.ts";
import { createFakeHost } from "./interactive-mode-host.ts";

function assistant(content: AssistantMessage["content"]): AssistantMessage {
	const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "gpt-4o-mini",
		usage: { ...zero, totalTokens: 0, cost: { ...zero, total: 0 } },
		stopReason: "stop",
		timestamp: 0,
	};
}

/** The view binder over a transcript holding `messages`; counts the frames it asks for. */
function viewHost(messages: AssistantMessage[]) {
	initTheme("dark");
	const chatContainer = new Container();
	for (const message of messages) chatContainer.addChild(new AssistantMessageComponent(message, false));
	const requestRender = vi.fn();
	const host = createFakeHost({
		uiStore: createUiStore(),
		ui: { requestRender } as unknown as TUI,
		chatContainer,
		loadedResourcesContainer: new Container(),
		pendingMessagesContainer: new Container(),
		builtInHeader: undefined,
		customHeader: undefined,
	});
	const stop = bindViewState(host);
	return { store: host.uiStore.getState(), requestRender, stop };
}

describe("frame requests", () => {
	it("toggling thinking visibility paints nothing without thinking rows and repaints with them", () => {
		const plain = viewHost([assistant([{ type: "text", text: "answer" }])]);
		plain.store.setHideThinking(true);
		plain.store.setHideThinking(false);
		expect(plain.requestRender).not.toHaveBeenCalled();
		plain.stop();

		const thinking = viewHost([
			assistant([
				{ type: "thinking", thinking: "weighing options" },
				{ type: "text", text: "answer" },
			]),
		]);
		thinking.store.setHideThinking(true);
		expect(thinking.requestRender).toHaveBeenCalledTimes(1);
		thinking.store.setHideThinking(false);
		expect(thinking.requestRender).toHaveBeenCalledTimes(2);
		thinking.stop();
	});

	it("requests no frame for the key timing nothing draws", () => {
		const { store: actions, requestRender, stop } = viewHost([]);

		actions.quietEscapes(1_000, true);
		actions.doubleEscape(2_000);
		actions.noteInterrupt(3_000);
		expect(requestRender).not.toHaveBeenCalled();

		// A notice is drawn by the view binder's status line, which asks for its own frame.
		actions.showNotice("Output: expanded");
		expect(requestRender).toHaveBeenCalledTimes(1);
		stop();
	});
});

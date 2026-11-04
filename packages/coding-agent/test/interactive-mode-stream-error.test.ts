import type { AgentMessage } from "@octocodeai/octocode-agent-core";
import type { AssistantMessage } from "@octocodeai/octocode-ai";
import { Container } from "@octocodeai/octocode-tui";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { AgentSession, AgentSessionEvent } from "../src/core/agent-session.ts";
import { getApplicationPort } from "../src/core/application/index.ts";
import { subscribeToAgent } from "../src/modes/interactive/interactive-mode/agent-events.ts";
import type { InteractiveModeHost } from "../src/modes/interactive/interactive-mode/host.ts";
import { getMarkdownTheme, initTheme } from "../src/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { createFakeHost } from "./interactive-mode-host.ts";
import { createUiStore } from "../src/modes/interactive/state/store.ts";

const sessions: AgentSession[] = [];
const PROVIDER_ERROR = "429 Too Many Requests: rate limited";

function failedToolCalls(stopReason: "error" | "aborted"): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{ type: "toolCall", id: "first", name: "first_tool", arguments: { path: "a.ts" } },
			{ type: "toolCall", id: "second", name: "second_tool", arguments: { path: "b.ts" } },
		],
		api: "openai-responses",
		provider: "openai",
		model: "test",
		stopReason,
		errorMessage: stopReason === "error" ? PROVIDER_ERROR : undefined,
		timestamp: 1,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

function fixture(messages: AgentMessage[] = []) {
	const listeners = new Set<(event: AgentSessionEvent) => void>();
	const session = {
		sessionId: `stream-error-${sessions.length}`,
		messages,
		isStreaming: false,
		getSteeringMessages: () => [],
		getFollowUpMessages: () => [],
		retryAttempt: 0,
		subscribe(listener: (event: AgentSessionEvent) => void) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		extensionRunner: { getMessageRenderer: () => undefined },
	} as unknown as AgentSession;
	sessions.push(session);
	const host = createFakeHost({
		session,
		chatContainer: new Container(),
		editor: {},
		isInitialized: true,
		getMarkdownTransformers: () => [],
		getMarkdownThemeWithSettings: getMarkdownTheme,
		hiddenThinkingLabel: "Thinking…",
		outputPad: 1,
		pendingTools: new Map(),
		entriesRenderedByRebuild: new Set<string>(),
		uiStore: createUiStore(),
		pendingMessagesContainer: new Container(),
		getAppKeyDisplay: () => "alt+up",
		ui: { requestRender() {} },
		settingsManager: { getShowImages: () => true, getImageWidthCells: () => 20, getShowCacheMissNotices: () => false },
		sessionManager: { getCwd: () => "/tmp", buildContextEntries: () => [] },
		getRegisteredToolDefinition: (): ReturnType<InteractiveModeHost["getRegisteredToolDefinition"]> => undefined,
		programStatus: { handleEvent() {} },
		maybeShowThinkingDropNotice() {},
		maybeShowCacheMissNotice() {},
		maybeShowInstallChangeWarning() {},
		maybeSuggestBugReport() {},
	});
	return {
		host,
		emit(event: AgentSessionEvent) {
			for (const listener of listeners) listener(event);
		},
		text: () => stripAnsi(host.chatContainer.render(100).join("\n")),
	};
}

const count = (text: string, needle: string) => text.split(needle).length - 1;

describe("tool rows of a failed model response", () => {
	beforeAll(() => initTheme("dark"));
	afterEach(() => {
		for (const session of sessions.splice(0)) getApplicationPort(session).dispose();
	});

	it("marks live pending tool rows as not run and shows the provider error once", () => {
		const { host, emit, text } = fixture();
		subscribeToAgent(host);
		const message = failedToolCalls("error");
		emit({ type: "message_start", message });
		emit({ type: "message_end", message });

		const output = text();
		expect(count(output, "Not run: the model response failed")).toBe(2);
		expect(count(output, PROVIDER_ERROR)).toBe(1);
		expect(host.pendingTools.size).toBe(0);
		host.unsubscribe?.();
	});

	it("marks restored tool rows of a failed response as not run and shows the provider error once", () => {
		const { host, text } = fixture();
		host.renderSessionItems([failedToolCalls("error")]);

		const output = text();
		expect(count(output, "Not run: the model response failed")).toBe(2);
		expect(count(output, PROVIDER_ERROR)).toBe(1);
	});

	it("keeps an abort's own text on the tool rows", () => {
		const live = fixture();
		subscribeToAgent(live.host);
		const message = failedToolCalls("aborted");
		live.emit({ type: "message_start", message });
		live.emit({ type: "message_end", message });
		expect(count(live.text(), "Operation interrupted")).toBe(2);
		expect(live.text()).not.toContain("Not run");
		live.host.unsubscribe?.();
	});
});

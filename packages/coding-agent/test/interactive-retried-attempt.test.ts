import type { AssistantMessage } from "@octocodeai/octocode-ai";
import { fauxAssistantMessage } from "@octocodeai/octocode-ai";
import { Container } from "@octocodeai/octocode-tui";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AgentSession, AgentSessionEvent } from "../src/core/agent-session.ts";
import { getApplicationPort } from "../src/core/application/index.ts";
import type { SessionEntry } from "../src/core/session-manager.ts";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.ts";
import { subscribeToAgent } from "../src/modes/interactive/interactive-mode/agent-events.ts";
import type { InteractiveModeHost } from "../src/modes/interactive/interactive-mode/host.ts";
import { handleRunStateEvent } from "../src/modes/interactive/interactive-mode/run-state-events.ts";
import {
	loadEarlierMessages,
	renderWindowedEntries,
} from "../src/modes/interactive/interactive-mode/session-window.ts";
import { createUiStore } from "../src/modes/interactive/state/store.ts";
import { getMarkdownTheme, initTheme } from "../src/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { createFakeHost } from "./interactive-mode-host.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

const ERROR = "429 Too Many Requests: rate limited";
const sessions: AgentSession[] = [];
const harnesses: Harness[] = [];

function failed(timestamp = 1): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "openai-responses",
		provider: "openai",
		model: "test",
		stopReason: "error",
		errorMessage: ERROR,
		timestamp,
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

function answered(text: string, timestamp: number): AssistantMessage {
	return { ...failed(timestamp), content: [{ type: "text", text }], stopReason: "stop", errorMessage: undefined };
}

const base = { parentId: null, timestamp: "2026-01-01T00:00:00.000Z" };
const messageEntry = (id: string, message: AssistantMessage): SessionEntry => ({
	...base,
	id,
	type: "message",
	message,
});
const omission = (id: string, targetId: string): SessionEntry => ({
	...base,
	id,
	type: "context_edit",
	targetId,
	replacement: null,
});

/** A terminal host with a transcript, the parts the session renderer and the retry events read. */
function fixture(session = fakeSession()) {
	const host = createFakeHost({
		session,
		chatContainer: new Container(),
		editor: {},
		defaultEditor: { onEscape: vi.fn() },
		getMarkdownTransformers: () => [],
		getMarkdownThemeWithSettings: getMarkdownTheme,
		hiddenThinkingLabel: "Thinking…",
		pendingTools: new Map(),
		entriesRenderedByRebuild: new Set<string>(),
		uiStore: createUiStore({ lifecycle: { initialized: true } }),
		pendingMessagesContainer: new Container(),
		getAppKeyDisplay: () => "alt+up",
		ui: { requestRender() {} },
		showStatus: vi.fn(),
		showStatusIndicator: vi.fn(),
		settingsManager: { getShowImages: () => true, getImageWidthCells: () => 20, getShowCacheMissNotices: () => false },
		sessionManager: { getCwd: () => "/tmp", buildContextEntries: () => [], getEntry: () => undefined },
		getRegisteredToolDefinition: (): ReturnType<InteractiveModeHost["getRegisteredToolDefinition"]> => undefined,
		programStatus: { handleEvent() {}, setPhase() {} },
		maybeShowThinkingDropNotice() {},
		maybeShowCacheMissNotice() {},
		maybeShowInstallChangeWarning() {},
		maybeSuggestBugReport() {},
	});
	return { host, text: () => stripAnsi(host.chatContainer.render(100).join("\n")) };
}

function fakeSession(): AgentSession & { emit(event: AgentSessionEvent): void } {
	const listeners = new Set<(event: AgentSessionEvent) => void>();
	const session = {
		sessionId: `retried-${sessions.length}`,
		messages: [],
		isStreaming: false,
		getSteeringMessages: () => [],
		getFollowUpMessages: () => [],
		retryAttempt: 0,
		subscribe(listener: (event: AgentSessionEvent) => void) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		emit(event: AgentSessionEvent) {
			for (const listener of listeners) listener(event);
		},
		featureHost: { getMessageRenderer: () => undefined, getEntryRenderer: () => undefined },
	} as unknown as AgentSession & { emit(event: AgentSessionEvent): void };
	sessions.push(session);
	return session;
}

const retryStart: AgentSessionEvent = {
	type: "auto_retry_start",
	attempt: 1,
	maxAttempts: 3,
	delayMs: 1000,
	errorMessage: ERROR,
};

describe("a failed attempt the session retries", () => {
	beforeAll(() => initTheme("dark"));
	afterEach(() => {
		for (const session of sessions.splice(0)) getApplicationPort(session).dispose();
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});

	it("reads as retried, dimmed, instead of as the turn's error; an answer that did not fail is unchanged", () => {
		const component = new AssistantMessageComponent(failed());
		const plain = stripAnsi(component.render(80).join("\n"));
		expect(plain).toContain(`Error: ${ERROR}`);
		const red = component.render(80).join("\n");
		component.markRetried();
		const marked = component.render(80).join("\n");
		expect(stripAnsi(marked)).toContain(`Retried after error: ${ERROR}`);
		expect(stripAnsi(marked)).not.toContain("Error: 429");
		expect(marked).not.toBe(red);

		const answer = new AssistantMessageComponent(answered("done", 2));
		const before = answer.render(80).join("\n");
		answer.markRetried();
		expect(answer.render(80).join("\n")).toBe(before);
	});

	it("is marked once the retry starts, without adding a row", async () => {
		const session = fakeSession();
		const { host, text } = fixture(session);
		subscribeToAgent(host);
		const message = failed();
		session.emit({ type: "message_start", message });
		session.emit({ type: "message_end", message });
		expect(text()).toContain(`Error: ${ERROR}`);
		const rows = host.chatContainer.children.length;

		await handleRunStateEvent(host, retryStart);
		expect(text()).toContain(`Retried after error: ${ERROR}`);
		expect(text()).not.toContain("Error: 429");
		expect(host.chatContainer.children).toHaveLength(rows);
		host.unsubscribe?.();
	});

	it("restores the original error live when a pending retry is cancelled", async () => {
		const session = fakeSession();
		const { host, text } = fixture(session);
		subscribeToAgent(host);
		const message = failed();
		session.emit({ type: "message_start", message });
		session.emit({ type: "message_end", message });
		await handleRunStateEvent(host, retryStart);
		await handleRunStateEvent(host, { type: "auto_retry_end", success: false, attempt: 1, cancelledBeforeRetry: true });
		expect(text()).toContain(`Error: ${ERROR}`);
		expect(text()).not.toContain("Retried after error");
		host.unsubscribe?.();
	});

	it("keeps the original error on replay after cancelling the first scheduled retry", async () => {
		const harness = await createHarness({ settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 200 } } });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			fauxAssistantMessage("unexpected retry"),
		]);
		const ends: AgentSessionEvent[] = [];
		harness.session.subscribe((event) => {
			if (event.type === "auto_retry_start") harness.session.abortRetry();
			if (event.type === "auto_retry_end") ends.push(event);
		});
		await harness.session.prompt("go");
		expect(ends).toMatchObject([{ success: false, cancelledBeforeRetry: true }]);
		const { host, text } = fixture();
		host.renderSessionEntries(harness.session.sessionManager.buildContextEntries());
		expect(text()).toContain("Error: overloaded_error");
		expect(text()).not.toContain("Retried after error");
		expect(text()).not.toContain("unexpected retry");
	});

	it("stays marked when the transcript is drawn again from the session file; a final failure stays an error", () => {
		const { host, text } = fixture();
		host.renderSessionEntries([
			messageEntry("a", failed(1)),
			omission("e", "a"),
			messageEntry("b", answered("recovered", 2)),
			messageEntry("c", failed(3)),
		]);
		expect(text()).toContain(`Retried after error: ${ERROR}`);
		expect(text().split(`Error: ${ERROR}`)).toHaveLength(2);
		expect(text().indexOf("Retried after error")).toBeLessThan(text().indexOf("recovered"));
		expect(text().indexOf(`Error: ${ERROR}`)).toBeGreaterThan(text().indexOf("recovered"));
	});

	it("stays marked when an earlier window loads after the edit that set it aside was drawn", () => {
		const { host, text } = fixture();
		renderWindowedEntries(
			host,
			[messageEntry("a", failed(1)), omission("e", "a"), messageEntry("b", answered("ok", 2))],
			{},
			2,
		);
		expect(text()).not.toContain(ERROR);
		expect(loadEarlierMessages(host)).toBe(true);
		expect(text()).toContain(`Retried after error: ${ERROR}`);
		expect(text()).not.toContain("Error: 429");
	});

	it("is marked from a real session's file after the retry recovers, and the web snapshot never shows it as a failure", async () => {
		const harness = await createHarness({ settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 200 } } });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			fauxAssistantMessage("recovered"),
		]);
		const port = getApplicationPort(harness.session);
		const failures = () => port.getSnapshot().messages.filter((m) => m.status === "failed" || m.errorMessage);
		let duringBackoff: Promise<number> | undefined;
		harness.session.subscribe((event) => {
			if (event.type === "auto_retry_start")
				duringBackoff = new Promise((resolve) => setTimeout(() => resolve(failures().length), 50));
		});
		await harness.session.prompt("go");
		// The web draws the snapshot: while the retry waits, the attempt it repeats is already gone from it.
		expect(await duringBackoff).toBe(0);

		const { host, text } = fixture();
		host.renderSessionEntries(harness.session.sessionManager.buildContextEntries());
		expect(text()).toContain("Retried after error: overloaded_error");
		expect(text()).not.toContain("Error: overloaded_error");
		expect(text()).toContain("recovered");

		expect(failures()).toEqual([]);
		expect(port.getSnapshot().messages.some((message) => message.text.includes("recovered"))).toBe(true);
	});
});

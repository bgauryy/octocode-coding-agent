import type { AssistantMessage } from "@octocodeai/octocode-ai";
import { Container } from "@octocodeai/octocode-tui";
import * as path from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AgentSession, AgentSessionEvent } from "../src/core/agent-session.ts";
import { getApplicationPort } from "../src/core/application/index.ts";
import { MissingSessionCwdError } from "../src/core/session-cwd.ts";
import { subscribeToAgent } from "../src/modes/interactive/interactive-mode/agent-events.ts";
import type { InteractiveModeHost } from "../src/modes/interactive/interactive-mode/host.ts";
import { setupKeyHandlers } from "../src/modes/interactive/interactive-mode/input-handlers.ts";
import { handleFollowUp } from "../src/modes/interactive/interactive-mode/message-queue.ts";
import { handleResumeSession } from "../src/modes/interactive/interactive-mode/session-navigation.ts";
import { getMarkdownTheme, initTheme } from "../src/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { createFakeHost } from "./interactive-mode-host.ts";

const sessions: AgentSession[] = [];

function fakeSession(extra: Record<string, unknown> = {}): AgentSession & { emit(event: AgentSessionEvent): void } {
	const listeners = new Set<(event: AgentSessionEvent) => void>();
	const session = {
		sessionId: `races-${sessions.length}`,
		messages: [],
		isStreaming: false,
		isCompacting: false,
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
		extensionRunner: { getMessageRenderer: () => undefined, getCommand: () => undefined },
		...extra,
	} as unknown as AgentSession & { emit(event: AgentSessionEvent): void };
	sessions.push(session);
	return session;
}

function assistant(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "openai",
		model: "test",
		stopReason: "stop",
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

/** An editor double that keeps text and the app action handlers the way CustomEditor does. */
function fakeEditor(initial = "") {
	let text = initial;
	const actionHandlers = new Map<string, () => void>();
	return {
		actionHandlers,
		onAction: (action: string, handler: () => void) => actionHandlers.set(action, handler),
		getText: () => text,
		setText: (next: string) => {
			text = next;
		},
		addToHistory: vi.fn(),
	};
}

/** Collects promise rejections nobody handled while `run` and the turns after it execute. */
async function unhandledDuring(run: () => unknown): Promise<unknown[]> {
	const rejections: unknown[] = [];
	const listener = (reason: unknown) => rejections.push(reason);
	process.on("unhandledRejection", listener);
	try {
		run();
		await new Promise((resolve) => setTimeout(resolve, 20));
	} finally {
		process.off("unhandledRejection", listener);
	}
	return rejections;
}

describe("interactive streaming and input races", () => {
	beforeAll(() => initTheme("dark"));
	afterEach(() => {
		for (const session of sessions.splice(0)) getApplicationPort(session).dispose();
		vi.unstubAllEnvs();
	});

	it("keeps the reply being streamed when the transcript is rebuilt mid-stream", () => {
		const session = fakeSession();
		const host = createFakeHost({
			session,
			chatContainer: new Container(),
			editor: {},
			isInitialized: true,
			getMarkdownTransformers: () => [],
			getMarkdownThemeWithSettings: getMarkdownTheme,
			hiddenThinkingLabel: "Thinking…",
			hideThinkingBlock: false,
			outputPad: 1,
			pendingTools: new Map(),
			entriesRenderedByRebuild: new Set<string>(),
			streamingComponent: undefined,
			toolOutputExpanded: false,
			ui: { requestRender() {} },
			settingsManager: {
				getShowImages: () => true,
				getImageWidthCells: () => 20,
				getShowCacheMissNotices: () => false,
			},
			sessionManager: { getCwd: () => "/tmp", buildContextEntries: () => [] },
			getRegisteredToolDefinition: (): ReturnType<InteractiveModeHost["getRegisteredToolDefinition"]> => undefined,
			programStatus: { handleEvent() {} },
			updatePendingMessagesDisplay() {},
			maybeShowThinkingDropNotice() {},
			maybeShowCacheMissNotice() {},
			maybeShowInstallChangeWarning() {},
			maybeSuggestBugReport() {},
		});
		subscribeToAgent(host);
		const text = () => stripAnsi(host.chatContainer.render(100).join("\n"));

		session.emit({ type: "message_start", message: assistant("First half") });
		session.emit({
			type: "message_update",
			message: assistant("First half"),
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "First half", partial: assistant("") },
		});
		expect(text()).toContain("First half");

		// A setting change (for example cache-miss notices in /settings) rebuilds the transcript from saved entries.
		host.rebuildChatFromMessages();
		session.emit({
			type: "message_update",
			message: assistant("First half, second half"),
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: ", second half", partial: assistant("") },
		});

		expect(text()).toContain("First half, second half");
		host.unsubscribe?.();
	});

	it("reports an external editor that cannot start instead of rejecting unhandled", async () => {
		vi.stubEnv("TMPDIR", path.join("/nonexistent-octocode-tmp", String(process.pid)));
		const editor = fakeEditor("draft");
		const showError = vi.fn();
		const ui = { stop: vi.fn(), start: vi.fn(), requestRender: vi.fn() };
		const host = createFakeHost({
			session: fakeSession(),
			defaultEditor: editor,
			editor,
			ui,
			settingsManager: { getExternalEditorCommand: () => "true" },
			showError,
		});
		setupKeyHandlers(host);

		const rejections = await unhandledDuring(() => editor.actionHandlers.get("app.editor.external")?.());

		expect(rejections).toEqual([]);
		expect(showError).toHaveBeenCalledWith(expect.stringContaining("External editor failed"));
		expect(editor.getText()).toBe("draft");
		expect(ui.start).toHaveBeenCalled();
	});

	it("restores an extension command typed during compaction when it cannot run", async () => {
		const editor = { ...fakeEditor("/deploy now"), onSubmit: vi.fn() };
		const showError = vi.fn();
		const session = fakeSession({
			isCompacting: true,
			extensionRunner: { getCommand: (name: string) => (name === "deploy" ? {} : undefined) },
			prompt: vi.fn(async () => {
				throw new Error("The session was replaced");
			}),
		});
		const host = createFakeHost({ session, editor, showError, compactionQueuedMessages: [] });

		await expect(handleFollowUp(host)).resolves.toBeUndefined();

		expect(showError).toHaveBeenCalledWith(expect.stringContaining("The session was replaced"));
		expect(editor.getText()).toBe("/deploy now");
	});

	it("routes a failed retry in the missing-folder resume path to the fatal handler", async () => {
		const retryFailure = new Error("EACCES: permission denied");
		const switchSession = vi
			.fn()
			.mockRejectedValueOnce(
				new MissingSessionCwdError({ sessionCwd: "/gone", fallbackCwd: "/tmp", sessionFile: "/tmp/other.jsonl" }),
			)
			.mockRejectedValueOnce(retryFailure);
		const handleFatalRuntimeError = vi.fn(async () => undefined as never);
		const host = createFakeHost({
			session: fakeSession(),
			sessionManager: { getSessionFile: () => "/tmp/current.jsonl" },
			runtimeHost: { switchSession },
			promptForMissingSessionCwd: vi.fn(async () => "/tmp"),
			clearStatusIndicator: vi.fn(),
			showStatus: vi.fn(),
			handleFatalRuntimeError,
		});

		await handleResumeSession(host, "/tmp/octocode-missing-resume-target.jsonl");

		expect(switchSession).toHaveBeenCalledTimes(2);
		expect(handleFatalRuntimeError).toHaveBeenCalledWith("Failed to resume session", retryFailure);
	});
});

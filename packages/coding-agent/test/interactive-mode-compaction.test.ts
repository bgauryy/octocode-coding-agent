import type { Usage } from "@octocodeai/octocode-ai";
import { Container } from "@octocodeai/octocode-tui";
import { describe, expect, test, vi } from "vitest";
import type { SessionEntry } from "../src/core/session-manager.ts";
import * as agentEvents from "../src/modes/interactive/interactive-mode/agent-events.ts";
import {
	flushCompactionQueue,
	queueInteractiveMessage,
	restoreQueuedMessagesToEditor,
} from "../src/modes/interactive/interactive-mode/message-queue.ts";
import {
	addCompactionCostNotice,
	renderSessionEntries,
} from "../src/modes/interactive/interactive-mode/session-render.ts";
import { initTheme } from "../src/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { createFakeHost, heldStore, renderPendingMessages } from "./interactive-mode-host.ts";

/** Accepts the partial events these tests send. */
const handleEvent = agentEvents.handleEvent as (host: object, event: object) => Promise<void>;

describe("InteractiveMode compaction events", () => {
	test("uses the cache miss notice setting for compaction and branch summary costs", () => {
		const usage: Usage = {
			input: 10,
			output: 20,
			cacheRead: 30,
			cacheWrite: 40,
			totalTokens: 100,
			cost: { input: 0.01, output: 0.02, cacheRead: 0.03, cacheWrite: 0.065, total: 0.125 },
		};
		initTheme("dark");
		const enabled = {
			chatContainer: new Container(),
			settingsManager: { getShowCacheMissNotices: () => true },
		};
		addCompactionCostNotice(createFakeHost(enabled), { type: "compaction_cost", kind: "compaction", usage });
		addCompactionCostNotice(createFakeHost(enabled), {
			type: "compaction_cost",
			kind: "branch_summary",
			usage,
		});
		const output = stripAnsi(enabled.chatContainer.render(120).join("\n"));
		expect(output).toContain("Compaction: 100 tokens billed, 30 read from cache (≈$0.13)");
		expect(output).toContain("Branch summary: 100 tokens billed, 30 read from cache (≈$0.13)");

		const disabled = {
			chatContainer: new Container(),
			settingsManager: { getShowCacheMissNotices: () => false },
		};
		addCompactionCostNotice(createFakeHost(disabled), { type: "compaction_cost", kind: "compaction", usage });
		expect(disabled.chatContainer.children).toHaveLength(0);
	});

	test("renders each compaction cost after its summary", () => {
		const currentUsage: Usage = {
			input: 10,
			output: 20,
			cacheRead: 30,
			cacheWrite: 40,
			totalTokens: 100,
			cost: { input: 0.01, output: 0.02, cacheRead: 0.03, cacheWrite: 0.04, total: 0.1 },
		};
		const previousUsage: Usage = {
			input: 1,
			output: 2,
			cacheRead: 3,
			cacheWrite: 4,
			totalTokens: 10,
			cost: { input: 0.001, output: 0.002, cacheRead: 0.003, cacheWrite: 0.004, total: 0.01 },
		};
		const entries: SessionEntry[] = [
			{
				type: "compaction",
				id: "current",
				parentId: "previous",
				timestamp: "2025-01-02T00:00:00Z",
				summary: "current summary",
				firstKeptEntryId: "kept",
				tokensBefore: 200,
				usage: currentUsage,
			},
			{
				type: "compaction",
				id: "previous",
				parentId: null,
				timestamp: "2025-01-01T00:00:00Z",
				summary: "previous summary",
				firstKeptEntryId: "kept",
				tokensBefore: 100,
				usage: previousUsage,
			},
		];
		const fakeThis = { renderSessionItems: vi.fn() };
		renderSessionEntries(createFakeHost(fakeThis), entries);

		expect(fakeThis.renderSessionItems).toHaveBeenCalledWith(
			[
				expect.objectContaining({ role: "compactionSummary", summary: "current summary" }),
				{ type: "compaction_cost", kind: "compaction", usage: currentUsage },
				expect.objectContaining({ role: "compactionSummary", summary: "previous summary" }),
				{ type: "compaction_cost", kind: "compaction", usage: previousUsage },
			],
			{},
		);
	});

	test("renders retained entries and appends the latest summary cost at the bottom", async () => {
		const usage: Usage = {
			input: 10,
			output: 20,
			cacheRead: 30,
			cacheWrite: 40,
			totalTokens: 100,
			cost: { input: 0.01, output: 0.02, cacheRead: 0.03, cacheWrite: 0.065, total: 0.125 },
		};
		const latestCompaction: SessionEntry = {
			type: "compaction",
			id: "latest",
			parentId: "previous",
			timestamp: "2025-01-02T00:00:00Z",
			summary: "summary",
			firstKeptEntryId: "kept",
			tokensBefore: 123,
			usage,
		};
		const previousCompaction: SessionEntry = {
			type: "compaction",
			id: "previous",
			parentId: null,
			timestamp: "2025-01-01T00:00:00Z",
			summary: "previous summary",
			firstKeptEntryId: "kept",
			tokensBefore: 100,
			usage,
		};
		const fakeThis = {
			isInitialized: true,
			footer: { invalidate: vi.fn() },
			programStatus: { handleEvent: vi.fn() },
			autoCompactionEscapeHandler: undefined as (() => void) | undefined,
			autoCompactionLoader: undefined,
			defaultEditor: {},
			statusContainer: { clear: vi.fn() },
			chatContainer: { clear: vi.fn(), children: [] },
			sessionManager: { buildContextEntries: vi.fn().mockReturnValue([latestCompaction, previousCompaction]) },
			renderSessionEntries: vi.fn(),
			addMessageToChat: vi.fn(),
			addCompactionCostNotice: vi.fn(),
			showError: vi.fn(),
			showStatus: vi.fn(),
			clearStatusIndicator: vi.fn(),
			flushCompactionQueue: vi.fn().mockResolvedValue(undefined),
			settingsManager: { getShowTerminalProgress: () => false },
			ui: { requestRender: vi.fn(), terminal: { setProgress: vi.fn() } },
		};

		await handleEvent(createFakeHost(fakeThis), {
			type: "compaction_end",
			reason: "manual",
			result: {
				tokensBefore: 123,
				summary: "summary",
				usage,
			},
			aborted: false,
			willRetry: false,
		});

		expect(fakeThis.chatContainer.clear).toHaveBeenCalledTimes(1);
		expect(fakeThis.renderSessionEntries).toHaveBeenCalledWith([previousCompaction]);
		expect(fakeThis.addMessageToChat).toHaveBeenCalledTimes(1);
		expect(fakeThis.addMessageToChat).toHaveBeenCalledWith(
			expect.objectContaining({
				role: "compactionSummary",
				tokensBefore: 123,
				summary: "summary",
			}),
		);
		expect(fakeThis.addCompactionCostNotice).toHaveBeenCalledWith({
			type: "compaction_cost",
			kind: "compaction",
			usage,
		});
		expect(fakeThis.flushCompactionQueue).toHaveBeenCalledWith({ willRetry: false });
	});

	test("updates the working state when the same agent run resumes after compaction", async () => {
		const fakeThis = {
			isInitialized: true,
			footer: { invalidate: vi.fn() },
			programStatus: { handleEvent: vi.fn() },
			activeStatusIndicator: undefined,
			workingVisible: true,
			showWorkingStatusIndicator: vi.fn(),
			clearStatusIndicator: vi.fn(),
			settingsManager: { getShowTerminalProgress: () => true },
			ui: { requestRender: vi.fn(), terminal: { setProgress: vi.fn() } },
		};
		await handleEvent(createFakeHost(fakeThis), { type: "turn_start" });

		expect(fakeThis.ui.terminal.setProgress).toHaveBeenCalledWith(true);
		expect(fakeThis.showWorkingStatusIndicator).toHaveBeenCalledTimes(1);
		expect(fakeThis.clearStatusIndicator).not.toHaveBeenCalled();
		expect(fakeThis.ui.requestRender).toHaveBeenCalledTimes(1);

		fakeThis.workingVisible = false;
		await handleEvent(createFakeHost(fakeThis), { type: "turn_start" });

		expect(fakeThis.showWorkingStatusIndicator).toHaveBeenCalledTimes(1);
		expect(fakeThis.clearStatusIndicator).toHaveBeenCalledTimes(1);
		expect(fakeThis.ui.requestRender).toHaveBeenCalledTimes(2);
	});

	// Regression test for #9340.
	test("routes interactive response aborts through AgentSession", () => {
		const abort = vi.fn(async () => {});
		const ui = {
			clearAllQueues: () => ({ steering: [], followUp: [] }),
			session: { abort },
		};
		restoreQueuedMessagesToEditor(createFakeHost(ui), { abort: true });

		expect(abort).toHaveBeenCalledOnce();
	});

	test("preserves steering behavior when flushing into an active agent run", async () => {
		const fakeThis = {
			uiStore: heldStore([{ text: "change direction", mode: "steer" as const }]),
			session: {
				clearQueue: vi.fn(),
				prompt: vi.fn().mockResolvedValue(undefined),
				steer: vi.fn().mockResolvedValue(undefined),
				followUp: vi.fn().mockResolvedValue(undefined),
			},
			isExtensionCommand: vi.fn().mockReturnValue(false),
			showError: vi.fn(),
		};

		await flushCompactionQueue(createFakeHost(fakeThis), { willRetry: false });

		expect(fakeThis.session.prompt).toHaveBeenCalledWith("change direction", {
			streamingBehavior: "steer",
			attachImagePaths: true,
			preflightResult: expect.any(Function),
		});
		expect(fakeThis.uiStore.getState().queue.compaction).toEqual([]);
		expect(fakeThis.showError).not.toHaveBeenCalled();
	});
});

describe("queued message recovery", () => {
	const flush = (ui: any, willRetry = false) => flushCompactionQueue(createFakeHost(ui), { willRetry });
	const fixture = () => ({
		uiStore: heldStore([
			{ text: "first", mode: "steer" },
			{ text: "second", mode: "followUp" },
		]),
		session: { clearQueue: vi.fn(), prompt: vi.fn().mockResolvedValue(undefined), steer: vi.fn(), followUp: vi.fn() },
		isExtensionCommand: () => false,
		showError: vi.fn(),
	});

	test("restores only unaccepted messages and preserves newer input on a partial failure", async () => {
		const ui = fixture();
		ui.session.followUp.mockImplementation(async () => {
			ui.uiStore.getState().holdMessage({ text: "newer", mode: "steer" });
			throw new Error("input failed");
		});
		await flush(ui, true);
		expect(ui.session.steer).toHaveBeenCalledWith("first", undefined, { attachImagePaths: true });
		expect(ui.session.clearQueue).not.toHaveBeenCalled();
		expect(ui.uiStore.getState().queue.compaction.map((entry) => entry.text)).toEqual(["second", "newer"]);
	});

	test("does not enqueue later messages before the first prompt passes preflight", async () => {
		const ui = fixture();
		ui.session.prompt.mockRejectedValue(new Error("no model"));
		await flush(ui);
		expect(ui.session.followUp).not.toHaveBeenCalled();
		expect(ui.session.clearQueue).not.toHaveBeenCalled();
		expect(ui.uiStore.getState().queue.compaction.map((entry) => entry.text)).toEqual(["first", "second"]);
	});

	test("does not replay accepted input when the running prompt fails later", async () => {
		const ui = fixture();
		let fail!: (error: Error) => void;
		ui.session.prompt.mockImplementation((_text, options) => {
			options.preflightResult("started");
			return new Promise((_, reject) => {
				fail = reject;
			});
		});
		await flush(ui);
		fail(new Error("provider failed"));
		await Promise.resolve();
		expect(ui.uiStore.getState().queue.compaction).toEqual([]);
		expect(ui.session.clearQueue).not.toHaveBeenCalled();
		expect(ui.showError).toHaveBeenCalledWith("provider failed");
	});

	test("starts the next prompt when an input handler consumes the first", async () => {
		const ui = fixture();
		ui.session.prompt.mockImplementation(async (_text, options) => options.preflightResult("handled"));
		await flush(ui);
		expect(ui.session.prompt).toHaveBeenCalledTimes(2);
		expect(ui.session.followUp).not.toHaveBeenCalled();
		expect(ui.uiStore.getState().queue.compaction).toEqual([]);
	});

	test("bounds previews and distinguishes next-turn messages from follow-ups", () => {
		initTheme("dark");
		const ui = {
			pendingMessagesContainer: new Container(),
			getAppKeyDisplay: () => "alt+up",
		};
		renderPendingMessages(createFakeHost(ui), {
			steering: ["first\nsecond line", "two"],
			followUp: ["three", "four", "five"],
			compacting: true,
			carried: 0,
		});
		const lines = ui.pendingMessagesContainer.render(100);
		const output = stripAnsi(lines.join("\n"));
		expect(output).toContain("5 queued · 2 next turn · 3 after run");
		expect(output).toContain("first second line");
		expect(output).toContain("2 more queued");
		expect(output).toContain("waiting for compaction");
		expect(lines.length).toBe(7);
	});
});

test("restores rejected queued input alongside a newer draft", async () => {
	let draft = "original";
	const ui = {
		editor: {
			addToHistory: vi.fn(),
			setText: (text: string) => {
				draft = text;
			},
			getText: () => draft,
		},
		session: {
			prompt: async () => {
				draft = "newer draft";
				throw new Error("input rejected");
			},
		},
		showError: vi.fn(),
		ui: { requestRender: vi.fn() },
	};
	await queueInteractiveMessage(createFakeHost(ui), "original", "steer");
	expect(draft).toBe("original\n\nnewer draft");
	expect(ui.showError).toHaveBeenCalledWith(expect.stringContaining("restored to editor"));
});

test("does not restore a queued prompt after acceptance if the run later fails", async () => {
	let draft = "original";
	const ui = {
		editor: {
			addToHistory: vi.fn(),
			setText: (text: string) => {
				draft = text;
			},
			getText: () => draft,
		},
		session: {
			prompt: async (_text: string, options: { preflightResult: () => void }) => {
				options.preflightResult();
				draft = "newer draft";
				throw new Error("provider failed");
			},
		},
		showError: vi.fn(),
		ui: { requestRender: vi.fn() },
	};
	await queueInteractiveMessage(createFakeHost(ui), "original", "followUp");
	expect(draft).toBe("newer draft");
});

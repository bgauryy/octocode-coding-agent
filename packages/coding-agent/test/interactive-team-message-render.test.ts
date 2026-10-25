/**
 * One delivered team message renders once in the interactive transcript, whichever delivery path carried it.
 * Drives the real session and the interactive event handler; only the terminal host is faked.
 */
import type { AgentTool } from "@octocodeai/octocode-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@octocodeai/octocode-ai";
import { Container } from "@octocodeai/octocode-tui";
import { Type } from "typebox";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "../src/core/extensions/index.ts";
import { subscribeToAgent } from "../src/modes/interactive/interactive-mode/agent-events.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { registerMessageRenderer } from "../src/octocode/team/tools/messages.ts";
import { INTERNAL_MESSAGE_TYPE } from "../src/octocode/shared/messages.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { createFakeHost } from "./interactive-mode-host.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

const BODY = "please review the plan";
const mail = (): { content: string; display: true; details: { messages: object[] } } => ({
	content: `Message #108 from sparkly-seahorse: ${BODY}`,
	display: true,
	details: {
		messages: [{ id: 108, from: "sparkly-seahorse", to: "me", text: BODY, at: Date.UTC(2026, 9, 25, 2, 25, 52) }],
	},
});

/** The session's interactive transcript, rendered as plain text. */
async function attach(harness: Harness) {
	const chatContainer = new Container();
	const host = createFakeHost({
		session: harness.session,
		sessionManager: harness.sessionManager,
		settingsManager: harness.settingsManager,
		chatContainer,
		isInitialized: true,
		outputPad: 1,
		toolOutputExpanded: false,
		pendingTools: new Map(),
		entriesRenderedByRebuild: new Set<string>(),
		programStatus: { handleEvent: vi.fn() },
		workingVisible: false,
		ui: { requestRender: vi.fn(), terminal: { setProgress: vi.fn() } },
		editor: {},
		defaultEditor: {},
		clearStatusIndicator: vi.fn(),
		showWorkingStatusIndicator: vi.fn(),
		updatePendingMessagesDisplay: vi.fn(),
		updateTerminalTitle: vi.fn(),
		updateEditorBorderColor: vi.fn(),
		getMarkdownThemeWithSettings: () => undefined,
		getMarkdownTransformers: () => [],
		getRegisteredToolDefinition: () => undefined,
	});
	subscribeToAgent(host);
	return {
		text: () => stripAnsi(chatContainer.render(100).join("\n")),
		copies: () => stripAnsi(chatContainer.render(100).join("\n")).split("from sparkly-seahorse").length - 1,
		unsubscribe: () => host.unsubscribe?.(),
	};
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("interactive transcript: a delivered team message renders once", () => {
	const harnesses: Harness[] = [];
	const ui: Array<() => void> = [];
	beforeAll(() => initTheme("dark"));
	afterEach(() => {
		while (ui.length > 0) ui.pop()?.();
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	const create = async (extra: Array<(pi: ExtensionAPI) => void> = [], tools: AgentTool[] = []) => {
		const harness = await createHarness({ tools, extensionFactories: [registerMessageRenderer, ...extra] });
		harnesses.push(harness);
		const view = await attach(harness);
		ui.push(view.unsubscribe);
		return { harness, view };
	};
	const entries = (harness: Harness) =>
		harness.sessionManager.getEntries().filter((entry) => entry.type === "custom_message");

	it("steered while the receiver streams, consumed at the next step", async () => {
		let send = async () => {};
		const busy: AgentTool = {
			name: "busy",
			label: "Busy",
			description: "Runs while mail arrives",
			parameters: Type.Object({}),
			execute: async () => {
				await send();
				return { content: [{ type: "text", text: "done" }], details: {} };
			},
		};
		const { harness, view } = await create([], [busy]);
		send = () =>
			harness.session.sendCustomMessage(
				{ customType: INTERNAL_MESSAGE_TYPE, ...mail() },
				{ triggerTurn: true, deliverAs: "steer" },
			);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("busy", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("ok"),
		]);
		await harness.session.prompt("go");
		await settle();
		expect(entries(harness)).toHaveLength(1);
		expect(view.copies(), view.text()).toBe(1);
	});

	it("wakes an idle receiver (triggerTurn)", async () => {
		const { harness, view } = await create();
		harness.setResponses([fauxAssistantMessage("got it")]);
		await harness.session.sendCustomMessage(
			{ customType: INTERNAL_MESSAGE_TYPE, ...mail() },
			{ triggerTurn: true, deliverAs: "steer" },
		);
		await harness.session.agent.waitForIdle();
		await settle();
		expect(entries(harness)).toHaveLength(1);
		expect(view.copies(), view.text()).toBe(1);
	});

	it("reaches an idle receiver without waking it", async () => {
		const { harness, view } = await create();
		await harness.session.sendCustomMessage(
			{ customType: INTERNAL_MESSAGE_TYPE, ...mail() },
			{ triggerTurn: false, deliverAs: "steer" },
		);
		await settle();
		expect(entries(harness)).toHaveLength(1);
		expect(view.copies(), view.text()).toBe(1);
	});

	it("sent when a run settles (held interrupt mail)", async () => {
		let sent = false;
		const { harness, view } = await create([
			(pi) =>
				pi.on("agent_settled", async () => {
					if (sent) return;
					sent = true;
					await pi.sendMessage(
						{ customType: INTERNAL_MESSAGE_TYPE, ...mail() },
						{ triggerTurn: true, deliverAs: "steer" },
					);
				}),
		]);
		harness.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);
		await harness.session.prompt("start");
		await harness.session.agent.waitForIdle();
		await settle();
		expect(entries(harness)).toHaveLength(1);
		expect(view.copies(), view.text()).toBe(1);
	});

	it("recorded as a boundary draft", async () => {
		let drafted = false;
		const { harness, view } = await create([
			(pi) =>
				pi.on("turn_end", () => {
					if (drafted) return;
					drafted = true;
					return { entries: [{ type: "custom_message", customType: INTERNAL_MESSAGE_TYPE, ...mail() }] };
				}),
		]);
		harness.setResponses([fauxAssistantMessage("first")]);
		await harness.session.prompt("start");
		await settle();
		expect(entries(harness)).toHaveLength(1);
		expect(view.copies(), view.text()).toBe(1);
	});
});

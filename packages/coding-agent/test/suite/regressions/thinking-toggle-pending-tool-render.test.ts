import type { AgentMessage } from "@octocodeai/octocode-agent-core";
import type { AssistantMessage, ToolResultMessage, Usage } from "@octocodeai/octocode-ai";
import { Container, Text, type TUI } from "@octocodeai/octocode-tui";
import { beforeAll, describe, expect, test, vi } from "vitest";
import type { SessionEntry } from "../../../src/core/session-manager.ts";
import type { ToolExecutionComponent } from "../../../src/modes/interactive/components/tool-execution.ts";
import type { ApplicationService } from "../../../src/core/application/index.ts";
import { applicationRenderer } from "../../../src/modes/interactive/interactive-mode/application-events.ts";
import { renderSessionEntries } from "../../../src/modes/interactive/interactive-mode/session-render.ts";
import { initTheme } from "../../../src/theme/theme.ts";
import { stripAnsi } from "../../../src/utils/ansi.ts";
import { createFakeHost } from "../../interactive-mode-host.ts";
import { createUiStore, type UiStore } from "../../../src/modes/interactive/state/store.ts";

const TOOL_CALL_ID = "tool-4167";
const TOOL_NAME = "slow_tool";

const EMPTY_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		total: 0,
	},
};

type RenderSessionContextThis = {
	pendingTools: Map<string, ToolExecutionComponent>;
	chatContainer: Container;
	programStatus: { handleEvent(): void; setPhase(): void };
	ui: TUI;
	settingsManager: {
		getShowImages(): boolean;
		getImageWidthCells(): number;
		getShowCacheMissNotices(): boolean;
	};
	sessionManager: { getCwd(): string; getEntries(): SessionEntry[] };
	session: { retryAttempt: number; modelRegistry: { find(provider: string, modelId: string): undefined } };
	uiStore: UiStore;
	updateEditorBorderColor(): void;
	getRegisteredToolDefinition(toolName: string): undefined;
	maybeShowAssistantDiagnostics(message: AssistantMessage): void;
	addMessageToChat(message: AgentMessage, options?: { populateHistory?: boolean }): void;
};

function createFakeInteractiveModeThis(): RenderSessionContextThis {
	const chatContainer = new Container();
	return {
		pendingTools: new Map<string, ToolExecutionComponent>(),
		chatContainer,
		programStatus: { handleEvent: vi.fn(), setPhase: vi.fn() },
		ui: { requestRender: vi.fn() } as unknown as TUI,
		settingsManager: {
			getShowImages: () => false,
			getImageWidthCells: () => 60,
			getShowCacheMissNotices: () => false,
		},
		sessionManager: { getCwd: () => process.cwd(), getEntries: () => [] },
		session: { retryAttempt: 0, modelRegistry: { find: () => undefined } },
		uiStore: createUiStore({ lifecycle: { initialized: true } }),
		updateEditorBorderColor: vi.fn(),
		getRegisteredToolDefinition: (_toolName: string) => undefined,
		maybeShowAssistantDiagnostics: vi.fn(),
		addMessageToChat(message: AgentMessage) {
			chatContainer.addChild(new Text(message.role, 0, 0));
		},
	};
}

function createAssistantToolCallMessage(): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{
				type: "toolCall",
				id: TOOL_CALL_ID,
				name: TOOL_NAME,
				arguments: { delayMs: 10_000 },
			},
		],
		api: "test-api",
		provider: "test-provider",
		model: "test-model",
		usage: EMPTY_USAGE,
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
}

function createToolResultMessage(text: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: TOOL_CALL_ID,
		toolName: TOOL_NAME,
		content: [{ type: "text", text }],
		isError: false,
		timestamp: Date.now(),
	};
}

function createSessionEntries(messages: AgentMessage[]): SessionEntry[] {
	let parentId: string | null = null;
	return messages.map((message, index) => {
		const entry: SessionEntry = {
			type: "message",
			id: `entry-${index}`,
			parentId,
			timestamp: new Date().toISOString(),
			message,
		};
		parentId = entry.id;
		return entry;
	});
}

function renderChat(container: Container): string {
	return stripAnsi(container.render(120).join("\n"));
}

describe("InteractiveMode.renderSessionEntries", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	test("keeps unresolved rendered tool calls registered for live completion events", () => {
		const fakeThis = createFakeInteractiveModeThis();

		renderSessionEntries(createFakeHost(fakeThis), createSessionEntries([createAssistantToolCallMessage()]));

		expect(fakeThis.pendingTools.has(TOOL_CALL_ID)).toBe(true);

		const render = applicationRenderer(createFakeHost(fakeThis), {} as ApplicationService);
		render({
			type: "tool.completed",
			toolCallId: TOOL_CALL_ID,
			toolName: TOOL_NAME,
			order: { sequence: 1 },
			text: "FINAL_RESULT",
		} as unknown as Parameters<typeof render>[0]);

		expect(fakeThis.pendingTools.has(TOOL_CALL_ID)).toBe(false);
		expect(renderChat(fakeThis.chatContainer)).toContain("FINAL_RESULT");
	});

	test("does not keep completed historical tool calls registered as pending", () => {
		const fakeThis = createFakeInteractiveModeThis();

		renderSessionEntries(
			createFakeHost(fakeThis),
			createSessionEntries([createAssistantToolCallMessage(), createToolResultMessage("HISTORICAL_RESULT")]),
		);

		expect(fakeThis.pendingTools.size).toBe(0);
		expect(renderChat(fakeThis.chatContainer)).toContain("HISTORICAL_RESULT");
	});
});

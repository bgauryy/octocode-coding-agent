import type { AssistantMessage } from "@octocodeai/octocode-ai";
import { Container } from "@octocodeai/octocode-tui";
import { describe, expect, test } from "vitest";
import * as sessionRender from "../src/modes/interactive/interactive-mode/session-render.ts";
import { initTheme } from "../src/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { createFakeHost } from "./interactive-mode-host.ts";

const message: AssistantMessage = {
	role: "assistant",
	content: [{ type: "text", text: "survived" }],
	api: "anthropic-messages",
	provider: "anthropic",
	model: "claude-fable-5-1",
	usage: {
		input: 1,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 2,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "stop",
	timestamp: 1,
	diagnostics: [
		{
			type: "anthropic_input_transformations",
			timestamp: 1,
			details: {
				transformations: [
					{
						type: "thinking_dropped",
						path: "messages.2.content.0",
						reason: "prefix_binding_mismatch",
					},
					{
						type: "thinking_dropped",
						path: "messages.5.content.0",
						reason: "prefix_binding_mismatch",
					},
					{
						type: "thinking_dropped",
						path: "messages.8.content.0",
						reason: "prefix_binding_mismatch",
					},
				],
			},
		},
	],
};

type NoticeContext = {
	chatContainer: Container;
	settingsManager: { getShowCacheMissNotices(): boolean };
	sessionManager: { getBranch(): Array<{ type: "message"; message: AssistantMessage }> };
};

function maybeShowThinkingDropNotice(context: NoticeContext, message: AssistantMessage): void {
	sessionRender.maybeShowThinkingDropNotice(createFakeHost(context), message);
}

describe("InteractiveMode assistant diagnostics", () => {
	test("shows Anthropic thinking drops when cache miss notices are enabled", () => {
		initTheme("dark");
		const enabled = {
			chatContainer: new Container(),
			settingsManager: { getShowCacheMissNotices: () => true },
			sessionManager: { getBranch: () => [] },
		};
		maybeShowThinkingDropNotice(enabled, message);
		const output = stripAnsi(enabled.chatContainer.render(120).join("\n"));
		expect(output).toContain("Anthropic dropped 3 thinking blocks (details in session)");

		const disabled = {
			chatContainer: new Container(),
			settingsManager: { getShowCacheMissNotices: () => false },
			sessionManager: { getBranch: () => [] },
		};
		maybeShowThinkingDropNotice(disabled, message);
		expect(disabled.chatContainer.children).toHaveLength(0);
	});

	test("does not repeat unchanged Anthropic thinking drops", () => {
		initTheme("dark");
		const context = {
			chatContainer: new Container(),
			settingsManager: { getShowCacheMissNotices: () => true },
			sessionManager: { getBranch: () => [{ type: "message" as const, message }] },
		};

		maybeShowThinkingDropNotice(context, { ...message, timestamp: 2 });

		expect(context.chatContainer.children).toHaveLength(0);
	});
});

describe("InteractiveMode cache miss warming hint", () => {
	const TTL = 5 * 60_000;
	const missMessage = {
		...message,
		usage: {
			input: 4,
			output: 1,
			cacheRead: 44_000,
			cacheWrite: 92_000,
			totalTokens: 136_005,
			cost: { input: 0, output: 0, cacheRead: 0.0088, cacheWrite: 0.736, total: 0.7448 },
		},
	};
	const miss = {
		missedTokens: 92_000,
		missedCost: 0.72,
		idleMs: 6 * 60_000,
		modelChanged: false,
		fullMiss: false,
		promptChanged: false,
	};
	const hint = (mode: string, overrides: Partial<typeof miss> = {}, ttlMs: number | undefined = TTL) =>
		sessionRender.idleWarmingHint(
			createFakeHost({ settingsManager: { getCacheWarmingMode: () => mode } }),
			{ ...miss, ...overrides },
			missMessage,
			ttlMs,
		);

	test("names idle warming and its refresh cost for an idle miss while it is off", () => {
		// One refresh reads the previous prompt: (44k + 92k) tokens at $0.20/M.
		expect(hint("streaming")).toBe(' · cacheWarming "idle" would have kept it for ≈$0.03');
	});

	test("adds nothing when idle warming is on or the gap does not explain the miss", () => {
		expect(hint("idle")).toBe("");
		expect(hint("streaming", { idleMs: 60_000 })).toBe("");
		expect(hint("streaming", { modelChanged: true })).toBe("");
		expect(
			sessionRender.idleWarmingHint(
				createFakeHost({ settingsManager: { getCacheWarmingMode: () => "streaming" } }),
				miss,
				missMessage,
				undefined,
			),
		).toBe("");
	});
});

import type { AssistantMessage } from "@octocodeai/octocode-ai";
import { describe, expect, test } from "vitest";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.ts";
import { UserMessageComponent } from "../src/modes/interactive/components/user-message.ts";
import { initTheme } from "../src/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";

function assistant(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "openai",
		model: "gpt-4o-mini",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
}

describe("message render identity", () => {
	test("an unchanged user message returns the same rows each frame", () => {
		initTheme("dark");
		const message = new UserMessageComponent("hello");
		const first = message.render(40);
		expect(first[0]).toContain(OSC133_ZONE_START);
		expect(message.render(40)).toBe(first);
		expect(first.filter((line) => line.includes(OSC133_ZONE_START))).toHaveLength(1);
		expect(message.render(30)).not.toBe(first);
	});

	test("an unchanged assistant message returns the same rows, and a streamed update shows its new text", () => {
		initTheme("dark");
		const message = new AssistantMessageComponent(assistant("first part"), false, undefined, undefined);
		const first = message.render(60);
		expect(message.render(60)).toBe(first);
		expect(first[0]).toContain(OSC133_ZONE_START);

		message.updateContent(assistant("first part and the next part"));
		const second = message.render(60);
		expect(second).not.toBe(first);
		expect(stripAnsi(second.join("\n"))).toContain("next part");
		expect(message.render(60)).toBe(second);
	});
});

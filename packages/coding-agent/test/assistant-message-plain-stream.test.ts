import type { AssistantMessage } from "@octocodeai/octocode-ai";
import { visibleWidth } from "@octocodeai/octocode-tui";
import { Lexer } from "marked";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.ts";
import { resetThinkingSpans } from "../src/modes/interactive/components/reasoning-label.ts";
import { initTheme } from "../src/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function message(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
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

const REPLY = [
	"## Plan",
	"",
	"See [the docs][docs] and **bold** `code`.",
	"",
	"- first item",
	"- second item with a long line that has to wrap at forty columns for sure",
	"",
	"```ts",
	"const a = 1;",
	"```",
	"",
	"[docs]: https://example.com/a/very/long/path/that/wraps/more/than/once",
].join("\n");

const THINKING = "I should **check** the `list` first.\n\n- one\n- two";

describe("assistant message streaming", () => {
	beforeEach(() => {
		initTheme("dark");
		resetThinkingSpans();
	});
	afterEach(() => vi.restoreAllMocks());

	test("shows plain text while streaming and lexes Markdown once when the reply ends", () => {
		const lex = vi.spyOn(Lexer.prototype, "lex");
		const component = new AssistantMessageComponent();
		const chunks = 12;
		let rows: string[] = [];
		for (let i = 1; i <= chunks; i++) {
			const text = REPLY.slice(0, Math.ceil((REPLY.length * i) / chunks));
			const thinking = THINKING.slice(0, Math.ceil((THINKING.length * i) / chunks));
			component.updateContent(
				message([
					{ type: "thinking", thinking },
					{ type: "text", text },
				]),
				true,
			);
			rows = component.render(40);
		}
		expect(lex).not.toHaveBeenCalled();
		const plain = rows.map((row) => stripAnsi(row));
		// The source shows as typed: Markdown syntax stays, rows fit the width.
		expect(plain.join("\n")).toContain("## Plan");
		expect(plain.join("\n")).toContain("**bold**");
		expect(plain.join("\n")).toContain("```ts");
		for (const row of rows) expect(visibleWidth(row)).toBeLessThanOrEqual(40);

		component.updateContent(
			message([
				{ type: "thinking", thinking: THINKING },
				{ type: "text", text: REPLY },
			]),
			false,
		);
		const final = component.render(40).map((row) => stripAnsi(row));
		const lexedOnEnd = lex.mock.calls.length;
		// One lex per block: the thinking block and the reply.
		expect(lexedOnEnd).toBe(2);
		expect(final.join("\n")).not.toContain("## Plan");
		expect(final.join("\n")).not.toContain("**bold**");
		component.render(40);
		component.render(40);
		expect(lex.mock.calls.length).toBe(lexedOnEnd);
	});

	test("a finished message renders as Markdown from the start", () => {
		const lex = vi.spyOn(Lexer.prototype, "lex");
		const component = new AssistantMessageComponent(message([{ type: "text", text: REPLY }]));
		const rows = component.render(40).map((row) => stripAnsi(row));
		expect(lex).toHaveBeenCalledTimes(1);
		expect(rows.join("\n")).not.toContain("**bold**");
	});
});

import type { AssistantMessage } from "@octocodeai/octocode-ai";
import { afterEach, describe, expect, it } from "vitest";
import { AssistantMessageComponent } from "../../src/modes/interactive/components/assistant-message.ts";
import { getMarkdownTransformers } from "../../src/modes/interactive/interactive-mode/display.ts";
import { setItemTitles, withItemTitlesInMarkdown } from "../../src/octocode/render/item-titles.ts";
import { initTheme } from "../../src/theme/theme.ts";
import { stripAnsi } from "../../src/utils/ansi.ts";

const known: Record<string, string> = { B793: "Fix every failing test and check", B5: "Other work" };
const titleOf = (ref: string) => known[ref];

describe("withItemTitlesInMarkdown", () => {
	it("titles an ID at its first mention in the whole text only", () => {
		expect(withItemTitlesInMarkdown("B793 is open.\n\nB793 waits on B5.", titleOf)).toBe(
			"B793 “Fix every failing test and check” is open.\n\nB793 waits on B5 “Other work”.",
		);
	});

	it("leaves code spans and fenced blocks as written, and titles the ID outside them", () => {
		const md = "Run `backlog get B793` now.\n```\nB793 in a log\n```\nThen B793.";
		expect(withItemTitlesInMarkdown(md, titleOf)).toBe(
			"Run `backlog get B793` now.\n```\nB793 in a log\n```\nThen B793 “Fix every failing test and check”.",
		);
	});

	it("adds nothing when the writer already put the title after the ID, in any of the usual forms", () => {
		for (const md of [
			"B793 (Fix every failing test…) is open",
			"B793: fix every failing test and check",
			"**B793** — “Fix every failing test and check”",
		])
			expect(withItemTitlesInMarkdown(md, titleOf)).toBe(md);
		// That counts as the first mention: a later bare B793 stays bare.
		expect(withItemTitlesInMarkdown("B793 (Fix every failing test) then B793", titleOf)).toBe(
			"B793 (Fix every failing test) then B793",
		);
	});

	it("leaves unknown IDs and words that only contain an ID alone", () => {
		expect(withItemTitlesInMarkdown("B9 and AB793 and B793x", titleOf)).toBe("B9 and AB793 and B793x");
	});
});

describe("assistant replies in the terminal", () => {
	afterEach(() => setItemTitles(new Map()));

	const reply = (text: string): AssistantMessage => ({
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
	});

	it("draws a known ID with its title and keeps the stored reply as written", () => {
		initTheme("dark");
		setItemTitles(new Map(Object.entries(known)));
		const transformers = getMarkdownTransformers({ mermaidMarkdownTransformer: (md: string) => md } as never);
		const message = reply("B793 is still open; it waits on two subagents.");
		const view = new AssistantMessageComponent(message, true, undefined, 1, transformers);
		const shown = stripAnsi(view.render(120).join("\n"));
		expect(shown).toContain("B793 “Fix every failing test and check” is still open");
		expect(message.content[0]).toEqual({ type: "text", text: "B793 is still open; it waits on two subagents." });
	});
});

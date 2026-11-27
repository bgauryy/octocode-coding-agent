import { Marked } from "@octocodeai/octocode-tui";
import { describe, expect, it } from "vitest";
import type { MarkdownTransformContext } from "../src/core/features/types.ts";
import type { MermaidRenderingMode } from "../src/core/settings-manager.ts";
import { createMarkdownTransform } from "../src/modes/interactive/components/markdown-transform.ts";
import { createMermaidMarkdownTransformer } from "../src/modes/interactive/components/mermaid.ts";
import type { Theme } from "../src/theme/theme.ts";

interface TransformOptions {
	maxWidth?: number;
	isStreaming?: boolean;
	messageType?: MarkdownTransformContext["messageType"];
	mode?: MermaidRenderingMode;
	theme?: Theme;
}

/** Real SGR colour codes per theme colour, so a sanitize in the pipeline would strip them. */
const SGR: Record<string, string> = {
	borderMuted: "\u001b[38;5;240m",
	text: "\u001b[38;5;252m",
	accent: "\u001b[38;5;39m",
	muted: "\u001b[38;5;245m",
	warning: "\u001b[38;5;214m",
};
const ansiTheme = {
	fg: (color: string, text: string) => `${SGR[color] ?? ""}${text}\u001b[39m`,
	bold: (text: string) => `\u001b[1m${text}\u001b[22m`,
} as Theme;

function transformMermaid(markdown: string, options: TransformOptions = {}): string {
	const transformer = createMermaidMarkdownTransformer({
		getMode: () => options.mode ?? "streaming",
		theme: options.theme,
	});
	return transformer(markdown, {
		availableWidth: options.maxWidth ?? 100,
		isStreaming: options.isStreaming ?? false,
		messageType: options.messageType ?? "assistant",
	});
}

describe("Mermaid rendering", () => {
	it("replaces Mermaid code blocks with Unicode diagrams", () => {
		const markdown = "Before\n\n```mermaid\nflowchart LR\n  A[Start] --> B[Done]\n```\nAfter";
		const rendered = transformMermaid(markdown);

		expect(rendered).toContain("Before");
		expect(rendered).toContain("┌───────┐");
		expect(rendered).toContain("│ Start ├───▶│ Done │");
		expect(rendered).toContain("└───────┘    └──────┘`\nAfter");
		expect(rendered).not.toContain("```mermaid");
		expect(rendered).toContain("After");
	});

	it("leaves unsupported and oversized diagrams unchanged", () => {
		const unsupported = '```mermaid\npie\n  title Pets\n  "Dogs" : 4\n```';
		const oversized = "```mermaid\nflowchart LR\n  A[Start] --> B[Done]\n```";

		expect(transformMermaid(unsupported)).toBe(unsupported);
		expect(transformMermaid(oversized, { maxWidth: 10 })).toBe(oversized);
	});

	it("maps semantic spans through the Octocode theme", () => {
		const rendered = transformMermaid("```mermaid\nflowchart LR\n  A --> B\n```", { theme: ansiTheme });

		expect(rendered).toContain(SGR.borderMuted);
		expect(rendered).toContain(SGR.accent);
	});

	it("leaves Mermaid blocks as source while a reply streams, in every mode", () => {
		const partialMarkdown = "```mermaid\nflowchart LR\n  A --> B";
		const finished = `${partialMarkdown}\n\`\`\``;

		for (const mode of ["streaming", "final"] as const) {
			expect(transformMermaid(partialMarkdown, { mode, isStreaming: true })).toBe(partialMarkdown);
			expect(transformMermaid(finished, { mode, isStreaming: true })).toBe(finished);
		}
	});

	it("renders a saved streaming mode exactly as final", () => {
		const markdown =
			"```mermaid\nflowchart LR\n  A[Foo] --> B[Bar]\n```\n\n```mermaid\nflowchart LR\n  A[Foo] invalid\n```";
		const final = transformMermaid(markdown, { mode: "final" });

		expect(final).toContain("│ Foo ├───▶│ Bar │");
		expect(final).toContain("Mermaid diagram not rendered");
		expect(transformMermaid(markdown, { mode: "streaming" })).toBe(final);
		expect(transformMermaid(markdown, { mode: "streaming", theme: ansiTheme })).toBe(
			transformMermaid(markdown, { mode: "final", theme: ansiTheme }),
		);
	});

	it("renders diagrams with class assignments", () => {
		const markdown = "```mermaid\nflowchart LR\n  A[Foo]:::highlight --> B[Bar]\n```";
		const rendered = transformMermaid(markdown);

		expect(rendered).not.toContain("```mermaid");
		expect(rendered).not.toContain("Mermaid diagram not rendered");
		expect(rendered).toContain("│ Foo ├───▶│ Bar │");
	});

	it("falls back to the code block with a warning after streaming", () => {
		const markdown = "```mermaid\nflowchart LR\n  A[Foo] invalid\n```";
		const final = transformMermaid(markdown);
		const followedByText = transformMermaid(`${markdown}\nFollowing text`);

		expect(final).toContain(markdown);
		expect(final).toContain("```\n`Mermaid diagram not rendered");
		expect(final).toContain('dropped, expected a link: "invalid"');
		expect(final).not.toContain("more)");
		expect(followedByText).toContain("  \nFollowing text");
	});

	it("summarizes additional partial-render warnings", () => {
		const markdown = "```mermaid\nflowchart LR\n  A[Foo] invalid\n  B[Bar] also-invalid\n```";
		const rendered = transformMermaid(markdown);

		expect(rendered).toContain(markdown);
		expect(rendered).toContain('dropped, expected a link: "invalid"');
		expect(rendered).toContain("(+1 more)");
		expect(rendered).not.toContain('dropped, expected a link: "also-invalid"');
	});

	it("respects rendering modes and skips thinking blocks", () => {
		const markdown = "```mermaid\nflowchart LR\n  A --> B\n```";

		expect(transformMermaid(markdown, { mode: "off" })).toBe(markdown);
		expect(transformMermaid(markdown, { mode: "final", isStreaming: true })).toBe(markdown);
		expect(transformMermaid(markdown, { mode: "final" })).not.toContain("```mermaid");
		expect(transformMermaid(markdown, { messageType: "assistant-thinking" })).toBe(markdown);
	});

	it("returns Markdown without a Mermaid fence as it came, as lexing it did", () => {
		const lexed = (markdown: string) =>
			new Marked()
				.lexer(markdown)
				.map((token) => token.raw)
				.join("");
		const samples = [
			"",
			"plain text",
			"# Title\n\nA paragraph with `code` and **bold**.\n\n- one\n  - two\n1. three\n",
			"```ts\nconst mermaid = 1;\n```\n\n~~~\nmermaid in the body\n~~~\n",
			"> quote\nlazy\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n    indented\n---\ntext\n===\n",
			"```\nunterminated",
		];
		for (const markdown of samples) {
			expect(lexed(markdown)).toBe(markdown);
			expect(transformMermaid(markdown, { isStreaming: true })).toBe(markdown);
			expect(transformMermaid(markdown)).toBe(markdown);
		}
	});

	it("renders every fence form that names Mermaid", () => {
		for (const markdown of [
			"~~~mermaid\nflowchart LR\n  A --> B\n~~~",
			"   ```Mermaid title\nflowchart LR\n  A --> B\n```",
			"text\n\n````MERMAID\nflowchart LR\n  A --> B\n````\n",
		]) {
			expect(transformMermaid(markdown)).toContain("───▶");
		}
	});

	it("draws the same diagram the same way whatever text follows it", () => {
		const diagram = "```mermaid\nflowchart LR\n  A[Start] --> B[Done]\n```\n";
		const first = transformMermaid(`${diagram}one`);
		const second = transformMermaid(`${diagram}one two`);
		expect(first).toContain("│ Start ├───▶│ Done │");
		expect(second).toBe(`${first} two`);
	});
});

describe("Markdown transform", () => {
	it("sanitizes the text once when no transformer changes it", () => {
		const transform = createMarkdownTransform("assistant", true, [(markdown) => markdown]);
		expect(transform("plain \u001b]0;title\u0007text\r\nnext", 80)).toBe("plain text\nnext");
	});

	it("sanitizes what a transformer adds", () => {
		const transform = createMarkdownTransform("assistant", false, [(markdown) => `${markdown}\u001b[31mred\u202e`]);
		expect(transform("a\r\n", 80)).toBe("a\nred");
	});

	it("keeps the Mermaid colours and strips what an extension transformer injects", () => {
		const mermaid = createMermaidMarkdownTransformer({ getMode: () => "streaming", theme: ansiTheme });
		const seen: string[] = [];
		const extension = (markdown: string) => {
			seen.push(markdown);
			return `${markdown}\n\u001b[31minjected\u001b[0m`;
		};
		const transform = createMarkdownTransform("assistant", false, [mermaid, extension]);
		const rendered = transform(
			"\u001b[32mintro\u001b[0m\n\n```mermaid\nflowchart LR\n  A[Start] --> B[Done]\n```\n",
			100,
		);

		expect(rendered).toContain(SGR.borderMuted);
		expect(rendered).toContain(SGR.accent);
		expect(rendered).toContain("Start");
		expect(rendered).toContain("injected");
		expect(rendered).not.toContain("\u001b[31m");
		expect(rendered).not.toContain("\u001b[32m");
		expect(rendered).not.toContain("```mermaid");
		// The extension runs before the diagram is drawn: it sees the sanitized fence, not the art.
		expect(seen).toEqual(["intro\n\n```mermaid\nflowchart LR\n  A[Start] --> B[Done]\n```\n"]);
	});

	it("keeps the warning colour of a diagram that cannot be drawn", () => {
		const mermaid = createMermaidMarkdownTransformer({ getMode: () => "final", theme: ansiTheme });
		const transform = createMarkdownTransform("assistant", false, [mermaid]);
		const rendered = transform("```mermaid\nflowchart LR\n  A[Foo] invalid\n```", 100);

		expect(rendered).toContain(`${SGR.warning}Mermaid diagram not rendered`);
	});
});

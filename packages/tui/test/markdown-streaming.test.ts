import assert from "node:assert";
import { describe, it } from "node:test";
import { Markdown } from "../src/components/markdown.ts";
import { lexMarkdown } from "../src/components/markdown/incremental.ts";
import type { DefaultTextStyle } from "../src/components/markdown/types.ts";
import { defaultMarkdownTheme } from "./test-themes.ts";

const DOCUMENT = [
	"# Title",
	"",
	"Intro paragraph with **bold**, `code`, a [link](https://example.com) and ~~strike~~ text.",
	"Second line of the paragraph.",
	"",
	"- item one",
	"- item two",
	"  - nested item",
	"  - nested two",
	"- item three",
	"",
	"1. first",
	"2. second",
	"",
	"```ts",
	"const a = 1;",
	"",
	"function f() {",
	"  return a;",
	"}",
	"```",
	"",
	"> quoted line",
	"> - quoted item",
	"",
	"| a | b |",
	"|---|---|",
	"| 1 | 2 |",
	"| 3 | 4 |",
	"",
	"Setext heading",
	"---",
	"",
	"$$",
	"x^2 + y^2 = z^2",
	"$$",
	"",
	"Inline math $a+b$ done.",
	"",
	"~~~",
	"tilde fence",
	"~~~",
	"",
	"---",
	"",
	"<div>html block</div>",
	"",
	"Last paragraph with a long line that has to wrap around the available width of the component for sure.",
	"",
	"- loose item",
	"",
	"  continued under the item",
	"",
	"- another loose item",
	"",
	"Final.",
	"",
].join("\n");

const STYLE: DefaultTextStyle = {
	color: (text) => `\x1b[36m${text}\x1b[39m`,
	bgColor: (text) => `\x1b[40m${text}\x1b[49m`,
};

function fresh(text: string, width: number, style?: DefaultTextStyle): string[] {
	return new Markdown(text, 1, 1, defaultMarkdownTheme, style).render(width);
}

describe("Markdown streaming", () => {
	for (const width of [20, 60]) {
		it(`renders every prefix of a streamed document as a full render does (width ${width})`, () => {
			const streamed = new Markdown("", 1, 1, defaultMarkdownTheme, STYLE);
			for (let end = 1; end <= DOCUMENT.length; end++) {
				const text = DOCUMENT.slice(0, end);
				streamed.setText(text);
				assert.deepStrictEqual(
					streamed.render(width),
					fresh(text, width, STYLE),
					`prefix ${end}: ${JSON.stringify(text.slice(-30))}`,
				);
			}
		});
	}

	it("streams in uneven chunks identically to a full render", () => {
		const streamed = new Markdown("", 0, 0, defaultMarkdownTheme);
		let end = 0;
		let step = 1;
		while (end < DOCUMENT.length) {
			end = Math.min(DOCUMENT.length, end + step);
			step = ((step * 7 + 3) % 40) + 1;
			const text = DOCUMENT.slice(0, end);
			streamed.setText(text);
			assert.deepStrictEqual(streamed.render(50), new Markdown(text, 0, 0, defaultMarkdownTheme).render(50));
		}
	});

	it("keeps a code fence open across updates and closes it when the fence arrives", () => {
		const streamed = new Markdown("", 0, 0, defaultMarkdownTheme);
		const steps = [
			"Before\n\n",
			"Before\n\n```js\nlet a",
			"Before\n\n```js\nlet a = 1;\n``",
			"Before\n\n```js\nlet a = 1;\n```",
			"Before\n\n```js\nlet a = 1;\n```\n\nAfter",
		];
		for (const text of steps) {
			streamed.setText(text);
			assert.deepStrictEqual(streamed.render(40), new Markdown(text, 0, 0, defaultMarkdownTheme).render(40));
		}
	});

	it("keeps a list split mid-item identical to a full render", () => {
		const streamed = new Markdown("", 0, 0, defaultMarkdownTheme);
		const steps = [
			"Intro\n\n- one\n- tw",
			"Intro\n\n- one\n- two\n  - ne",
			"Intro\n\n- one\n- two\n  - nested\n\n  para in item",
			"Intro\n\n- one\n- two\n  - nested\n\n  para in item\n\nOutside",
			"Intro\n\n1. a\n2. b",
		];
		for (const text of steps) {
			streamed.setText(text);
			assert.deepStrictEqual(streamed.render(40), new Markdown(text, 0, 0, defaultMarkdownTheme).render(40));
		}
	});

	it("re-lexes in full for edits that are not appends", () => {
		const streamed = new Markdown("", 0, 0, defaultMarkdownTheme);
		for (const text of [
			DOCUMENT,
			DOCUMENT.replace("Title", "Other"),
			DOCUMENT.slice(0, 200),
			"short",
			`${DOCUMENT.slice(0, 120)}X${DOCUMENT.slice(120)}`,
		]) {
			streamed.setText(text);
			assert.deepStrictEqual(streamed.render(40), new Markdown(text, 0, 0, defaultMarkdownTheme).render(40));
		}
	});

	it("falls back to a full lex when a link reference definition appears later", () => {
		const streamed = new Markdown("", 0, 0, defaultMarkdownTheme);
		const body = "First [ref] here.\n\nSecond paragraph.\n\nThird paragraph.\n\n";
		for (const text of [body, `${body}[ref]: https://example.com`, `${body}[ref]: https://example.com\n\nMore.`]) {
			streamed.setText(text);
			assert.deepStrictEqual(streamed.render(40), new Markdown(text, 0, 0, defaultMarkdownTheme).render(40));
		}
	});

	it("re-renders for a new width and after invalidate with a changed theme", () => {
		let marker = "A";
		const theme = { ...defaultMarkdownTheme, heading: (text: string) => `[${marker}:${text}` };
		const streamed = new Markdown(DOCUMENT, 0, 0, theme);
		const widths = [30, 80, 30, 12];
		for (const width of widths) {
			assert.deepStrictEqual(streamed.render(width), new Markdown(DOCUMENT, 0, 0, theme).render(width));
		}
		marker = "B";
		streamed.invalidate();
		const after = streamed.render(30);
		assert.deepStrictEqual(after, new Markdown(DOCUMENT, 0, 0, theme).render(30));
		assert.ok(after.some((line) => line.includes("[B:")));
		assert.ok(!after.some((line) => line.includes("[A:")));
		// streaming after the theme change keeps using the new theme
		streamed.setText(`${DOCUMENT}\n# More`);
		assert.ok(streamed.render(30).some((line) => line.includes("[B:")));
		assert.ok(!streamed.render(30).some((line) => line.includes("[A:")));
	});

	it("keeps the tokens of finished blocks when the source grows", () => {
		const first = lexMarkdown("One.\n\nTwo.\n\nThree.\n\nFour");
		const second = lexMarkdown("One.\n\nTwo.\n\nThree.\n\nFour and more", first);
		assert.strictEqual(second.tokens[0], first.tokens[0]);
		assert.notStrictEqual(second.tokens.at(-1), first.tokens.at(-1));
		assert.deepStrictEqual(
			second.tokens.map((token) => token.raw),
			lexMarkdown("One.\n\nTwo.\n\nThree.\n\nFour and more").tokens.map((token) => token.raw),
		);
		// A link reference definition can change earlier links, so the whole source is lexed again.
		const withDefinition = lexMarkdown("One.\n\nTwo.\n\nThree.\n\nFour\n\n[a]: https://x.test", second);
		assert.notStrictEqual(withDefinition.tokens[0], first.tokens[0]);
		assert.strictEqual(withDefinition.extendable, false);
	});
});

import assert from "node:assert";
import { after, before, describe, it } from "node:test";
import { Markdown } from "../src/components/markdown.ts";
import { lexMarkdown } from "../src/components/markdown/incremental.ts";
import type { DefaultTextStyle } from "../src/components/markdown/types.ts";
import { getCapabilities, resetCapabilitiesCache, setCapabilities } from "../src/terminal-image/capabilities.ts";
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

/** An OSC 8 id is `<component>-<block>-<link>-<piece>`: the component part is unique, the rest follows source order. */
const LINK_ID = /\x1b\]8;id=(oc\d+)-/g;

function linkComponents(lines: string[]): Set<string> {
	return new Set(lines.flatMap((line) => [...line.matchAll(LINK_ID)].map((match) => match[1])));
}

/** `streamed` matches `full` byte for byte, except that each component keeps its own hyperlink ids. */
function assertRendersAs(streamed: string[], full: string[], message?: string): void {
	const streamedComponents = linkComponents(streamed);
	const fullComponents = linkComponents(full);
	assert.ok(streamedComponents.size <= 1 && fullComponents.size <= 1, message);
	assert.ok(![...streamedComponents].some((component) => fullComponents.has(component)), message);
	const shared = (lines: string[]) => lines.map((line) => line.replace(LINK_ID, "\x1b]8;id=oc-"));
	assert.deepStrictEqual(shared(streamed), shared(full), message);
}

function linkIds(lines: string[]): Array<[id: string, url: string]> {
	return [...lines.join("\n").matchAll(/\x1b\]8;id=([^;]+);([^\x1b]+)\x1b\\/g)].map((match) => [match[1], match[2]]);
}

describe("Markdown streaming", () => {
	// Pinned on so the comparisons cover OSC 8 links whatever terminal runs the tests.
	before(() => setCapabilities({ ...getCapabilities(), hyperlinks: true }));
	after(() => resetCapabilitiesCache());

	for (const width of [20, 60]) {
		it(`renders every prefix of a streamed document as a full render does (width ${width})`, () => {
			const streamed = new Markdown("", 1, 1, defaultMarkdownTheme, STYLE);
			for (let end = 1; end <= DOCUMENT.length; end++) {
				const text = DOCUMENT.slice(0, end);
				streamed.setText(text);
				assertRendersAs(
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
			assertRendersAs(streamed.render(50), new Markdown(text, 0, 0, defaultMarkdownTheme).render(50));
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
			assertRendersAs(streamed.render(40), new Markdown(text, 0, 0, defaultMarkdownTheme).render(40));
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
			assertRendersAs(streamed.render(40), new Markdown(text, 0, 0, defaultMarkdownTheme).render(40));
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
			assertRendersAs(streamed.render(40), new Markdown(text, 0, 0, defaultMarkdownTheme).render(40));
		}
	});

	it("falls back to a full lex when a link reference definition appears later", () => {
		const streamed = new Markdown("", 0, 0, defaultMarkdownTheme);
		const body = "First [ref] here.\n\nSecond paragraph.\n\nThird paragraph.\n\n";
		for (const text of [body, `${body}[ref]: https://example.com`, `${body}[ref]: https://example.com\n\nMore.`]) {
			streamed.setText(text);
			assertRendersAs(streamed.render(40), new Markdown(text, 0, 0, defaultMarkdownTheme).render(40));
		}
	});

	it("re-renders for a new width and after invalidate with a changed theme", () => {
		let marker = "A";
		const theme = { ...defaultMarkdownTheme, heading: (text: string) => `[${marker}:${text}` };
		const streamed = new Markdown(DOCUMENT, 0, 0, theme);
		const widths = [30, 80, 30, 12];
		for (const width of widths) {
			assertRendersAs(streamed.render(width), new Markdown(DOCUMENT, 0, 0, theme).render(width));
		}
		marker = "B";
		streamed.invalidate();
		const after = streamed.render(30);
		assertRendersAs(after, new Markdown(DOCUMENT, 0, 0, theme).render(30));
		assert.ok(after.some((line) => line.includes("[B:")));
		assert.ok(!after.some((line) => line.includes("[A:")));
		// streaming after the theme change keeps using the new theme
		streamed.setText(`${DOCUMENT}\n# More`);
		assert.ok(streamed.render(30).some((line) => line.includes("[B:")));
		assert.ok(!streamed.render(30).some((line) => line.includes("[A:")));
	});

	it("keeps hyperlink ids stable while streaming and unique per link and component", () => {
		const first = "See [alpha beta gamma delta](https://a.test) and [b](https://b.test) and [b](https://b.test).";
		const streamed = new Markdown(first, 0, 0, defaultMarkdownTheme);
		const before = linkIds(streamed.render(12));
		const wrapped = before.filter(([, url]) => url === "https://a.test/");
		// a wrapped link reopens with the same id on every row; separate links differ even with the same destination
		assert.ok(wrapped.length > 1, JSON.stringify(before));
		assert.strictEqual(new Set(wrapped.map(([id]) => id)).size, 1);
		assert.strictEqual(before.filter(([, url]) => url === "https://b.test/").length, 2);
		assert.strictEqual(new Set(before.map(([id]) => id)).size, 3);
		streamed.setText(`${first}\n\nNext [c](https://c.test) here.`);
		const grown = linkIds(streamed.render(12));
		assert.deepStrictEqual(grown.slice(0, before.length), before);
		assert.deepStrictEqual(grown.at(-1)?.[1], "https://c.test/");
		assert.ok(!before.some(([id]) => id === grown.at(-1)?.[0]));
		const other = linkIds(new Markdown(first, 0, 0, defaultMarkdownTheme).render(12));
		assert.deepStrictEqual(
			other.map(([, url]) => url),
			before.map(([, url]) => url),
		);
		assert.ok(!other.some(([id]) => before.some(([seen]) => seen === id)));
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

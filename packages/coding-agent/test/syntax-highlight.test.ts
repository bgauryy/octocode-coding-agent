import { HighlightCache, resetCapabilitiesCache, setCapabilities } from "@octocodeai/octocode-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import hljs from "highlight.js/lib/core";
import { getMarkdownTheme, highlightCode, initTheme, theme } from "../src/theme/theme.ts";
import {
	highlight,
	loadAllHighlightLanguages,
	isHighlightable,
	renderHighlightedHtml,
	resolveLanguage,
} from "../src/utils/syntax-highlight.ts";

const eagerLanguages = [
	"python",
	"java",
	"go",
	"javascript",
	"cpp",
	"typescript",
	"php",
	"ruby",
	"c",
	"csharp",
	"nix",
	"bash",
	"rust",
	"scala",
	"kotlin",
	"swift",
	"dart",
	"groovy",
	"perl",
	"lua",
	"yaml",
	"sql",
	"xml",
	"css",
	"diff",
	"markdown",
	"ini",
	"dockerfile",
	"makefile",
];
const supportsLanguage = (name: string) => resolveLanguage(name) !== undefined;
const eagerLanguagesLoadedAtStartup = eagerLanguages.every(supportsLanguage);
const uncommonLanguageLoadedAtStartup = supportsLanguage("ada");

describe("syntax highlight renderer", () => {
	it("loads the most common languages at startup and defers the rest", async () => {
		expect(eagerLanguagesLoadedAtStartup).toBe(true);
		expect(uncommonLanguageLoadedAtStartup).toBe(false);
		// "ada" was asked for before the full set loaded, so code already rendered as plain text would now change.
		await expect(loadAllHighlightLanguages()).resolves.toBe(true);
		expect(supportsLanguage("ada")).toBe(true);
	});

	it("reports no change from loading every language when only eager or unknown languages were asked for", async () => {
		vi.resetModules();
		const fresh = await import("../src/utils/syntax-highlight.ts");
		expect(fresh.resolveLanguage("typescript")).toBe("typescript");
		expect(fresh.resolveLanguage("not-a-language")).toBeUndefined();
		await expect(fresh.loadAllHighlightLanguages()).resolves.toBe(false);
	});

	it("renders highlighted spans with the provided theme", () => {
		const rendered = renderHighlightedHtml('<span class="hljs-keyword">const</span> value', {
			keyword: (text) => `[keyword:${text}]`,
		});
		expect(rendered).toBe("[keyword:const] value");
	});

	it("decodes HTML entities emitted by highlight.js", () => {
		const rendered = renderHighlightedHtml("&lt;tag attr=&quot;value&quot;&gt;&amp;#x41;&#65;&lt;/tag&gt;");
		expect(rendered).toBe('<tag attr="value">&#x41;A</tag>');
	});

	it("inherits parent formatting for unmapped nested scopes", () => {
		const interpolation = "${x}";
		const rendered = renderHighlightedHtml(
			`<span class="hljs-string">a<span class="hljs-subst">${interpolation}</span>b</span>`,
			{
				string: (text) => `[string:${text}]`,
			},
		);
		expect(rendered).toBe(`[string:a][string:${interpolation}][string:b]`);
	});

	it("keeps parent formatting across unscoped nested spans", () => {
		const rendered = renderHighlightedHtml('<span class="hljs-string">a<span class="language-xml">b</span>c</span>', {
			string: (text) => `[string:${text}]`,
		});
		expect(rendered).toBe("[string:a][string:b][string:c]");
	});

	it("highlights code through highlight.js", () => {
		expect(supportsLanguage("typescript")).toBe(true);
		const rendered = highlight("const value = 1", {
			language: "typescript",
			ignoreIllegals: true,
			theme: {
				keyword: (text) => `[keyword:${text}]`,
				number: (text) => `[number:${text}]`,
			},
		});
		expect(rendered).toContain("[keyword:const]");
		expect(rendered).toContain("[number:1]");
	});
});

describe("theme syntax highlighting", () => {
	it("reuses a conversation's small code blocks across width changes", () => {
		const spy = vi.spyOn(hljs, "highlight");
		try {
			const codes = Array.from({ length: 1000 }, (_, i) => `const conversation_${i} = ${i};`);
			for (const code of codes) highlightCode(code, "typescript");
			const cold = spy.mock.calls.length;
			for (const code of codes) highlightCode(code, "typescript");
			expect(cold).toBe(1000);
			expect(spy.mock.calls.length).toBe(cold);
		} finally {
			spy.mockRestore();
		}
	});
	beforeEach(() => {
		setCapabilities({ images: null, trueColor: true, hyperlinks: false });
		initTheme("dark");
	});

	afterEach(() => {
		resetCapabilitiesCache();
	});

	it("colors each line of Python docstrings independently", () => {
		const code = '"""\nline one\n\nline two\n"""\nafter';
		const ansi = theme.getFgAnsi("syntaxString");
		const expected = [
			`${ansi}"""\x1b[39m`,
			`${ansi}line one\x1b[39m`,
			"",
			`${ansi}line two\x1b[39m`,
			`${ansi}"""\x1b[39m`,
			"after",
		];

		expect(highlightCode(code, "python")).toEqual(expected);
		expect(getMarkdownTheme().highlightCode?.(code, "python")).toEqual(expected);
	});

	it("colors diff additions and deletions in fenced diff blocks", () => {
		const lines = highlightCode("-old\n+new\n", "diff");

		expect(lines[0]).toBe(`${theme.getFgAnsi("toolDiffRemoved")}-old\x1b[39m`);
		expect(lines[1]).toBe(`${theme.getFgAnsi("toolDiffAdded")}+new\x1b[39m`);
	});

	it("keeps cli-highlight default styled scopes mapped to theme styles", () => {
		expect(highlightCode("const re = /foo+/gi;", "javascript")[0]).toContain(
			`${theme.getFgAnsi("syntaxString")}/foo+/gi\x1b[39m`,
		);
		expect(highlightCode("@decorator", "python")[0]).toBe(`${theme.getFgAnsi("muted")}@decorator\x1b[39m`);
		expect(highlightCode("<div></div>", "html")[0]).toContain(`${theme.getFgAnsi("syntaxKeyword")}div\x1b[39m`);
	});
});

describe("highlight cache limits", () => {
	it("evicts by output size and keeps a recently used block", () => {
		const cache = new HighlightCache(10, 40);
		cache.set("a", ["1234567890"]);
		cache.set("b", ["1234567890"]);
		expect(cache.get("a")).toEqual(["1234567890"]);
		cache.set("c", ["1234567890"]);
		expect(cache.get("b")).toBeUndefined();
		expect(cache.get("a")).toEqual(["1234567890"]);
		cache.set("large", ["x".repeat(100)]);
		expect(cache.get("large")).toBeUndefined();
	});
	it("bounds the number of small blocks and accounts for replaced entries", () => {
		const cache = new HighlightCache(2, 60);
		cache.set("a", ["x".repeat(20)]);
		cache.set("a", ["x"]);
		cache.set("b", ["x".repeat(20)]);
		expect(cache.get("a")).toEqual(["x"]);
		cache.set("c", ["x"]);
		expect(cache.get("b")).toBeUndefined();
		expect(cache.get("a")).toEqual(["x"]);
		expect(cache.get("c")).toEqual(["x"]);
	});
});

describe("language names and guards", () => {
	it("resolves fence aliases and the first word of an info string", () => {
		for (const name of [
			"tsx",
			"ts",
			"sh",
			"zsh",
			"console",
			"shell",
			"yml",
			"jsonc",
			"patch",
			"jsx",
			"html",
			"svg",
			"docker",
			"make",
		]) {
			expect(supportsLanguage(name), name).toBe(true);
		}
		expect(resolveLanguage("TS title=x")).toBe("ts");
		expect(resolveLanguage("tsx {1,3}")).toBe("typescript");
		expect(resolveLanguage("sh")).toBe("bash");
		expect(resolveLanguage("html")).toBe("xml");
		expect(resolveLanguage("not-a-language")).toBeUndefined();
		expect(resolveLanguage("")).toBeUndefined();
	});

	it("limits highlighting by lines, bytes and line length", () => {
		expect(isHighlightable("a\n".repeat(1999))).toBe(true);
		expect(isHighlightable("a\n".repeat(2000))).toBe(false);
		expect(isHighlightable("x".repeat(4096))).toBe(true);
		expect(isHighlightable("x".repeat(4097))).toBe(false);
		expect(isHighlightable(`${"x".repeat(1000)}\n`.repeat(300))).toBe(false);
	});
});

describe("highlight.js 11 output through the theme", () => {
	beforeEach(() => {
		setCapabilities({ images: null, trueColor: true, hyperlinks: false });
		initTheme("dark");
	});
	afterEach(() => {
		resetCapabilitiesCache();
	});

	it("colors keywords, strings, comments, functions and types in TypeScript", () => {
		const code = 'function greet(name: string): void {\n\t// hi\n\tconst s = "x";\n}\nclass Foo {}';
		const out = highlightCode(code, "ts title=x").join("\n");
		expect(out).toContain(`${theme.getFgAnsi("syntaxKeyword")}function\x1b[39m`);
		expect(out).toContain(`${theme.getFgAnsi("syntaxFunction")}greet\x1b[39m`);
		expect(out).toContain(`${theme.getFgAnsi("syntaxComment")}// hi\x1b[39m`);
		expect(out).toContain(`${theme.getFgAnsi("syntaxString")}"x"\x1b[39m`);
		expect(out).toContain(`${theme.getFgAnsi("syntaxType")}Foo\x1b[39m`);
	});

	it("colors YAML, SQL and CSS that used to load late", () => {
		expect(highlightCode("key: 1", "yml").join("")).toContain(theme.getFgAnsi("syntaxNumber"));
		expect(highlightCode("SELECT 1", "sql").join("")).toContain(theme.getFgAnsi("syntaxKeyword"));
		expect(highlightCode("a { color: red; }", "css").join("")).toContain("\x1b[");
	});

	it("returns plain code-block lines for oversized code and caches repeat calls", () => {
		const big = "const a = 1;\n".repeat(2500);
		const plain = highlightCode(big, "typescript");
		expect(plain[0]).toBe(theme.fg("mdCodeBlock", "const a = 1;"));
		const first = highlightCode("const a = 1", "typescript");
		first[0] = "mutated";
		expect(highlightCode("const a = 1", "typescript")[0]).not.toBe("mutated");
	});
});

import assert from "node:assert";
import { afterEach, describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { Markdown } from "../src/components/markdown.ts";
import { findFileReferences } from "../src/components/markdown/linkify.ts";
import { getCapabilities, resetCapabilitiesCache, setCapabilities } from "../src/terminal-image/capabilities.ts";
import { defaultMarkdownTheme } from "./test-themes.ts";

/** Markers instead of colour so the assertions do not depend on the colour level. */
const theme = {
	...defaultMarkdownTheme,
	link: (text: string) => `<L>${text}</L>`,
	code: (text: string) => `<C>${text}</C>`,
};

function render(text: string, hyperlinks: boolean): string {
	setCapabilities({ ...getCapabilities(), hyperlinks });
	return new Markdown(text, 0, 0, theme).render(120).join("\n");
}

const OSC8 = (url: string) => `\x1b]8;;${url}\x1b\\`;
const CLOSE = "\x1b]8;;\x1b\\";
const here = (path: string) => pathToFileURL(`${process.cwd()}/${path}`).href;

describe("file references", () => {
	afterEach(() => resetCapabilitiesCache());

	describe("detection", () => {
		const cases: Array<[text: string, refs: string[]]> = [
			["see src/a.ts:12", ["src/a.ts:12"]],
			["see src/a.ts:12:3 now", ["src/a.ts:12:3"]],
			["(src/a.ts:12).", ["src/a.ts:12"]],
			["main.ts:4, util.py:9.", ["main.ts:4", "util.py:9"]],
			["./a/b.test.tsx:7", ["./a/b.test.tsx:7"]],
			["../x/y.rs:1:1", ["../x/y.rs:1:1"]],
			["/abs/path/file.go:100", ["/abs/path/file.go:100"]],
			["~/proj/file.md:3", ["~/proj/file.md:3"]],
			["packages/x/README:5", []],
			["Makefile.am:3", []],
			["version v1.2.3", []],
			["v1.2.3:4", []],
			["at 12:30 today", []],
			["at 12:30:45", []],
			["1.5:2", []],
			["https://example.com/a.ts:12", []],
			["http://localhost:3000/x.js:1", []],
			["example.com:8080", []],
			["file:///tmp/a.ts:3", []],
			["mail me@host.ts:12", []],
			["user@example.com:25", []],
			["src/a.ts:0", []],
			["src/a.ts:12abc", []],
			["src/a.ts:", []],
			["src/a.ts", []],
		];
		for (const [text, refs] of cases) {
			it(JSON.stringify(text), () => {
				assert.deepEqual(
					findFileReferences(text).map((ref) => text.slice(ref.start, ref.end)),
					refs,
				);
			});
		}

		it("reports path, line and column", () => {
			assert.deepEqual(findFileReferences("src/a.ts:12:3"), [
				{ start: 0, end: 13, path: "src/a.ts", line: 12, column: 3 },
			]);
		});
	});

	describe("rendering", () => {
		it("links a reference in prose when the terminal supports hyperlinks", () => {
			const out = render("Look at src/a.ts:12:3 please", true);
			assert.ok(out.includes(`${OSC8(here("src/a.ts"))}<L>src/a.ts:12:3</L>${CLOSE}`), JSON.stringify(out));
		});

		it("colours it but adds no link sequence without hyperlink support", () => {
			const out = render("Look at src/a.ts:12:3 please", false);
			assert.ok(out.includes("<L>src/a.ts:12:3</L>"));
			assert.ok(!out.includes("\x1b]8"));
		});

		it("keeps the visible text unchanged", () => {
			const text = "Look at src/a.ts:12:3 and (b.ts:4), not v1.2.3 or 12:30.";
			for (const hyperlinks of [true, false]) {
				const visible = render(text, hyperlinks)
					.replace(/\x1b\]8;;[^\x1b]*\x1b\\/g, "")
					.replace(/<\/?[LC]>/g, "")
					.trim();
				assert.equal(visible, text);
			}
		});

		it("links an inline code span that is only a reference", () => {
			const out = render("Edit `src/a.ts:12` next", true);
			assert.ok(out.includes(`${OSC8(here("src/a.ts"))}<C>src/a.ts:12</C>${CLOSE}`), JSON.stringify(out));
			assert.ok(!render("Edit `src/a.ts:12` next", false).includes("\x1b]8"));
		});

		it("leaves other inline code, versions, times and URLs alone", () => {
			for (const text of ["Run `npm i a.ts:12 now` ok", "Use v1.2.3 at 12:30", "See https://example.com/a.ts:12"]) {
				const out = render(text, true);
				assert.ok(!out.includes("<L>src") && !out.includes("file://"), JSON.stringify(out));
			}
		});

		it("links absolute paths as written", () => {
			const out = render("in /tmp/x/a.ts:5 done", true);
			assert.ok(out.includes(OSC8("file:///tmp/x/a.ts")));
		});
	});
});

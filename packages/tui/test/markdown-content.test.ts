import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	markdownCodeBlocks,
	markdownPlainText,
	markdownReferences,
	markdownReferenceUrl,
} from "../src/markdown-content.ts";
import { hyperlink } from "../src/terminal-image.ts";
import { Markdown } from "../src/components/markdown.ts";
import { setCapabilities, resetCapabilitiesCache } from "../src/terminal-image/capabilities.ts";
import { defaultMarkdownTheme } from "./test-themes.ts";

describe("semantic Markdown actions", () => {
	it("keeps full file positions and original cwd without terminal hyperlink support", () => {
		const references = markdownReferences("Inspect `src/a.ts:12:3` and [guide](docs/guide.md).", "/original/worktree");
		assert.deepEqual(references, [
			{ label: "src/a.ts:12:3", url: "file:///original/worktree/src/a.ts#L12:3" },
			{ label: "guide", url: "file:///original/worktree/docs/guide.md" },
		]);
	});
	it("finds references in lists and tables, without executing or searching code examples", () => {
		const source = "- [one](https://example.com/a)\n\n| file |\n| --- |\n| a.ts:2 |\n\n```ts\n// fake.ts:9\n```";
		assert.deepEqual(
			markdownReferences(source, "/work").map((ref) => ref.url),
			["https://example.com/a", "file:///work/a.ts#L2"],
		);
	});
	it("copies literal fenced code and retains destinations only when requested", () => {
		const source = "## Review\n\n**Read** [the guide](https://example.com).\n\n```ts\nconst text = '**literal**';\n```";
		assert.deepEqual(markdownCodeBlocks(source), [{ language: "ts", text: "const text = '**literal**';" }]);
		assert.equal(markdownPlainText(source), "Review\n\nRead the guide.\n\nconst text = '**literal**';");
		assert.match(markdownPlainText(source, true), /the guide \(https:\/\/example.com\)/);
	});
	it("never emits control characters from a target and keeps stable explicit hyperlink ids", () => {
		assert.equal(hyperlink("label", "https://example.com/\x1b]52;bad"), "label");
		assert.equal(
			hyperlink("label", "https://example.com", "message-1"),
			"\x1b]8;id=message-1;https://example.com\x1b\\label\x1b]8;;\x1b\\",
		);
	});
	it("keeps occurrence identities across wrapping and invalidation", () => {
		setCapabilities({ hyperlinks: true, images: null, trueColor: false });
		try {
			const markdown = new Markdown(
				"[one long reference](https://example.com) [another](https://example.com)",
				0,
				0,
				defaultMarkdownTheme,
			);
			const ids = (width: number) =>
				new Set(
					[
						...markdown
							.render(width)
							.join("\n")
							.matchAll(/\x1b\]8;id=([^;]+);/g),
					].map((match) => match[1]),
				);
			const initial = ids(80);
			assert.equal(initial.size, 2);
			assert.deepEqual(ids(12), initial);
			markdown.invalidate();
			assert.deepEqual(ids(40), initial);
			markdown.setText("[one long reference](https://example.com) [another](https://example.com) more text");
			assert.deepEqual(ids(40), initial);
		} finally {
			resetCapabilitiesCache();
		}
	});
	it("retains Windows drive paths and columns independently of the host OS", () => {
		assert.deepEqual(markdownReferences("See `C:\\work\\src\\a.ts:12:3`.", "C:\\work"), [
			{ label: "C:\\work\\src\\a.ts:12:3", url: "file:///C:/work/src/a.ts#L12:3" },
		]);
	});
	it("preserves relative file anchors, encoded spaces and Windows destinations", () => {
		assert.equal(markdownReferenceUrl("docs/a%20b.md#part", "/work"), "file:///work/docs/a%20b.md#part");
		assert.equal(markdownReferenceUrl("src/a.ts", "C:\\work"), "file:///C:/work/src/a.ts");
		assert.equal(markdownPlainText("[source](a.ts#L2)", true, "/work"), "source (file:///work/a.ts#L2)");
		assert.equal(markdownReferenceUrl("bad%zz", "/work"), undefined);
	});
});

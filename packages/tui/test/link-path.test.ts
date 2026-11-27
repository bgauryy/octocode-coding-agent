import assert from "node:assert";
import { hostname } from "node:os";
import { describe, it } from "node:test";
import { linkPath } from "../src/utils/link-path.ts";
import { truncateToWidth } from "../src/utils/truncate.ts";
import { visibleWidth } from "../src/utils/width.ts";

const OPEN = /\x1b\]8;[^;]*;([^\x1b]*)\x1b\\/g;
const CLOSE = "\x1b]8;;\x1b\\";

describe("linkPath", () => {
	it("links the label to file://<host>/<absolute path> when hyperlinks are on", () => {
		const linked = linkPath("src/a.ts:12", "src/a.ts", "/work/repo", true);
		const urls = [...linked.matchAll(OPEN)].map((match) => match[1]).filter(Boolean);
		assert.deepStrictEqual(urls, [`file://${new URL(`file://${hostname()}/`).host}/work/repo/src/a.ts`]);
		assert.ok(linked.endsWith(CLOSE));
	});

	it("keeps an absolute path and encodes characters a URL cannot hold", () => {
		const linked = linkPath("notes", "/tmp/my notes/漢.md", "/elsewhere", true);
		const [url] = [...linked.matchAll(OPEN)].map((match) => match[1]);
		assert.match(url ?? "", /^file:\/\/[^/]*\/tmp\/my%20notes\/%E6%BC%A2\.md$/);
	});

	it("returns the plain text when hyperlinks are off", () => {
		assert.strictEqual(linkPath("src/a.ts", "src/a.ts", "/work/repo", false), "src/a.ts");
	});

	it("returns the plain text for an empty path", () => {
		assert.strictEqual(linkPath("label", "", "/work/repo", true), "label");
	});

	it("leaves the visible width unchanged", () => {
		for (const label of ["src/a.ts:12", "漢字/ファイル.ts", "🐙.md"]) {
			assert.strictEqual(visibleWidth(linkPath(label, label, "/work", true)), visibleWidth(label));
		}
	});

	it("closes the link when truncation cuts the label", () => {
		const cut = truncateToWidth(linkPath("packages/tui/src/components/row-fit.ts", "x.ts", "/w", true), 12);
		assert.ok(visibleWidth(cut) <= 12);
		assert.ok(cut.includes("…"));
		const lastOpen = cut.lastIndexOf("\x1b]8;;file");
		assert.ok(cut.indexOf(CLOSE, lastOpen + 1) > lastOpen);
		assert.ok(cut.indexOf(CLOSE, lastOpen + 1) < cut.indexOf("…"));
	});
});

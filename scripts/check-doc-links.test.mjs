import assert from "node:assert/strict";
import { test } from "node:test";
import { anchors, brokenLinks, slug } from "./check-doc-links.mjs";

test("slugs follow GitHub: punctuation dropped, spaces hyphenated, repeats numbered", () => {
	assert.equal(slug("The `done` check & the state-change line"), "the-done-check--the-state-change-line");
	assert.equal(slug("Schema and other settings"), "schema-and-other-settings");
	const found = anchors("# A\n\n## Same\n\n## Same\n\n```md\n## Hidden\n```\n");
	assert.deepEqual([...found], ["a", "same", "same-1"]);
});

test("reports a missing file and a missing heading, accepts good and external links", () => {
	const files = {
		"/d/a.md": "# A\n[x](b.md#real) [y](b.md#gone) [z](c.md) [w](#a) [v](https://x.y/z#q) `[n](n.md)`\n",
		"/d/b.md": "## Real\n",
	};
	const read = (path) => files[path];
	assert.deepEqual(brokenLinks("/d/a.md", files["/d/a.md"], read), [
		"/d/a.md:2 -> b.md#gone: no such heading",
		"/d/a.md:2 -> c.md: no such file",
	]);
});

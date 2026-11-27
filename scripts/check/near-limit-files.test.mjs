import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { nearLimitFiles, nearLimitNotice } from "./near-limit-files.mjs";

const lines = (count) => "x\n".repeat(count);

function repo(t, files) {
	const root = mkdtempSync(join(tmpdir(), "near-limit-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	mkdirSync(join(root, "packages"));
	mkdirSync(join(root, "scripts"));
	for (const [file, text] of Object.entries(files)) {
		mkdirSync(dirname(join(root, file)), { recursive: true });
		writeFileSync(join(root, file), text);
	}
	return root;
}

test("lists source files from the near-limit size on, longest first, and skips what max-lines exempts", (t) => {
	const root = repo(t, {
		"packages/a/src/full.ts": lines(400),
		"packages/a/src/near.ts": lines(350),
		"packages/a/src/short.ts": lines(349),
		"packages/a/src/x.test.ts": lines(600),
		"packages/a/test/helper.ts": lines(600),
		"packages/a/src/types.d.ts": lines(600),
		"packages/ai/src/providers/data/models.ts": lines(600),
		"packages/coding-agent/src/core/export-html/vendor/marked.mjs": lines(600),
		"scripts/tool.mjs": lines(360),
	});
	assert.deepEqual(nearLimitFiles(root), [
		{ file: "packages/a/src/full.ts", lines: 400 },
		{ file: "scripts/tool.mjs", lines: 360 },
		{ file: "packages/a/src/near.ts", lines: 350 },
	]);
});

test("the notice counts every file, names the closest, and is absent when none is near", (t) => {
	const root = repo(t, { "packages/a/src/full.ts": lines(400), "packages/a/src/near.ts": lines(351) });
	assert.equal(
		nearLimitNotice(root, 1),
		"note  2 source files are within 50 lines of the 400-line limit; plan a split before editing one. Closest: packages/a/src/full.ts (400).",
	);
	assert.equal(nearLimitNotice(repo(t, { "packages/a/src/short.ts": lines(10) })), undefined);
});

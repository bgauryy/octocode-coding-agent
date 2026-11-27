import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { renderThirdPartyNotices } from "./third-party-notices.mjs";

function tree(t, files) {
	const root = mkdtempSync(join(tmpdir(), "third-party-notices-test-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	for (const [path, contents] of Object.entries(files)) {
		mkdirSync(dirname(join(root, path)), { recursive: true });
		writeFileSync(join(root, path), contents);
	}
	return root;
}

test("lists each bundled package once with its license and skips repository sources", (t) => {
	const root = tree(t, {
		"repo/node_modules/@a/b/package.json": JSON.stringify({ name: "@a/b", version: "1.0.0", license: "MIT" }),
		"repo/node_modules/@a/b/LICENSE.md": "Copyright A",
		"repo/node_modules/c/package.json": JSON.stringify({ name: "c", version: "2.0.0", license: { type: "ISC" } }),
		"repo/packages/ai/package.json": JSON.stringify({ name: "@app/ai", version: "1.0.0", license: "MIT" }),
	});
	const { count, text } = renderThirdPartyNotices(
		[
			join(root, "repo/node_modules/@a/b/index.js"),
			join(root, "repo/node_modules/@a/b/lib/x.js"),
			join(root, "repo/node_modules/c/index.js"),
			join(root, "repo/packages/ai/dist/index.js"),
			"\0virtual",
		],
		join(root, "repo"),
	);
	assert.equal(count, 2);
	assert.match(text, /## @a\/b@1\.0\.0\n\nLicense: MIT\n\n```text\nCopyright A\n```/);
	assert.match(text, /## c@2\.0\.0\n\nLicense: ISC/);
	assert.doesNotMatch(text, /@app\/ai/);
});

test("lists a linked package outside the repository with its LICENSE and NOTICE", (t) => {
	// A `link:` dependency (the sandbox library fork) bundles from its real folder, which is not under node_modules.
	const root = tree(t, {
		"repo/package.json": JSON.stringify({ name: "repo", version: "0.0.0" }),
		"fork/package.json": JSON.stringify({ name: "@x/fork", version: "0.0.83-x.1", license: "Apache-2.0" }),
		"fork/LICENSE": "Apache License",
		"fork/NOTICE": "Fork notice",
		"fork/dist/package.json": JSON.stringify({ type: "module" }),
	});
	const { count, text } = renderThirdPartyNotices(
		[join(root, "fork/dist/index.js"), join(root, "fork/dist/sandbox/manager.js")],
		join(root, "repo"),
	);
	assert.equal(count, 1);
	assert.match(
		text,
		/## @x\/fork@0\.0\.83-x\.1\n\nLicense: Apache-2\.0\n\n```text\nApache License\n```\n\n```text\nFork notice\n```/,
	);
});

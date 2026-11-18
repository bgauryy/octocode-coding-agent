import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
	findPackageProblems,
	publishedManifest,
	resolveRegistryDependencies,
	rewriteOutsideLinks,
	stageProjectDocs,
} from "./publish-stage.mjs";
import { renderThirdPartyNotices } from "./third-party-notices.mjs";

const source = {
	name: "@scope/agent",
	version: "1.2.3",
	repository: { type: "git", url: "git+https://github.com/owner/repo.git" },
	scripts: { build: "x" },
	overrides: { a: "1" },
	devDependencies: { vitest: "1.0.0" },
	dependencies: { chalk: "1.0.0", "@scope/private": "1.2.3", photon: "2.0.0", sibling: "link:../sibling" },
	octocodeRelease: { runtime: ["photon"], registry: { sibling: "3.0.0" } },
};

function tree(t, files) {
	const root = mkdtempSync(join(tmpdir(), "publish-stage-test-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	for (const [path, contents] of Object.entries(files)) {
		mkdirSync(dirname(join(root, path)), { recursive: true });
		writeFileSync(join(root, path), contents);
	}
	return root;
}

const fitPackage = {
	"package.json": JSON.stringify({ name: "x", version: "1.0.0", dependencies: { photon: "2.0.0" } }),
	LICENSE: "MIT",
	"README.md": "# x",
	"dist/bundle/octocode.js": "export {};",
	"dist/bundle/db-writer-worker.js": `export {};${" ".repeat(2000)}`,
	"dist/bundle/archive-index-worker.js": `export {};${" ".repeat(2000)}`,
	"dist/bundle/cli.js": 'await import("./octocode.js");',
	"dist/licenses/THIRD_PARTY_NOTICES.md": "# notices",
	"docs/project/FEATURES.md": "# features",
	"dist/native/darwin/prebuilds/darwin-arm64/a.node": "",
};

test("keeps only what stays outside the bundle and drops development fields", () => {
	const published = publishedManifest(source);
	assert.deepEqual(published.dependencies, { photon: "2.0.0", sibling: "link:../sibling" });
	for (const field of ["scripts", "overrides", "devDependencies", "octocodeRelease"])
		assert.equal(published[field], undefined);
	assert.equal(source.dependencies.chalk, "1.0.0", "the source manifest is not changed");
});

test("leaves a manifest without octocodeRelease alone", () => {
	const plain = { name: "x", dependencies: { a: "1.0.0" } };
	assert.equal(publishedManifest(plain), plain);
});

test("rejects a release dependency that is not declared", () => {
	assert.throws(
		() => publishedManifest({ ...source, octocodeRelease: { runtime: ["absent"], registry: {} } }),
		/absent, which is not a dependency/,
	);
});

test("reports every dependency version missing from npm", () => {
	const view = (name) => (name === "there" ? { dist: { integrity: "sha512-x" }, gitHead: "abcdef123" } : undefined);
	const { packages, missing } = resolveRegistryDependencies({ there: "1.0.0", gone: "2.0.0", lost: "3.0.0" }, view);
	assert.deepEqual(missing, ["gone@2.0.0", "lost@3.0.0"]);
	assert.deepEqual(packages.there, { version: "1.0.0", integrity: "sha512-x", sourceRevision: "abcdef123" });
});

test("points links that leave the package at the release tag and keeps shipped ones", (t) => {
	const root = tree(t, {
		"README.md": "[root](../../README.md#setup) [doc](docs/a.md) [web](https://x.dev) [here](#top) [src](src/x.ts)",
		"docs/a.md": "[back](../README.md) [up](../../../CONFIG.md) [peer](b.md)",
		"docs/b.md": "b",
	});
	assert.equal(rewriteOutsideLinks(root, source, "packages/agent"), 3);
	const base = "https://github.com/owner/repo/blob/v1.2.3";
	assert.equal(
		readFileSync(join(root, "README.md"), "utf8"),
		`[root](${base}/README.md#setup) [doc](docs/a.md) [web](https://x.dev) [here](#top) [src](${base}/packages/agent/src/x.ts)`,
	);
	assert.equal(
		readFileSync(join(root, "docs/a.md"), "utf8"),
		`[back](../README.md) [up](${base}/CONFIG.md) [peer](b.md)`,
	);
});

test("leaves dated reviews and RFCs out of the shipped docs, and links to them point at the release tag", (t) => {
	const repo = tree(t, {
		"docs/FEATURES.md": "[rfc](RFC_ACP_EXPOSURE.md) [review](WEBVIEW_REVIEW.md#a) [peer](ENTITIES.md)",
		"docs/ENTITIES.md": "e",
		"docs/RFC_ACP_EXPOSURE.md": "rfc",
		"docs/WEBVIEW_REVIEW.md": "review",
		"docs/PROVIDER_PROTOCOL_AUDIT.md": "audit",
		"docs/FEATURE_VALIDATION.md": "validation",
		"docs/FEATURE_COVERAGE.md": "coverage",
		"docs/LIBRARY_ASSESSMENT.md": "assessment",
		"docs/PLUGINS_MODS_HOOKS_CONFORMANCE.md": "conformance",
		"docs/PLUGINS_MODS_HOOKS_ROLLOUT.md": "rollout",
	});
	const root = tree(t, { "docs/guide.md": "[audit](../../../docs/PROVIDER_PROTOCOL_AUDIT.md)" });
	assert.equal(stageProjectDocs(join(repo, "docs"), root, source, "packages/agent"), 2);
	assert.deepEqual(readdirSync(join(root, "docs/project")).sort(), ["ENTITIES.md", "FEATURES.md"]);
	rewriteOutsideLinks(root, source, "packages/agent");
	const base = "https://github.com/owner/repo/blob/v1.2.3";
	assert.equal(
		readFileSync(join(root, "docs/project/FEATURES.md"), "utf8"),
		`[rfc](${base}/docs/RFC_ACP_EXPOSURE.md) [review](${base}/docs/WEBVIEW_REVIEW.md#a) [peer](ENTITIES.md)`,
	);
	assert.equal(readFileSync(join(root, "docs/guide.md"), "utf8"), `[audit](${base}/docs/PROVIDER_PROTOCOL_AUDIT.md)`);
});

test("ships the repository docs with links that work from their new folder", (t) => {
	const repo = tree(t, {
		"docs/FEATURES.md":
			"[peer](ENTITIES.md#a) [own](../packages/agent/docs/guide.md#b) [root](../AGENTS.md) [src](../packages/agent/src/x.ts) [gone](MISSING.md) [web](https://x.dev)",
		"docs/ENTITIES.md": "e",
	});
	const root = tree(t, {
		"README.md": "[features](../../docs/FEATURES.md#c)",
		"docs/guide.md": "[entities](../../../docs/ENTITIES.md) [other](../../../docs/OTHER.md)",
	});
	assert.equal(stageProjectDocs(join(repo, "docs"), root, source, "packages/agent"), 2);
	rewriteOutsideLinks(root, source, "packages/agent");
	const base = "https://github.com/owner/repo/blob/v1.2.3";
	assert.equal(
		readFileSync(join(root, "docs/project/FEATURES.md"), "utf8"),
		`[peer](ENTITIES.md#a) [own](../guide.md#b) [root](${base}/AGENTS.md) [src](${base}/packages/agent/src/x.ts) [gone](${base}/docs/MISSING.md) [web](https://x.dev)`,
	);
	assert.equal(readFileSync(join(root, "README.md"), "utf8"), "[features](./docs/project/FEATURES.md#c)");
	assert.equal(
		readFileSync(join(root, "docs/guide.md"), "utf8"),
		`[entities](./project/ENTITIES.md) [other](${base}/docs/OTHER.md)`,
	);
});

test("accepts a package fit to publish", (t) => {
	assert.deepEqual(findPackageProblems(tree(t, fitPackage)), []);
});

test("names each reason a package must not reach npm", (t) => {
	const root = tree(t, {
		...fitPackage,
		"package.json": JSON.stringify({
			name: "x",
			dependencies: { a: "link:../a", b: "workspace:*" },
			scripts: { x: "y" },
		}),
		"dist/bundle/chunks/a.js": "",
		"dist/bundle/extra.js": "x".repeat(2000),
		"dist/bundle/octocode.js.map": "{}",
		"src/index.ts": "",
		".npmrc": "token",
		"docs/guide.md": "[ok](../README.md#x) [web](https://x.dev) [gone](missing.md#y)",
	});
	rmSync(join(root, "LICENSE"));
	rmSync(join(root, "dist/bundle/db-writer-worker.js"));
	const problems = findPackageProblems(root).join("\n");
	assert.doesNotMatch(problems, /README\.md#x|x\.dev/, "links that resolve or leave the package are not problems");
	for (const expected of [
		"local dependency a",
		"local dependency b",
		"development field in the manifest: scripts",
		"missing LICENSE",
		"missing dist/bundle/db-writer-worker.js",
		"the bundle has chunks",
		"more than one code file in the bundle: extra.js",
		"stray file: dist/bundle/octocode.js.map",
		"stray file: .npmrc",
		"source file: src/index.ts",
		"broken documentation link: docs/guide.md -> missing.md#y",
	])
		assert.ok(problems.includes(expected), `expected "${expected}" in:\n${problems}`);
});

test("lists each bundled package once with its license and skips repository sources", (t) => {
	const root = tree(t, {
		"node_modules/@a/b/package.json": JSON.stringify({ name: "@a/b", version: "1.0.0", license: "MIT" }),
		"node_modules/@a/b/LICENSE.md": "Copyright A",
		"node_modules/c/package.json": JSON.stringify({ name: "c", version: "2.0.0", license: { type: "ISC" } }),
	});
	const { count, text } = renderThirdPartyNotices([
		join(root, "node_modules/@a/b/index.js"),
		join(root, "node_modules/@a/b/lib/x.js"),
		join(root, "node_modules/c/index.js"),
		"/repo/packages/ai/dist/index.js",
		"\0virtual",
	]);
	assert.equal(count, 2);
	assert.match(text, /## @a\/b@1\.0\.0\n\nLicense: MIT\n\n```text\nCopyright A\n```/);
	assert.match(text, /## c@2\.0\.0\n\nLicense: ISC/);
	assert.doesNotMatch(text, /packages\/ai/);
});

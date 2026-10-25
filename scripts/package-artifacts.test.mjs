import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, parse } from "node:path";
import test from "node:test";
import { produceArtifactSet, readArtifactSet } from "./package-artifacts.mjs";
import { installConsumer } from "./local-package-install.mjs";

function writePackage(directory, manifest, files) {
	mkdirSync(directory, { recursive: true });
	writeFileSync(join(directory, "package.json"), `${JSON.stringify(manifest, null, "\t")}\n`);
	for (const [path, contents] of Object.entries(files)) {
		mkdirSync(dirname(join(directory, path)), { recursive: true });
		writeFileSync(join(directory, path), contents);
	}
}

// #10633: Covers npm 12's package-keyed `npm pack --json` output only when npm 12 is on PATH.
test("produces a verified, content-addressed artifact set", (t) => {
	const temporaryRoot = mkdtempSync(join(tmpdir(), "pi-package-artifacts-test-"));
	t.after(() => rmSync(temporaryRoot, { recursive: true, force: true }));
	const repoRoot = join(temporaryRoot, "repo with spaces");
	mkdirSync(repoRoot);
	writeFileSync(join(repoRoot, "package.json"), '{"name":"fixture","private":true}\n');
	writePackage(
		join(repoRoot, "packages", "shared"),
		{ name: "@pi-package-test/shared", version: "1.0.0", files: ["dist"] },
		{ "dist/index.js": 'export const marker = "artifact";\n' },
	);
	writePackage(
		join(repoRoot, "packages", "target"),
		{
			name: "@pi-package-test/target",
			version: "1.0.0",
			files: ["dist"],
			devDependencies: { "@pi-package-test/private": "workspace:*" },
		},
		{ "dist/index.js": "export const target = true;\n" },
	);
	writePackage(
		join(repoRoot, "packages", "private"),
		{ name: "@pi-package-test/private", version: "1.0.0", private: true },
		{ "src/index.ts": "export const internal = true;\n" },
	);
	execFileSync("git", ["init", "--quiet"], { cwd: repoRoot });
	execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoRoot });
	execFileSync("git", ["config", "user.name", "Test"], { cwd: repoRoot });
	execFileSync("git", ["add", "."], { cwd: repoRoot });
	execFileSync("git", ["commit", "--quiet", "-m", "fixture"], { cwd: repoRoot });

	const artifactSet = produceArtifactSet({
		build: false,
		outDir: join(repoRoot, ".artifacts", "package set"),
		repoRoot,
	});
	assert.deepEqual(
		artifactSet.packages.map((pkg) => pkg.name),
		["@pi-package-test/shared", "@pi-package-test/target"],
	);
	for (const pkg of artifactSet.packages) {
		assert.match(pkg.tarball, /-[0-9a-f]{12}\.tgz$/);
		assert.match(pkg.integrity, /^sha512-/);
	}
	assert.equal(artifactSet.source.dirty, false);
	assert.equal(readArtifactSet(artifactSet.manifestPath).packages.length, 2);

	writeFileSync(join(repoRoot, "packages/shared/dist/index.js"), 'export const marker = "changed";\n');
	const changedArtifactSet = produceArtifactSet({
		build: false,
		outDir: join(repoRoot, ".artifacts", "changed package set"),
		repoRoot,
	});
	assert.notEqual(
		changedArtifactSet.getPackage("@pi-package-test/shared").tarball,
		artifactSet.getPackage("@pi-package-test/shared").tarball,
	);

	appendFileSync(artifactSet.packages[0].tarballPath, "corrupt");
	assert.throws(() => readArtifactSet(artifactSet.manifestPath), /integrity mismatch/);
	const packageJsonPath = join(repoRoot, "packages", "shared", "package.json");
	assert.throws(
		() => produceArtifactSet({ build: false, force: true, outDir: join(repoRoot, "packages", "shared"), repoRoot }),
		/Repository-local output directory must be inside.*\.artifacts/,
	);
	assert.equal(existsSync(packageJsonPath), true);
	assert.throws(
		() => produceArtifactSet({ build: false, force: true, outDir: repoRoot, repoRoot }),
		/repository, its ancestor, or a filesystem root/,
	);
	assert.throws(
		() => produceArtifactSet({ build: false, force: true, outDir: temporaryRoot, repoRoot }),
		/repository, its ancestor, or a filesystem root/,
	);
	assert.throws(
		() => produceArtifactSet({ build: false, force: true, outDir: parse(repoRoot).root, repoRoot }),
		/repository, its ancestor, or a filesystem root/,
	);
});

for (const protocol of ["file:", "link:"])
	test(`${protocol} development artifacts install without modifying the source manifest`, (t) => {
		const temporaryRoot = mkdtempSync(join(tmpdir(), "octocode-local-artifacts-test-"));
		t.after(() => rmSync(temporaryRoot, { recursive: true, force: true }));
		const repoRoot = join(temporaryRoot, "repo");
		const localPackage = join(temporaryRoot, "local dependency");
		writePackage(
			localPackage,
			{ name: "local-helper", version: "1.0.0", type: "module", main: "./index.js" },
			{ "index.js": 'export const marker = "local dependency";\n' },
		);
		const target = join(repoRoot, "packages", "target");
		const manifest = {
			name: "@octocode-test/target",
			version: "1.0.0",
			type: "module",
			main: "./dist/index.js",
			files: ["dist"],
			dependencies: { "local-helper": `${protocol}../../../local dependency` },
		};
		writePackage(target, manifest, { "dist/index.js": 'export { marker } from "local-helper";\n' });
		const sourceBefore = readFileSync(join(target, "package.json"), "utf8");
		const artifacts = produceArtifactSet({ repoRoot, build: false, source: { commit: "fixture", dirty: false } });
		t.after(() => rmSync(artifacts.artifactDirectory, { recursive: true, force: true }));
		const packed = artifacts.getPackage(manifest.name);
		const packedManifest = JSON.parse(
			execFileSync("tar", ["-xOf", packed.tarballPath, "package/package.json"], { encoding: "utf8" }),
		);
		assert.equal(packedManifest.dependencies["local-helper"], `file:${localPackage}`);
		assert.deepEqual(packed.localDependencies, { "local-helper": `file:${localPackage}` });
		assert.equal(readFileSync(join(target, "package.json"), "utf8"), sourceBefore);
		const consumer = join(temporaryRoot, "consumer");
		installConsumer({ artifactSet: artifacts, directory: consumer, packageNames: [manifest.name] });
		const output = execFileSync(
			process.execPath,
			["--input-type=module", "-e", `import { marker } from "${manifest.name}"; console.log(marker);`],
			{ cwd: consumer, encoding: "utf8" },
		);
		assert.equal(output.trim(), "local dependency");
	});

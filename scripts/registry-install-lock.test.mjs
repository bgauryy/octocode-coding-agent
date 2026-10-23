import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("generates and checks a dedicated registry installer lock without a root npm lock", (t) => {
	const root = mkdtempSync(join(tmpdir(), "octocode-registry-lock-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const resolution = join(root, "resolution");
	const out = join(root, "output");
	mkdirSync(resolution);
	const agent = "@octocodeai/octocodecode";
	const manifest = { name: "@octocodeai/octocodecode-install", version: "1.3.0", private: true, dependencies: { [agent]: "1.3.0" } };
	const lock = { name: manifest.name, version: manifest.version, lockfileVersion: 3, packages: {
		"": { name: manifest.name, version: manifest.version, dependencies: manifest.dependencies },
		[`node_modules/${agent}`]: { version: manifest.version, resolved: "https://registry.npmjs.org/cli.tgz", integrity: "sha512-test" },
	} };
	writeFileSync(join(resolution, "package.json"), JSON.stringify(manifest));
	writeFileSync(join(resolution, "package-lock.json"), JSON.stringify(lock));
	const script = join(import.meta.dirname, "generate-coding-agent-install-lock.mjs");
	const args = [script, "--resolution-dir", resolution, "--out", out, "--registry", "https://registry.npmjs.org"];
	execFileSync(process.execPath, args, { stdio: "pipe" });
	assert.deepEqual(JSON.parse(readFileSync(join(out, "package-lock.json"), "utf8")), lock);
	execFileSync(process.execPath, [...args, "--check"], { stdio: "pipe" });
	lock.packages[`node_modules/${agent}`].resolved = "file:../cli.tgz";
	writeFileSync(join(resolution, "package-lock.json"), JSON.stringify(lock));
	assert.throws(() => execFileSync(process.execPath, [...args, "--check"], { stdio: "pipe" }), /Command failed/);
});

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("prepare keeps exact candidate bytes for a later fixture verification and rejects tampering", (t) => {
	const root = mkdtempSync(join(tmpdir(), "octocode-stage-registry-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const output = join(root, "candidate");
	const map = join(root, "reviewed.json");
	const packages = Object.fromEntries(
		["@octocodeai/octocode-native", "octocode", "octocode-mcp"].map((name) => [
			name,
			{
				version: "20.2.0",
				sourceRevision: "abcdef123456",
				integrity: `sha512-${Buffer.alloc(64, 1).toString("base64")}`,
			},
		]),
	);
	writeFileSync(map, JSON.stringify({ schemaVersion: 1, packages }));
	const args = [
		join(import.meta.dirname, "stage-registry-release.mjs"),
		"--map",
		map,
		"--out",
		output,
		"--registry",
		"http://127.0.0.1:4873/",
	];
	const env = {
		...process.env,
		HOME: root,
		npm_config_cache: join(root, "cache"),
		npm_config_userconfig: join(root, "npmrc"),
		npm_config_fetch_retries: "0",
	};
	execFileSync(process.execPath, [...args, "--prepare"], { env, stdio: "pipe", timeout: 120_000 });
	const candidate = JSON.parse(readFileSync(join(output, "candidate.json"), "utf8"));
	assert.equal(candidate.packages.length, 1);
	assert.throws(
		() =>
			execFileSync(process.execPath, [...args.slice(0, -1), "http://127.0.0.1:4874/", "--verify"], {
				env,
				stdio: "pipe",
				timeout: 30_000,
			}),
		(error) =>
			!String(error.stderr).includes("Candidate manifest does not match") && String(error.stderr).includes("npm"),
	);
	const tarball = join(output, candidate.packages[0].tarball);
	writeFileSync(tarball, "changed");
	assert.throws(
		() => execFileSync(process.execPath, [...args, "--verify"], { env, stdio: "pipe", timeout: 120_000 }),
		/Command failed/,
	);
	assert.deepEqual(JSON.parse(readFileSync(join(output, "candidate.json"), "utf8")), candidate);
});

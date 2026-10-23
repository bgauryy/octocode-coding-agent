import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { validateLocalDependencies } from "./local-dependencies.mjs";

function fixture(t, { name = "research-cli", installed = true, executable = true } = {}) {
	const root = mkdtempSync(join(tmpdir(), "octocode-local-dependencies-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const agent = join(root, "agent");
	const dependency = join(root, "dependency");
	mkdirSync(join(agent, "node_modules"), { recursive: true });
	mkdirSync(dependency);
	writeFileSync(
		join(agent, "package.json"),
		JSON.stringify({ dependencies: { "research-cli": "file:../dependency" } }),
	);
	writeFileSync(join(dependency, "package.json"), JSON.stringify({ name, version: "1.0.0", bin: "cli.js" }));
	if (executable) writeFileSync(join(dependency, "cli.js"), "");
	if (installed) symlinkSync(dependency, join(agent, "node_modules/research-cli"), "junction");
	return agent;
}

test("validates local source identity and installed executable", (t) => {
	assert.deepEqual(validateLocalDependencies(fixture(t)), ["research-cli"]);
});

test("rejects a local directory containing the wrong package", (t) => {
	assert.throws(() => validateLocalDependencies(fixture(t, { name: "unrelated" })), /resolves to package unrelated/);
});

test("rejects a missing local installation", (t) => {
	assert.throws(() => validateLocalDependencies(fixture(t, { installed: false })), /is not installed from/);
});

test("rejects a missing local CLI build", (t) => {
	assert.throws(() => validateLocalDependencies(fixture(t, { executable: false })), /CLI is missing/);
});

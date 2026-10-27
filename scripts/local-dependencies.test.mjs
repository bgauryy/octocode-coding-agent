import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { validateLocalDependencies } from "./local-dependencies.mjs";

function fixture(t, { name = "research-cli", installed = true, executable = true, bin = "cli.js" } = {}) {
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
	writeFileSync(join(dependency, "package.json"), JSON.stringify({ name, version: "1.0.0", ...(bin ? { bin } : {}) }));
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

test("accepts a bin-less library through its declared entry files, and only those", (t) => {
	const entries = { "research-cli": ["cli.js"] };
	assert.deepEqual(validateLocalDependencies(fixture(t, { bin: "" }), entries), ["research-cli"]);
	assert.throws(() => validateLocalDependencies(fixture(t, { bin: "", executable: false }), entries), /CLI is missing/);
	assert.throws(() => validateLocalDependencies(fixture(t, { bin: "" }), {}), /declares no CLI executable/);
});

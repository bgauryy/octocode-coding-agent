#!/usr/bin/env node
// Runs the repository script tests and every workspace's `test` script, continuing past failures so one failing
// suite does not hide the others (`yarn workspaces foreach` stops at the first). Exits non-zero if any suite failed.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runTestCommand, runTestSuites } from "./run-test-suites.mjs";

const repoRoot = process.cwd();
const rootName = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).name;
if (rootName !== "@octocodeai/octocode-monorepo") throw new Error("Run this script from the repository root");

const discovery = await runTestCommand(["workspaces", "list", "--json"], { captureOutput: true });
if (discovery.code !== 0) {
	if (discovery.signal) console.error("Cancelled:", discovery.signal);
	process.exit(discovery.code);
}
const workspaces = discovery.output
	.trim()
	.split("\n")
	.map((line) => JSON.parse(line))
	.filter(({ name, location }) => {
		if (name === rootName) return false;
		return Boolean(JSON.parse(readFileSync(join(repoRoot, location, "package.json"), "utf8")).scripts?.test);
	});

const args = process.argv.slice(2);
process.exitCode = await runTestSuites([
	{ label: "scripts", args: ["run", "test:scripts", ...args] },
	...workspaces.map(({ name }) => ({ label: name, args: ["workspace", name, "run", "test", ...args] })),
]);

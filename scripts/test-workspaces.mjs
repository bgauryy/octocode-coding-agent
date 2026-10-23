#!/usr/bin/env node
// Runs the repository script tests and every workspace's `test` script, continuing past failures so one failing
// suite does not hide the others (`yarn workspaces foreach` stops at the first). Exits non-zero if any suite failed.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { execYarnSync } from "./yarn-command.mjs";

const repoRoot = process.cwd();
const rootName = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).name;
if (rootName !== "@octocodeai/octocode-monorepo") throw new Error("Run this script from the repository root");

const workspaces = execYarnSync(["workspaces", "list", "--json"], { cwd: repoRoot, encoding: "utf8" })
	.trim()
	.split("\n")
	.map((line) => JSON.parse(line))
	.filter(({ name, location }) => {
		if (name === rootName) return false;
		return Boolean(JSON.parse(readFileSync(join(repoRoot, location, "package.json"), "utf8")).scripts?.test);
	});

const suites = [
	{ label: "scripts", args: ["run", "test:scripts"] },
	...workspaces.map(({ name }) => ({ label: name, args: ["workspace", name, "run", "test"] })),
];
const failed = [];
for (const suite of suites) {
	console.log(`\n==> ${suite.label}`);
	try {
		execYarnSync(suite.args, { cwd: repoRoot, stdio: "inherit" });
	} catch {
		failed.push(suite.label);
	}
}

console.log(`\n${suites.length - failed.length}/${suites.length} test suites passed.`);
if (failed.length > 0) {
	console.error(`Failed: ${failed.join(", ")}`);
	process.exitCode = 1;
}

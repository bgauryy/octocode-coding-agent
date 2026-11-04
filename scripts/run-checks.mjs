#!/usr/bin/env node
// Runs root `yarn run` scripts in parallel and reports every failure, not only the first: `yarn run check` lists its
// checks here. A passing check prints one line; a failing one prints its whole output. Exits non-zero on any failure.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { nearLimitNotice } from "./near-limit-files.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const yarn = join(repoRoot, readFileSync(join(repoRoot, ".yarnrc.yml"), "utf8").match(/^yarnPath:\s*(\S+)\s*$/m)[1]);
const scripts = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).scripts;

const names = process.argv.slice(2);
if (names.length === 0) throw new Error("Usage: node scripts/run-checks.mjs <script>...");
const unknown = names.filter((name) => !scripts[name]);
if (unknown.length > 0) throw new Error(`Unknown root scripts: ${unknown.join(", ")}`);

/** Runs one script with its output buffered, so parallel checks do not interleave. */
function run(name) {
	const startedAt = performance.now();
	return new Promise((done) => {
		const child = spawn(process.execPath, [yarn, "run", name], {
			cwd: repoRoot,
			env: { ...process.env, FORCE_COLOR: "1" },
		});
		let output = "";
		child.stdout.on("data", (chunk) => (output += chunk));
		child.stderr.on("data", (chunk) => (output += chunk));
		const finish = (code) => {
			const seconds = ((performance.now() - startedAt) / 1000).toFixed(1);
			if (code === 0) console.log(`ok    ${name} (${seconds}s)`);
			else console.log(`\nFAIL  ${name} (${seconds}s)\n${output.trimEnd()}\n`);
			done(code === 0);
		};
		child.once("error", (error) => {
			output += String(error);
			finish(1);
		});
		child.once("close", finish);
	});
}

const results = await Promise.all(names.map(run));
// Advice only: reading the tree must never change what the checks decided.
try {
	const notice = nearLimitNotice(repoRoot);
	if (notice) console.log(`\n${notice}`);
} catch {
	// The checks above still stand.
}
const failed = names.filter((_, index) => !results[index]);
if (failed.length > 0) {
	console.error(`\n${failed.length}/${names.length} checks failed: ${failed.join(", ")}`);
	process.exitCode = 1;
} else console.log(`\nAll ${names.length} checks passed.`);

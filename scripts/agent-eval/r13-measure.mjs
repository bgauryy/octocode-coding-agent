#!/usr/bin/env node
// R13: runs the event-loop measurements (packages/coding-agent/test/octocode/r13/) on a scripted model, no network, and
// prints a Markdown table of the numbers each case recorded. Usage:
//   node scripts/agent-eval/r13-measure.mjs [--out <file.jsonl>] [--tree <dir>] [--configs '<json>']
// `--tree` runs the same test files from another checkout (copy test/octocode/r13 into it first) so an older tree that still
// has the wake gate gives the "old" columns; `--configs` lists `{name, settings}` objects (see test/octocode/r13/lib.ts).
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const args = process.argv.slice(2);
const opt = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const tree = path.resolve(opt("--tree", root));
const out = path.resolve(opt("--out", path.join(root, ".octocode/agent/tmp/r13/run.jsonl")));
const env = { ...process.env, R13_OUT: out };
if (opt("--configs")) env.R13_CONFIGS = opt("--configs");
rmSync(out, { force: true });

const run = spawnSync("yarn", ["vitest", "run", "--config", "vitest.octocode.config.ts", "test/octocode/r13"], {
	cwd: path.join(tree, "packages/coding-agent"),
	env,
	stdio: ["ignore", "inherit", "inherit"],
});
if (!existsSync(out)) {
	console.error("no measurements were recorded");
	// A clean exit without a measurement file is still a failure.
	process.exit(Math.max(run.status ?? 1, 1));
}
const rows = readFileSync(out, "utf8")
	.trim()
	.split("\n")
	.map((line) => JSON.parse(line));
for (const scenario of new Set(rows.map((row) => row.scenario))) {
	const own = rows.filter((row) => row.scenario === scenario);
	const keys = [...new Set(own.flatMap((row) => Object.keys(row)))].filter((key) => key !== "scenario");
	console.log(`\n### ${scenario}\n\n| ${keys.join(" | ")} |\n| ${keys.map(() => "---").join(" | ")} |`);
	for (const row of own) console.log(`| ${keys.map((key) => row[key] ?? "").join(" | ")} |`);
}
process.exit(run.status ?? 1);

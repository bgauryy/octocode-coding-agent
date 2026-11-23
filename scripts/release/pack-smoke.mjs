#!/usr/bin/env node
// Proves the testkit tarball works in a fresh project: packs the package, installs the tarball and Vitest from the npm
// registry into a temporary project, writes the README's `vitest.config.ts` and quickstart test (taken from the README
// itself, so docs and proof cannot drift) and runs it.
//   node scripts/release/pack-smoke.mjs [--keep] [--build]   needs network for the registry; --keep leaves the project;
//                                                    --build rebuilds `dist` first when it is missing or stale
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const PKG_DIR = join(ROOT, "packages", "octocode-agentic-testkit");
const NAME = JSON.parse(readFileSync(join(PKG_DIR, "package.json"), "utf8")).name;
const args = new Set(process.argv.slice(2));
const keep = args.has("--keep");

function run(command, commandArgs, cwd, label) {
	const result = spawnSync(command, commandArgs, { cwd, encoding: "utf8", timeout: 600_000 });
	if (result.status !== 0)
		throw new Error(`${label} failed (exit ${result.status}):\n${result.stdout ?? ""}${result.stderr ?? ""}`);
	return result.stdout;
}

/** The first code fence of `lang` under the README heading `## <heading>`. */
function readmeBlock(readme, heading, lang) {
	const start = readme.indexOf(`\n## ${heading}\n`);
	if (start < 0) throw new Error(`README has no "## ${heading}" section`);
	const match = new RegExp(`\`\`\`${lang}\\n([\\s\\S]*?)\`\`\``).exec(readme.slice(start + 1));
	if (!match) throw new Error(`README "## ${heading}" has no ${lang} block`);
	return match[1];
}

function ensureFreshDist() {
	const status = run(process.execPath, ["scripts/check-consumer.mjs", "--dist-status"], PKG_DIR, "dist status").trim();
	if (status === "fresh") return;
	if (!args.has("--build")) throw new Error(`${status}\nrerun with --build to rebuild it`);
	run("yarn", ["workspace", NAME, "run", "build"], ROOT, "build");
}

const readme = readFileSync(join(PKG_DIR, "README.md"), "utf8");
const config = readmeBlock(readme, "Set up", "ts");
const quickstart = readmeBlock(readme, "Your first test", "ts");

ensureFreshDist();
const work = mkdtempSync(join(tmpdir(), "testkit-pack-smoke-"));
try {
	// `--ignore-scripts`: the prepack hook would rebuild and run the consumer check; dist was just verified fresh.
	const packed = run("npm", ["pack", "--ignore-scripts", "--silent", "--pack-destination", work], PKG_DIR, "npm pack")
		.trim()
		.split("\n")
		.at(-1);
	const tarball = join(work, packed);
	const project = join(work, "project");
	mkdirSync(join(project, "test"), { recursive: true });
	writeFileSync(
		join(project, "package.json"),
		JSON.stringify({ name: "testkit-smoke", private: true, type: "module" }),
	);
	const versions = JSON.parse(readFileSync(join(PKG_DIR, "package.json"), "utf8")).peerDependencies;
	run(
		"npm",
		["install", "--save-dev", "--no-audit", "--no-fund", tarball, `vitest@${versions.vitest}`, "@types/node@24"],
		project,
		"npm install",
	);
	writeFileSync(join(project, "vitest.config.ts"), config);
	writeFileSync(join(project, "test", "quickstart.test.ts"), quickstart);
	const output = run("npx", ["vitest", "run"], project, "quickstart test");
	const passed = /Tests\s+(\d+) passed/.exec(output);
	if (!passed) throw new Error(`quickstart did not report a passing test:\n${output}`);
	console.log(`pack-smoke ok: ${packed} installed in a fresh project; quickstart ${passed[1]} passed`);
	if (keep) console.log(`kept ${project}`);
} finally {
	if (!keep) rmSync(work, { recursive: true, force: true });
}

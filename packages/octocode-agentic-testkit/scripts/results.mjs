#!/usr/bin/env node
// Lists saved test results, prints one as Markdown, or writes one static HTML report:
//   yarn results [dir] [substring]
//   yarn results --html [dir] [out.html]    (out defaults to <dir>/index.html)
// Imports src/*.ts directly through Node's built-in type stripping (Node >= 24).
import { existsSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderResultsHtml } from "../src/results-html.ts";
import { loadResults, renderResult, summarizeResults } from "../src/results.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fallback = resolve(here, "../../../.octocode/tmp/testkit-results");
const args = process.argv.slice(2);
const html = args[0] === "--html";
if (html) args.shift();
const isDir = (p) => existsSync(p) && statSync(p).isDirectory();
// Two arguments are always `dir second`; one is a dir only when it is an existing directory.
const dirArg = args.length > 1 || (args.length && isDir(args[0])) ? args.shift() : undefined;
const dir = resolve(dirArg ?? process.env.TESTKIT_RESULTS_DIR ?? fallback);
const second = args[0];

if (!existsSync(dir)) {
	console.error(`No results at ${dir}. Run tests with TESTKIT_RESULTS_DIR set.`);
	process.exit(1);
}

if (html) {
	if (second !== undefined && !second.endsWith(".html")) {
		console.error(`--html: "${second}" is neither an existing directory nor an .html output path`);
		process.exit(1);
	}
	const out = resolve(second ?? join(dir, "index.html"));
	const rows = summarizeResults(dir);
	writeFileSync(out, renderResultsHtml(dir));
	const failing = rows.filter((r) => r.state === "fail" || r.failedChecks).length;
	console.log(`${rows.length} results, ${failing} failing: ${out}`);
} else if (second) {
	const hit = loadResults(dir).find((r) => `${r.summary.file} ${r.summary.test}`.includes(second));
	if (!hit) {
		console.error(`No result matches "${second}" in ${dir}`);
		process.exit(1);
	}
	process.stdout.write(renderResult(hit.json));
} else {
	const rows = summarizeResults(dir);
	if (!rows.length) console.log(`No results in ${dir}`);
	for (const r of rows) {
		const bad = r.failedChecks ? `  failed: ${r.failedChecks.join(", ")}` : "";
		console.log(`${r.state.padEnd(8)} ${r.requests} req ${r.events} ev  ${r.file} > ${r.test}${bad}`);
	}
}

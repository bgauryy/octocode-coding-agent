#!/usr/bin/env node
/**
 * Pi-name ratchet. This fork still mentions Pi on purpose (configuration fallback and import, attribution, upstream
 * links, history) and by inheritance (identifiers, comments, test names, persisted names awaiting migration).
 * `scripts/pi-names-baseline.json` records how many Pi tokens each tracked or untracked, non-ignored text file has.
 *
 * The check fails when a file has more tokens than its baseline (new inherited naming) or fewer (the baseline is stale:
 * run `--update` so the improvement cannot be undone). A new intentional reference (Pi compatibility, attribution or
 * history) is recorded with `--update`; the baseline diff shows it in review.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const baselinePath = join(root, "scripts/pi-names-baseline.json");
const SELF = new Set([
	"scripts/check-pi-names.mjs",
	"scripts/check-pi-names.test.mjs",
	"scripts/pi-names-baseline.json",
]);
/** Third-party code that only happens to contain the letters: Yarn's release and vendored minified bundles. */
const VENDORED = [/^\.yarn\//, /\/vendor\//, /\.min\.js$/];

/**
 * Pi as a word or identifier segment: `pi`, `Pi`, `pi-trust`, `pi.ai`, `pi_tool_name`, `piDir`, `getPiUserAgent`,
 * `PiAnthropic`, `PI_NAPI_CALL`, plus upstream author and organization names. `Math.PI`, `api` and `pipe` do not match.
 */
const PI_TOKEN =
	/(?<![A-Za-z0-9])[Pp]i(?![a-z0-9])|(?<=[a-z0-9])Pi(?![a-z0-9])|(?<![A-Za-z0-9])PI_[A-Z0-9]|(?<=[A-Z0-9]_)PI(?![A-Za-z0-9])|mariozechner|Mario Zechner|earendil-works|badlogic/g;

export function countPiTokens(text) {
	return text.match(PI_TOKEN)?.length ?? 0;
}

/** Per-file differences between current counts and the baseline. */
export function compareToBaseline(counts, baseline) {
	const grown = [];
	const shrunk = [];
	for (const file of new Set([...Object.keys(counts), ...Object.keys(baseline)])) {
		const now = counts[file] ?? 0;
		const allowed = baseline[file] ?? 0;
		if (now > allowed) grown.push({ file, now, allowed });
		else if (now < allowed) shrunk.push({ file, now, allowed });
	}
	const byFile = (a, b) => a.file.localeCompare(b.file);
	return { grown: grown.sort(byFile), shrunk: shrunk.sort(byFile) };
}

function listFiles() {
	const run = spawnSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
		cwd: root,
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
	});
	if (run.status !== 0) throw new Error(`git ls-files failed: ${run.stderr}`);
	return run.stdout.split("\0").filter((file) => file && !SELF.has(file) && !VENDORED.some((re) => re.test(file)));
}

export function scanCounts(files = listFiles()) {
	const counts = {};
	for (const file of files) {
		let buffer;
		try {
			buffer = readFileSync(join(root, file));
		} catch {
			continue; // deleted from the working tree but still in the index
		}
		if (buffer.subarray(0, 8000).includes(0)) continue; // binary
		const count = countPiTokens(buffer.toString("utf8"));
		if (count > 0) counts[file] = count;
	}
	return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

function main() {
	const counts = scanCounts();
	if (process.argv.includes("--update")) {
		writeFileSync(baselinePath, `${JSON.stringify(counts, null, "\t")}\n`);
		const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
		console.log(`Pi-name baseline: ${total} tokens in ${Object.keys(counts).length} files`);
		return;
	}
	const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
	const { grown, shrunk } = compareToBaseline(counts, baseline);
	const list = (rows) => rows.map(({ file, now, allowed }) => `  ${file}: ${now} (baseline ${allowed})`).join("\n");
	if (grown.length > 0) {
		console.error(
			`New Pi names. Use Octocode names; if the reference is intentional (Pi compatibility, attribution, history), run node scripts/check-pi-names.mjs --update:\n${list(grown)}`,
		);
	}
	if (shrunk.length > 0) {
		console.error(
			`Fewer Pi names than the baseline; run node scripts/check-pi-names.mjs --update to lock it in:\n${list(shrunk)}`,
		);
	}
	if (grown.length > 0 || shrunk.length > 0) process.exit(1);
	const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
	console.log(`Pi-name baseline: ${total} tokens in ${Object.keys(counts).length} files`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();

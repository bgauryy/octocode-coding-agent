#!/usr/bin/env node
/**
 * Ratchet on test constructs that make a green run untrustworthy: slow real-time sleeps, wall-clock bounds and short
 * polling timeouts. Per test file it counts
 *   - awaited sleeps of >= 100 ms (`await new Promise(r => setTimeout(r, 500))`, `await sleep(200)`, timers/promises),
 *   - `toBeLessThan(OrEqual)` on a Date.now()/performance.now() difference (elapsed-time bounds),
 *   - `vi.waitFor` / `expect.poll` calls whose literal `timeout` is below the suite's configured `testTimeout`.
 * The counts are compared with `test-trust.baseline.json`: a file whose count rises, or a new file with a nonzero
 * count, fails. `--update` rewrites the baseline and refuses to raise any count; it only shrinks or removes entries.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const packages = join(root, "packages");
/** `TEST_TRUST_BASELINE` points the script at another file: its own test uses a temporary one. */
const baselinePath =
	process.env.TEST_TRUST_BASELINE ?? fileURLToPath(new URL("./test-trust.baseline.json", import.meta.url));

export const MIN_SLEEP_MS = 100;
/** Vitest's own default when a package configures no `testTimeout`. */
export const VITEST_DEFAULT_TIMEOUT_MS = 5000;
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
const SKIPPED_DIRS = new Set(["node_modules", "dist", ".git", "fixtures"]);

const num = (text) => Number(text.replaceAll("_", ""));

/** Text of the balanced parentheses that open at `open` (the index of `(`), or the rest of the file when unbalanced. */
function callArgs(text, open) {
	let depth = 0;
	for (let i = open; i < text.length; i++) {
		if (text[i] === "(") depth++;
		else if (text[i] === ")" && --depth === 0) return text.slice(open + 1, i);
	}
	return text.slice(open + 1);
}

/** Awaited sleeps of at least `MIN_SLEEP_MS`. */
export function countSleeps(text) {
	let count = 0;
	const big = (digits) => num(digits) >= MIN_SLEEP_MS;
	for (const m of text.matchAll(/await\s+new\s+Promise\b\s*(?:<[^>(]*>)?\s*\(/g)) {
		const args = callArgs(text, m.index + m[0].length - 1);
		for (const [, ms] of args.matchAll(/setTimeout\(\s*[^,()]+,\s*(\d[\d_]*)\s*\)/g)) if (big(ms)) count++;
	}
	for (const [, ms] of text.matchAll(
		/await\s+(?:\w+\.)?(?:sleep|delay|wait|pause|nap|timeout)\w*\(\s*(\d[\d_]*)\s*[,)]/gi,
	))
		if (big(ms)) count++;
	if (/from\s+["'](?:node:)?timers\/promises["']/.test(text))
		for (const [, ms] of text.matchAll(/await\s+setTimeout\(\s*(\d[\d_]*)\s*[,)]/g)) if (big(ms)) count++;
	return count;
}

/** `toBeLessThan(OrEqual)` assertions on a clock difference: direct, through a derived variable, or `end - start`. */
export function countElapsedBounds(text) {
	const clock = /(?:Date|performance)\.now\(\)/;
	const words = (code) => code.match(/\b[A-Za-z_]\w*\b/g) ?? [];
	const clockVars = new Set();
	const elapsedVars = new Set();
	const assignments = [...text.matchAll(/\b(?:const|let|var)\s+(\w+)\s*=\s*([^;\n]*)/g)];
	for (const [, name, rhs] of assignments) if (clock.test(rhs) && !rhs.includes(" - ")) clockVars.add(name);
	// Repeat so a difference of differences resolves whatever the declaration order.
	for (let changed = true; changed;) {
		changed = false;
		for (const [, name, rhs] of assignments) {
			if (elapsedVars.has(name) || !rhs.includes(" - ")) continue;
			if (clock.test(rhs) || words(rhs).some((w) => clockVars.has(w) || elapsedVars.has(w))) {
				elapsedVars.add(name);
				changed = true;
			}
		}
	}
	const isElapsed = (subject) =>
		clock.test(subject) ||
		elapsedVars.has(subject) ||
		(subject.includes(" - ") && words(subject).some((w) => clockVars.has(w)));
	let count = 0;
	for (const line of text.split("\n")) {
		const m = /expect\((.*)\)\s*\.toBeLessThan(?:OrEqual)?\(/.exec(line);
		if (m && isElapsed(m[1].trim())) count++;
	}
	return count;
}

/** `vi.waitFor` / `expect.poll` calls with a literal `timeout` below `minTimeoutMs`. */
export function countShortPolls(text, minTimeoutMs = VITEST_DEFAULT_TIMEOUT_MS) {
	let count = 0;
	for (const m of text.matchAll(/(?:\bvi\.waitFor|\.poll)\s*\(/g)) {
		const args = callArgs(text, m.index + m[0].length - 1);
		const timeout = /\btimeout\s*:\s*(\d[\d_]*)/.exec(args);
		if (timeout && num(timeout[1]) < minTimeoutMs) count++;
	}
	return count;
}

/** Total count for one file's text. */
export function countFile(text, minTimeoutMs) {
	return countSleeps(text) + countElapsedBounds(text) + countShortPolls(text, minTimeoutMs);
}

/** Smallest `testTimeout` a package's vitest configs set, else vitest's default. */
export function configuredTimeout(configTexts) {
	const values = configTexts.flatMap((t) => [...t.matchAll(/\btestTimeout\s*:\s*(\d[\d_]*)/g)].map((m) => num(m[1])));
	return values.length ? Math.min(...values) : VITEST_DEFAULT_TIMEOUT_MS;
}

function walk(dir, out = []) {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.isDirectory()) {
			if (!SKIPPED_DIRS.has(entry.name)) walk(join(dir, entry.name), out);
		} else if (TEST_FILE.test(entry.name)) out.push(join(dir, entry.name));
	}
	return out;
}

/** `{ "packages/x/test/a.test.ts": n }` for every test file with a nonzero count. */
export function measure() {
	const counts = {};
	for (const pkg of readdirSync(packages, { withFileTypes: true })) {
		if (!pkg.isDirectory()) continue;
		const dir = join(packages, pkg.name);
		const configs = readdirSync(dir)
			.filter((n) => /^vitest.*\.config\.[cm]?[jt]s$/.test(n))
			.map((n) => readFileSync(join(dir, n), "utf8"));
		const minTimeout = configuredTimeout(configs);
		for (const file of walk(dir)) {
			const n = countFile(readFileSync(file, "utf8"), minTimeout);
			if (n > 0) counts[relative(root, file)] = n;
		}
	}
	return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

/** Files whose count rose above the baseline (a missing baseline entry is 0). */
export function regressions(current, baseline) {
	return Object.entries(current)
		.filter(([file, n]) => n > (baseline[file] ?? 0))
		.map(([file, n]) => `${file}: ${n} (baseline ${baseline[file] ?? 0})`);
}

/** The baseline after an update: current counts that do not exceed the baseline; dropped files disappear. */
export function shrunk(current, baseline) {
	return Object.fromEntries(Object.entries(current).filter(([file, n]) => n <= (baseline[file] ?? 0)));
}

const total = (counts) => Object.values(counts).reduce((a, b) => a + b, 0);

function summary(counts) {
	const top = Object.entries(counts)
		.sort(([, a], [, b]) => b - a)
		.slice(0, 5)
		.map(([file, n]) => `  ${n}\t${file}`);
	return `test-trust: ${total(counts)} flagged constructs in ${Object.keys(counts).length} files\n${top.join("\n")}`;
}

function main() {
	const update = process.argv.includes("--update");
	const init = process.argv.includes("--init");
	if (!existsSync(baselinePath)) {
		if (!init) {
			console.error("test-trust: test-trust.baseline.json is missing; create it once with --init");
			process.exit(1);
		}
		const current = measure();
		writeFileSync(baselinePath, `${JSON.stringify({ counts: current }, null, "\t")}\n`);
		console.log(`${summary(current)}\ntest-trust: baseline created (${total(current)} constructs)`);
		return;
	}
	if (init) {
		console.error("test-trust: --init only creates a missing baseline; use --update to shrink it");
		process.exit(1);
	}
	const baseline = JSON.parse(readFileSync(baselinePath, "utf8")).counts;
	const current = measure();
	console.log(summary(current));
	const rises = regressions(current, baseline);
	if (rises.length) {
		console.error(
			`test-trust: counts rose above test-trust.baseline.json (fix the test; --update never raises):\n${rises.map((r) => `  ${r}`).join("\n")}`,
		);
		process.exit(1);
	}
	if (update) {
		const next = shrunk(current, baseline);
		writeFileSync(baselinePath, `${JSON.stringify({ counts: next }, null, "\t")}\n`);
		console.log(`test-trust: baseline updated (${total(next)} constructs)`);
		return;
	}
	const improved = Object.keys(baseline).filter((file) => (current[file] ?? 0) < baseline[file]);
	if (improved.length)
		console.log(
			`test-trust: ${improved.length} file(s) improved; run \`node scripts/check/test-trust.mjs --update\` to lock it in`,
		);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();

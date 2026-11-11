#!/usr/bin/env node
/**
 * Reads the dogfooding log (`.octocode/REFLECT.md`) and reports what it still owes.
 *
 * An entry is a `## ` section; a finding is a top-level bullet of an entry. A finding is settled when its text carries
 * `fixed:` (fixed in its owner) or `item:` (a backlog item owns it). The script lists the findings with neither and
 * counts all findings by cause: the label a bullet starts with, before its first colon ("Tool mistake", "Caller
 * mistakes", "Confirmed and fixed"); a bullet with no short label counts as "unlabelled".
 *
 *   node scripts/reflect-check.mjs [file] [--open] [--json] [--strict]
 *
 * `--open` prints every unsettled finding, `--json` prints the result as JSON, `--strict` exits 1 when any is unsettled.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SETTLED = /\b(fixed|item):/i;
/** A cause label is short: longer text before a colon is a sentence, not a label. */
const MAX_LABEL_WORDS = 5;

/** The entries of the log: each `## ` heading with its top-level bullets (continuation lines joined). */
export function parseReflect(text) {
	const entries = [];
	let entry;
	let finding;
	for (const line of text.split("\n")) {
		if (line.startsWith("## ")) {
			entry = { title: line.slice(3).trim(), findings: [] };
			entries.push(entry);
			finding = undefined;
		} else if (!entry) {
			continue;
		} else if (line.startsWith("- ")) {
			finding = { text: line.slice(2).trim() };
			entry.findings.push(finding);
		} else if (finding && /^\s+\S/.test(line)) {
			finding.text += ` ${line.trim()}`;
		} else if (line.trim() === "") {
			finding = undefined;
		}
	}
	return entries;
}

/** The cause a finding starts with, lower-cased, or "unlabelled". */
export function causeOf(text) {
	const plain = text.replace(/^\*\*(.+?)\*\*/, "$1");
	const colon = plain.indexOf(":");
	if (colon <= 0) return "unlabelled";
	const label = plain.slice(0, colon).replace(/[*`.]/g, "").trim();
	return label.split(/\s+/).length <= MAX_LABEL_WORDS ? label.toLowerCase() : "unlabelled";
}

/** Totals, findings by cause and the unsettled findings of `entries`. */
export function summarize(entries) {
	const causes = new Map();
	const open = [];
	let findings = 0;
	for (const entry of entries) {
		for (const finding of entry.findings) {
			findings++;
			const cause = causeOf(finding.text);
			causes.set(cause, (causes.get(cause) ?? 0) + 1);
			if (!SETTLED.test(finding.text)) open.push({ entry: entry.title, cause, text: finding.text });
		}
	}
	return {
		entries: entries.length,
		findings,
		settled: findings - open.length,
		causes: [...causes.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
		open,
	};
}

function main(argv) {
	const flags = new Set(argv.filter((arg) => arg.startsWith("--")));
	const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
	const file = argv.find((arg) => !arg.startsWith("--")) ?? path.join(root, ".octocode", "REFLECT.md");
	if (!fs.existsSync(file)) {
		console.error(`No dogfooding log at ${file}`);
		return 1;
	}
	const result = summarize(parseReflect(fs.readFileSync(file, "utf8")));
	if (flags.has("--json")) {
		console.log(JSON.stringify(result, null, "\t"));
	} else {
		console.log(
			`${result.entries} entries, ${result.findings} findings: ${result.settled} settled (fixed: or item:), ${result.open.length} with neither`,
		);
		console.log("\nFindings by cause:");
		for (const [cause, count] of result.causes) console.log(`  ${String(count).padStart(4)}  ${cause}`);
		if (flags.has("--open")) {
			console.log("\nWith neither fixed: nor item:");
			for (const finding of result.open) console.log(`- [${finding.entry}] ${finding.text}`);
		}
	}
	return flags.has("--strict") && result.open.length > 0 ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
	process.exit(main(process.argv.slice(2)));

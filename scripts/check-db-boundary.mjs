#!/usr/bin/env node
/**
 * Database boundary. All SQL against the agent database lives in `packages/coding-agent/src/octocode/agentdb/`
 * (`queries/` holds the statements, `api.ts` is the one door). Anywhere else under `src/`, a `prepare("…")`, a
 * `db.exec(…)` or an import of `node:sqlite` fails the check. Allowed outside agentdb: `team/peer-leases.ts`, which
 * opens another package's database read-only, and `shared/util.ts`, which defines `loadSqlite`.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "packages/coding-agent/src");
const OWNER = "octocode/agentdb/";
const ALLOWED = new Set(["octocode/team/peer-leases.ts", "octocode/shared/util.ts"]);
const SQL = /\.prepare\(\s*[`"']|\bdb\.exec\(|from ["']node:sqlite["']|\bloadSqlite\b/;

export function violations(files) {
	return files
		.filter(({ file, text }) => !file.startsWith(OWNER) && !ALLOWED.has(file) && SQL.test(text))
		.map(({ file }) => file);
}

function walk(dir) {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const full = join(dir, entry.name);
		return entry.isDirectory() ? walk(full) : full.endsWith(".ts") ? [full] : [];
	});
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const files = walk(src).map((full) => ({ file: relative(src, full), text: readFileSync(full, "utf8") }));
	const bad = violations(files);
	if (bad.length) {
		console.error(`SQL outside octocode/agentdb/ (use agentdb/api.ts):\n${bad.map((f) => `  ${f}`).join("\n")}`);
		process.exit(1);
	}
}

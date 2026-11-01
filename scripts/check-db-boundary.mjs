#!/usr/bin/env node
/**
 * Database boundary. All SQL against the agent database lives in `packages/coding-agent/src/octocode/agentdb/`
 * (`queries/` holds the statements, `api.ts` is the one door). Anywhere else under `src/`, a `prepare("…")`, a
 * `db.exec(…)`, an import of `node:sqlite` or a use of `loadSqlite` fails the check. Allowed outside agentdb:
 * `team/peer-leases.ts`, which reads another package's database. Features reach the database only through
 * `agentdb/api.ts`: importing any other `agentdb/` module (`db.ts`, `queries/*`, `rows.ts`…) fails too.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "packages/coding-agent/src");
const OWNER = "octocode/agentdb/";
const ALLOWED = new Set(["octocode/team/peer-leases.ts"]);
const SQL = /\.prepare\(\s*[`"']|\bdb\.exec\(|from ["']node:sqlite["']|\bloadSqlite\b/;
/** An import of an agentdb module other than its API (`…/agentdb/api.ts`). */
const DEEP_IMPORT = /(?:from\s+|import\s*\(\s*|import\s+)["'][^"']*\/agentdb\/(?!api\.ts["'])[^"']+["']/;

export function violations(files) {
	return files
		.filter(
			({ file, text }) => !file.startsWith(OWNER) && ((!ALLOWED.has(file) && SQL.test(text)) || DEEP_IMPORT.test(text)),
		)
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
		console.error(
			`SQL or a deep agentdb import outside octocode/agentdb/ (use agentdb/api.ts):\n${bad.map((f) => `  ${f}`).join("\n")}`,
		);
		process.exit(1);
	}
}

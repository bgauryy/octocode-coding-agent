#!/usr/bin/env node
/** All application SQL and private database imports belong inside the database workspace. */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const packages = fileURLToPath(new URL("../packages/", import.meta.url));
const PEER_READER = "coding-agent/src/octocode/team/peer-leases.ts";
const SQL = /\.prepare\(\s*[`"']|\bdb\.exec\(|from ["']node:sqlite["']|\bloadSqlite\b/;
const PRIVATE_IMPORT =
	/(?:from\s+|import\s*\(\s*|import\s+)["'](?:[^"']*\/db\/src\/(?!api\.ts["'])[^"']+|@octocodeai\/octocode-db\/[^"']+)["']/;

export function violations(files) {
	return files
		.filter(
			({ file, text }) =>
				!file.startsWith("db/src/") && ((file !== PEER_READER && SQL.test(text)) || PRIVATE_IMPORT.test(text)),
		)
		.map(({ file }) => file);
}

function walk(dir) {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const full = join(dir, entry.name);
		return entry.isDirectory() ? walk(full) : /\.[cm]?[jt]sx?$/.test(full) ? [full] : [];
	});
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const sources = readdirSync(packages)
		.map((name) => join(packages, name, "src"))
		.filter(existsSync);
	const files = sources
		.flatMap(walk)
		.map((full) => ({ file: relative(packages, full).split("\\").join("/"), text: readFileSync(full, "utf8") }));
	const bad = violations(files);
	if (bad.length) {
		console.error(
			`SQL or a private DB import outside packages/db/src (use its api.ts):\n${bad.map((file) => `  ${file}`).join("\n")}`,
		);
		process.exitCode = 1;
	}
}

#!/usr/bin/env node
/**
 * The MCP workspace's sources are private to it: other workspaces reach them through `mcp/src/api.ts` (by relative path,
 * as coding-agent does) or through the package `exports` (by name, as ACP does). The bundle entry is the one exception:
 * it re-exports the published client subpaths (`/mcp`, `/mcp/oauth`).
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const packages = fileURLToPath(new URL("../packages/", import.meta.url));
/** Files allowed to import more than `api.ts`, with the modules they may import. */
const ALLOWED = new Map([["coding-agent/src/bundle.ts", new Set(["client/index.ts", "client/oauth/index.ts"])]]);
/** Static, type-only and dynamic imports and re-exports whose path runs into `mcp/src/`. */
const MCP_IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["'](?:[^"']*\/)?mcp\/src\/([^"']+)["']/g;

export function violations(files) {
	return files.flatMap(({ file, text }) => {
		if (file.startsWith("mcp/")) return [];
		const allowed = ALLOWED.get(file);
		return [...text.matchAll(MCP_IMPORT)]
			.map((match) => match[1])
			.filter((module) => module !== "api.ts" && !allowed?.has(module))
			.map((module) => `${file} -> mcp/src/${module}`);
	});
}

function walk(dir) {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const full = join(dir, entry.name);
		return entry.isDirectory() ? walk(full) : /\.[cm]?[jt]sx?$/.test(full) ? [full] : [];
	});
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	// Shipped sources and the generator scripts; tests may reach private modules to test them.
	const roots = [
		...readdirSync(packages).map((name) => join(packages, name, "src")),
		join(packages, "coding-agent", "scripts"),
	].filter(existsSync);
	const files = roots
		.flatMap(walk)
		.map((full) => ({ file: relative(packages, full).split("\\").join("/"), text: readFileSync(full, "utf8") }));
	const bad = violations(files);
	if (bad.length) {
		console.error(
			`A private MCP import outside packages/mcp/src (add the name to mcp/src/api.ts and import that):\n${bad.map((line) => `  ${line}`).join("\n")}`,
		);
		process.exitCode = 1;
	}
}

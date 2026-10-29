// Shared by generate.mjs, check.mjs and apply.mjs. They only run `octocode mcp compact`: conversion, hashing, the
// fidelity check and storage live in the product.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

export function fail(message) {
	console.error(message);
	process.exit(1);
}

export function parse(args, options) {
	try {
		return parseArgs({ args, options, allowPositionals: true });
	} catch (error) {
		return fail(error.message);
	}
}

/** Scratch location for catalogs and plain files: `<cwd>/.octocode/octocode-compact-mcp/tmp`. */
export function workDir(override) {
	const dir = resolve(override ?? join(process.cwd(), ".octocode", "octocode-compact-mcp", "tmp"));
	mkdirSync(dir, { recursive: true });
	return dir;
}

/** The saved catalog of a server in the work directory, when `generate.mjs` made one. */
export function savedCatalog(work, server) {
	const file = join(work, `${server}.catalog.json`);
	return existsSync(file) ? file : undefined;
}

/** Runs `octocode mcp compact <args>` (`OCTOCODE_BIN` names another executable) and returns its output and status. */
export function compact(args, { capture = false } = {}) {
	const run = spawnSync(process.env.OCTOCODE_BIN || "octocode", ["mcp", "compact", ...args], {
		encoding: "utf8",
		stdio: capture ? ["inherit", "pipe", "inherit"] : "inherit",
		maxBuffer: 64 * 1024 * 1024,
	});
	if (run.error) fail(`Could not run octocode: ${run.error.message}. Set OCTOCODE_BIN to the executable.`);
	return { status: run.status ?? 1, stdout: run.stdout ?? "" };
}

export function save(file, text) {
	writeFileSync(file, text);
}

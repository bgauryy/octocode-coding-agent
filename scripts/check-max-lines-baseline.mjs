#!/usr/bin/env node
/**
 * The `max-lines` baseline in `.oxlintrc.json` lists source files that were over 400 lines when the rule was adopted.
 * Oxlint skips the rule for them; every other file must stay within 400 lines. The list may only shrink: this check
 * fails when a listed file is gone or fits the limit, so it is removed from the list as soon as it is split.
 *
 * `--update` rewrites the list to the files that are over the limit now (use it only to remove entries).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const configPath = join(root, ".oxlintrc.json");
const MAX_LINES = 400;

/** Lines as `max-lines` counts them: a final newline does not start another line. */
export function countLines(text) {
	if (text === "") return 0;
	const lines = text.split(/\r\n|\r|\n/);
	return lines.at(-1) === "" ? lines.length - 1 : lines.length;
}

/** The override that only turns `max-lines` off, for named files. */
export function findBaseline(config) {
	return config.overrides?.find(
		(override) =>
			Object.keys(override.rules ?? {}).length === 1 &&
			override.rules["max-lines"] === "off" &&
			override.files.every((file) => !/[*?{]/.test(file)),
	);
}

function oversizedFiles() {
	// The configured limit applies only without CLI rule flags (`-D max-lines` would reset it to the default 300).
	const run = spawnSync(
		process.execPath,
		[join(root, "node_modules/oxlint/bin/oxlint"), "packages", "scripts", "-f", "json"],
		{ cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
	);
	const report = JSON.parse(run.stdout);
	const diagnostics = (report.diagnostics ?? report).filter((diagnostic) => diagnostic.code === "eslint(max-lines)");
	return [...new Set(diagnostics.map((diagnostic) => relative(root, join(root, diagnostic.filename))))].sort((a, b) =>
		a.localeCompare(b),
	);
}

function main() {
	const config = JSON.parse(readFileSync(configPath, "utf8"));
	const baseline = findBaseline(config);
	if (!baseline) throw new Error("No max-lines baseline override in .oxlintrc.json");

	if (process.argv.includes("--update")) {
		const files = new Set(baseline.files);
		baseline.files = [];
		writeFileSync(configPath, `${JSON.stringify(config, null, "\t")}\n`);
		baseline.files = oversizedFiles().filter((file) => files.size === 0 || files.has(file));
		writeFileSync(configPath, `${JSON.stringify(config, null, "\t")}\n`);
		console.log(`max-lines baseline: ${baseline.files.length} files`);
		return;
	}

	const stale = baseline.files.filter((file) => {
		const path = join(root, file);
		return !existsSync(path) || countLines(readFileSync(path, "utf8")) <= MAX_LINES;
	});
	if (stale.length > 0) {
		console.error(
			`These files now fit ${MAX_LINES} lines (or are gone); remove them from the max-lines baseline in .oxlintrc.json:\n${stale.map((file) => `  ${file}`).join("\n")}`,
		);
		process.exit(1);
	}
	console.log(`max-lines baseline: ${baseline.files.length} files still to split`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();

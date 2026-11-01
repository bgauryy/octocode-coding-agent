#!/usr/bin/env node
/**
 * `import/no-cycle` runs with `ignoreTypes: false`, so a type-only import cycle fails the lint like a value cycle. The
 * override in `.oxlintrc.json` that sets only that rule for named files is the baseline of files that already sit in a
 * type cycle (the `AgentSession` type cluster in coding-agent `core/`). Oxlint skips type edges for them; every other
 * file must stay out of a cycle. The list may only shrink: this check fails when a listed file no longer sits in a
 * cycle, so it is removed as soon as the cycle is cut.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const RULE = "import/no-cycle";

/** The override that only configures `import/no-cycle`, for named files. */
export function findCycleBaseline(config) {
	return config.overrides?.find(
		(override) =>
			Object.keys(override.rules ?? {}).length === 1 &&
			RULE in override.rules &&
			override.files.every((file) => !/[*?{]/.test(file)),
	);
}

/** Baseline files that are gone or no longer part of a cycle. */
export function staleCycleEntries(baselineFiles, cyclicFiles, exists = existsSync) {
	const cyclic = new Set(cyclicFiles);
	return baselineFiles.filter((file) => !exists(join(root, file)) || !cyclic.has(file));
}

/** Files oxlint reports for a cycle when the baseline override is removed. */
function cyclicFiles(config, baseline) {
	const probe = join(root, ".oxlintrc.cycle-probe.json");
	writeFileSync(
		probe,
		JSON.stringify({ ...config, overrides: config.overrides.filter((entry) => entry !== baseline) }),
	);
	try {
		const run = spawnSync(
			process.execPath,
			[join(root, "node_modules/oxlint/bin/oxlint"), "-c", probe, "packages", "-f", "json"],
			{ cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
		);
		const report = JSON.parse(run.stdout);
		const diagnostics = (report.diagnostics ?? report).filter((diagnostic) => diagnostic.code === "import(no-cycle)");
		return [...new Set(diagnostics.map((diagnostic) => relative(root, join(root, diagnostic.filename))))];
	} finally {
		rmSync(probe, { force: true });
	}
}

function main() {
	const config = JSON.parse(readFileSync(join(root, ".oxlintrc.json"), "utf8"));
	const baseline = findCycleBaseline(config);
	if (!baseline) throw new Error(`No ${RULE} baseline override in .oxlintrc.json`);
	const stale = staleCycleEntries(baseline.files, cyclicFiles(config, baseline));
	if (stale.length > 0) {
		console.error(
			`These files no longer sit in a type cycle (or are gone); remove them from the ${RULE} baseline in .oxlintrc.json:\n${stale.map((file) => `  ${file}`).join("\n")}`,
		);
		process.exit(1);
	}
	console.log(`${RULE} baseline: ${baseline.files.length} files still in a type cycle`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();

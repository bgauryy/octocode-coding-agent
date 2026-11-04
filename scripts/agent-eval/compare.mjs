#!/usr/bin/env node
/**
 * Compare two result folders written by run.mjs and apply the ship gate.
 * Exit code: 0 Accept, 1 Revert, 2 Inconclusive, 3 Invalid, 64 usage.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { compareRuns, formatComparison, loadRun, VERDICT_EXIT } from "./lib/compare.mjs";

const USAGE = "Usage: node scripts/agent-eval/compare.mjs <baseline-dir> <candidate-dir> [--json]";

let parsed;
try {
	parsed = parseArgs({ options: { json: { type: "boolean" } }, allowPositionals: true });
} catch (error) {
	console.error(`${error.message}\n${USAGE}`);
	process.exit(64);
}
const dirs = parsed.positionals;
if (dirs.length !== 2 || dirs.some((dir) => !existsSync(join(dir, "run.json")))) {
	console.error(USAGE);
	process.exit(64);
}
const result = compareRuns(loadRun(dirs[0]), loadRun(dirs[1]));
console.log(parsed.values.json ? JSON.stringify(result, null, "\t") : formatComparison(result));
process.exit(VERDICT_EXIT[result.decision.verdict]);

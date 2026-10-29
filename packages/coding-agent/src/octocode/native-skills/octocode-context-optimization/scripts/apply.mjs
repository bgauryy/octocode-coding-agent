#!/usr/bin/env node
// node apply.mjs <server> --overrides file --optimized-by <model> [--catalog file] [--work dir]
// Re-runs the fidelity check, then stores the rendered file and its metadata under <agentDir>/context-optimization/mcp.
import { compact, fail, parse, savedCatalog, workDir } from "./lib.mjs";

const { values, positionals } = parse(process.argv.slice(2), {
	overrides: { type: "string" },
	"optimized-by": { type: "string" },
	catalog: { type: "string" },
	work: { type: "string" },
});
const [server] = positionals;
if (!server || !values.overrides || !values["optimized-by"]) {
	fail("Usage: apply.mjs <server> --overrides file --optimized-by <model> [--catalog file] [--work dir]");
}

const catalog = values.catalog ?? savedCatalog(workDir(values.work), server);
process.exit(
	compact([
		"apply",
		server,
		"--overrides",
		values.overrides,
		"--optimized-by",
		values["optimized-by"],
		...(catalog ? ["--catalog", catalog] : []),
	]).status,
);

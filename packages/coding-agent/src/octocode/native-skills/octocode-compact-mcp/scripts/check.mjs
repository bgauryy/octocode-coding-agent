#!/usr/bin/env node
// node check.mjs <server> --overrides file [--catalog file] [--work dir]
// Runs the product fidelity check on the file rendered with the overrides and prints before/after tables. Without
// --catalog it uses the catalog generate.mjs saved in the work directory, else the live server.
// Budget rules: references/rewrite-rules.md#budget.
import { compact, fail, parse, savedCatalog, workDir } from "./lib.mjs";

const { values, positionals } = parse(process.argv.slice(2), {
	overrides: { type: "string" },
	catalog: { type: "string" },
	work: { type: "string" },
});
const [server] = positionals;
if (!server || !values.overrides) fail("Usage: check.mjs <server> --overrides file [--catalog file] [--work dir]");

const catalog = values.catalog ?? savedCatalog(workDir(values.work), server);
process.exit(
	compact(["check", server, "--overrides", values.overrides, ...(catalog ? ["--catalog", catalog] : [])]).status,
);

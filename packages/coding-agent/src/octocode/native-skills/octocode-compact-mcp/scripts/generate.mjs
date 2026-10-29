#!/usr/bin/env node
// node generate.mjs <server> [--catalog file] [--work dir]
// Saves the server catalog to <work>/<server>.catalog.json and renders the plain file (no overrides) beside it.
import { join } from "node:path";
import { compact, fail, parse, save, workDir } from "./lib.mjs";

const { values, positionals } = parse(process.argv.slice(2), { catalog: { type: "string" }, work: { type: "string" } });
const [server] = positionals;
if (!server) fail("Usage: generate.mjs <server> [--catalog file] [--work dir]");

const work = workDir(values.work);
const catalog = join(work, `${server}.catalog.json`);
const source = values.catalog ? ["--catalog", values.catalog] : [];
if (compact(["catalog", server, "--out", catalog, ...source]).status !== 0) process.exit(1);
const plain = compact(["show", server, "--plain", "--catalog", catalog], { capture: true });
if (plain.status !== 0) process.exit(1);
const file = join(work, `${server}.plain.ts`);
save(file, `${plain.stdout.trimEnd()}\n`);
console.log(`catalog ${catalog}\nplain file ${file} (${plain.stdout.length} chars)`);

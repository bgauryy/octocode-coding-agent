// Evaluator-only: lives outside the solver's workspace and runs after the solver stopped. Its exit code decides.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const workspace = process.env.EVAL_WORKSPACE;
const jsonl = await import(pathToFileURL(join(workspace, "packages/common/src/jsonl.ts")).href);

assert.equal(typeof jsonl.jsonlValues, "function", "jsonlValues is exported");
assert.deepEqual(jsonl.jsonlValues('{"a":1}\n\nnot json\n2\r\n  \nnull\nfalse\n0'), [{ a: 1 }, 2, null, false, 0]);
assert.deepEqual(jsonl.jsonlValues(""), []);
assert.deepEqual(jsonl.jsonlValues("{broken\n"), []);
// The existing helpers keep their behavior.
assert.deepEqual([...jsonl.jsonlLines("1\nx")], [{ ok: true, value: 1 }, { ok: false }]);
assert.equal(jsonl.parseJsonlLine(" "), undefined);

const test = readFileSync(join(workspace, "packages/common/test/jsonl.test.ts"), "utf8");
assert.match(test, /jsonlValues\s*\(/, "the test file calls jsonlValues");
assert.match(test, /describe\("parseJsonlLine"/, "the existing tests stay");

// Evaluator-only: lives outside the solver's workspace and runs after the solver stopped. Its exit code decides.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const workspace = process.env.EVAL_WORKSPACE;
const { cutText } = await import(pathToFileURL(join(workspace, "packages/common/src/text.ts")).href);
const tail = { chars: true, tail: true };

// Fail to pass: the cut lands on either half of the pair.
assert.equal(cutText("a\u{1F600}b", 2, tail), "b");
assert.equal(cutText("a\u{1F600}b", 3, tail), "\u{1F600}b");
assert.equal(cutText("\u{1F600}", 1, tail), "");
// Pass to pass: plain text, the head cut and the byte cut stay as they were.
assert.equal(cutText("abcdef", 2, tail), "ef");
assert.equal(cutText("a\u{1F600}b", 2, { chars: true }), "a");
assert.equal(cutText("a\u{1F600}b", 3, { chars: true }), "a\u{1F600}");
assert.equal(cutText("a\u{1F600}b", 5, { tail: true }), "\u{1F600}b");
assert.equal(cutText("short", 10, tail), "short");

const testFile = join(workspace, "packages/common/test/text.test.ts");
assert.ok(existsSync(testFile), "the regression test exists");
const test = readFileSync(testFile, "utf8");
assert.match(test, /cutText\s*\(/, "the test calls cutText");
assert.match(test, /tail/, "the test covers the tail cut");

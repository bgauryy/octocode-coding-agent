import assert from "node:assert/strict";
import { test } from "node:test";
import { causeOf, parseReflect, summarize } from "./reflect-check.mjs";

const LOG = `# Dogfooding

Intro text with a list that is not an entry:

- not a finding

## 2026-11-11: first task

- **Tool mistake:** ran a formatter on a generated file. fixed: rule added.
- Caller mistakes: guessed a path
  that did not exist.
- A long sentence that happens to contain a colon much later in the text: this is not a label.

## 2026-11-10: second task

- Tool mistake: quoted a separator wrongly. item: B12
- No colon at all
`;

test("parses entries and joins continuation lines", () => {
	const entries = parseReflect(LOG);
	assert.deepEqual(
		entries.map((entry) => [entry.title, entry.findings.length]),
		[
			["2026-11-11: first task", 3],
			["2026-11-10: second task", 2],
		],
	);
	assert.equal(entries[0].findings[1].text, "Caller mistakes: guessed a path that did not exist.");
});

test("reads a short leading label as the cause", () => {
	assert.equal(causeOf("**Tool mistake:** x"), "tool mistake");
	assert.equal(causeOf("Caller mistakes: x"), "caller mistakes");
	assert.equal(causeOf("No colon at all"), "unlabelled");
	assert.equal(causeOf("A long sentence that happens to contain a colon much later: x"), "unlabelled");
});

test("counts by cause and lists findings with neither marker", () => {
	const result = summarize(parseReflect(LOG));
	assert.equal(result.findings, 5);
	assert.equal(result.settled, 2);
	assert.deepEqual(result.causes, [
		["tool mistake", 2],
		["unlabelled", 2],
		["caller mistakes", 1],
	]);
	assert.deepEqual(
		result.open.map((finding) => finding.cause),
		["caller mistakes", "unlabelled", "unlabelled"],
	);
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { firstMessage, gradeAnswer, questionsFor } from "../understand.mjs";

const bank = JSON.parse(readFileSync(new URL("../understanding.json", import.meta.url), "utf8"));

test("grades an answer by what it must and must not say", () => {
	const question = { expect: ["localFetch", "ranges"], forbid: ["^yes"] };
	assert.deepEqual(gradeAnswer(question, "Use localFetch with RANGES."), { pass: true, missed: [], forbidden: [] });
	assert.equal(gradeAnswer(question, "Use localFetch.").pass, false);
	assert.deepEqual(gradeAnswer(question, "Yes, localFetch ranges.").forbidden, ["^yes"]);
});

test("gives every agent questions, through its name or its groups", () => {
	for (const agent of bank.groups.everyone) assert.ok(questionsFor(bank, agent).length > 3, agent);
	assert.ok(questionsFor(bank, "lean").some((question) => question.id === "lean-search"));
	assert.ok(!questionsFor(bank, "main").some((question) => question.id === "lean-search"));
});

test("every question names a known agent or group, and every pattern compiles", () => {
	const known = new Set([...Object.keys(bank.groups), ...bank.groups.everyone]);
	const ids = new Set();
	for (const question of bank.questions) {
		assert.ok(!ids.has(question.id), `duplicate ${question.id}`);
		ids.add(question.id);
		for (const agent of question.agents) assert.ok(known.has(agent), `${question.id}: ${agent}`);
		for (const pattern of [...(question.expect ?? []), ...(question.forbid ?? [])]) new RegExp(pattern, "i");
	}
});

test("asks in place of the first message's placeholder, keeping a child's identity and report contract", () => {
	const child = { messages: [{ text: "[The parent's task: objective and checks]\n\n## You\nYour name is `c`." }] };
	const text = firstMessage(child, "How?");
	assert.match(text, /Question: How\?/);
	assert.match(text, /## You/);
	assert.doesNotMatch(text, /The parent's task/);
	assert.match(firstMessage({ messages: [{ text: "[The user's first message]" }] }, "Why?"), /Question: Why\?$/);
});

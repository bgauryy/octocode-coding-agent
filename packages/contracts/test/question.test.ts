import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
	OPTION_ROLES,
	QUESTION_LIMITS,
	QUESTION_TYPES,
	QuestionSchema,
	QuestionsSchema,
	ROLES_BY_TYPE,
	ReplySchema,
} from "../src/question.ts";
import * as contracts from "../src/index.ts";

const option = { id: "1", label: "A" };

describe("Question contract", () => {
	it("is exported from the index", () => {
		expect(contracts.QuestionSchema).toBe(QuestionSchema);
		expect(contracts.ReplySchema).toBe(ReplySchema);
	});

	it.each(QUESTION_TYPES)("accepts a %s question", (type) => {
		expect(Value.Check(QuestionSchema, { id: "q", type, question: "Q?", options: [option] })).toBe(true);
	});

	it("accepts every option role and the approval, write-in and card fields", () => {
		const options = OPTION_ROLES.map((role) => ({ id: role, label: role, role, tone: "danger", recommended: true }));
		expect(
			Value.Check(QuestionSchema, {
				id: "q",
				type: "approval",
				question: "Q?",
				header: "H",
				meta: ["m"],
				body: { text: "b", label: "l", collapsible: true, previewLines: 2 },
				notes: [{ text: "n", tone: "warning" }],
				options,
				writeIn: { label: "w", title: "t", placeholder: "p" },
				approval: { toolCallId: "c", toolName: "bash", action: "shell", targets: ["ls"] },
			}),
		).toBe(true);
		expect(
			Value.Check(QuestionSchema, { id: "q", type: "choice", question: "Q?", options: [option], writeIn: false }),
		).toBe(true);
	});

	it.each([
		["an unknown type", { id: "q", type: "slider", question: "Q?" }],
		["an unknown role", { id: "q", type: "choice", question: "Q?", options: [{ ...option, role: "allow_forever" }] }],
		["a danger-less tone", { id: "q", type: "choice", question: "Q?", options: [{ ...option, tone: "loud" }] }],
		["an empty id", { id: "", type: "text", question: "Q?" }],
		["an oversized question", { id: "q", type: "text", question: "x".repeat(QUESTION_LIMITS.question + 1) }],
		[
			"too many options",
			{
				id: "q",
				type: "choice",
				question: "Q?",
				options: Array.from({ length: QUESTION_LIMITS.options + 1 }, (_, i) => ({ id: `${i}`, label: "L" })),
			},
		],
		["an approval without targets", { id: "q", type: "approval", question: "Q?", approval: {} }],
	])("rejects %s", (_name, question) => {
		expect(Value.Check(QuestionSchema, question)).toBe(false);
	});

	it("bounds a batch", () => {
		const one = { id: "q", type: "text", question: "Q?" };
		expect(Value.Check(QuestionsSchema, [one])).toBe(true);
		expect(Value.Check(QuestionsSchema, [])).toBe(false);
		expect(
			Value.Check(
				QuestionsSchema,
				Array.from({ length: QUESTION_LIMITS.questions + 1 }, () => one),
			),
		).toBe(false);
	});

	it("accepts a reply with picks and text, or a cancellation reason", () => {
		expect(Value.Check(ReplySchema, { id: "q", picks: ["1"], text: "mine" })).toBe(true);
		expect(Value.Check(ReplySchema, { id: "q", picks: [] })).toBe(true);
		for (const cancelled of ["declined", "aborted", "unavailable", "timeout"])
			expect(Value.Check(ReplySchema, { id: "q", cancelled })).toBe(true);
		expect(Value.Check(ReplySchema, { id: "q", cancelled: "later" })).toBe(false);
		expect(Value.Check(ReplySchema, { id: "q" })).toBe(false);
	});

	it("names the roles each type decodes", () => {
		expect(ROLES_BY_TYPE.approval).toEqual(["allow_once", "allow_session", "allow_kind", "deny", "deny_note"]);
		expect(ROLES_BY_TYPE.confirm).toEqual(["yes", "no"]);
		expect([...ROLES_BY_TYPE.text, ...ROLES_BY_TYPE.choice, ...ROLES_BY_TYPE.multi]).toEqual([]);
	});
});

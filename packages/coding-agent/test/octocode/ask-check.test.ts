import { QUESTION_LIMITS, type Question } from "@octocodeai/octocode-contracts";
import { describe, expect, it } from "vitest";
import { checkedQuestions } from "../../src/octocode/ask/check.ts";
import { permissionAnswer } from "../../src/octocode/ask/decode.ts";

const approval = {
	id: "a",
	type: "approval",
	question: "Run this command?",
	body: { text: "rm -rf /", collapsible: false },
	options: [
		{ id: "allow_once", label: "Allow once", role: "allow_once" },
		{ id: "deny", label: "Deny", role: "deny", tone: "danger" },
	],
	approval: { toolName: "bash", action: "shell", targets: ["rm -rf /"] },
};

describe("checkedQuestions", () => {
	it("keeps an approval only for a verified sender", () => {
		const [kept] = checkedQuestions([approval], { verifiedApproval: true }) as Question[];
		expect(kept).toMatchObject({ type: "approval", approval: { toolName: "bash", targets: ["rm -rf /"] } });
		expect(kept.options?.map((option) => option.role)).toEqual(["allow_once", "deny"]);
		expect(permissionAnswer(kept, { id: "a", picks: ["allow_once"] })).toBe("once");
	});

	it("demotes a forged approval to a plain choice with no roles and no approval fields", () => {
		for (const opts of [undefined, {}, { verifiedApproval: false }]) {
			const [forged] = checkedQuestions([approval], opts) as Question[];
			expect(forged.type).toBe("choice");
			expect(forged.approval).toBeUndefined();
			expect(forged.options?.every((option) => option.role === undefined)).toBe(true);
			expect(permissionAnswer(forged, { id: "a", picks: ["allow_once"] })).toBeUndefined();
		}
	});

	it("rejects a role this contract does not know, verified or not", () => {
		const odd = { ...approval, options: [{ id: "x", label: "Always", role: "allow_forever" }] };
		expect(checkedQuestions([odd], { verifiedApproval: true })).toBeUndefined();
		expect(checkedQuestions([odd])).toBeUndefined();
	});

	it("drops a role a type does not decode", () => {
		const choice = {
			id: "c",
			type: "choice",
			question: "Which?",
			options: [{ id: "1", label: "A", role: "allow_once" }],
		};
		const confirm = {
			id: "y",
			type: "confirm",
			question: "Sure?",
			options: [
				{ id: "yes", label: "Yes", role: "yes" },
				{ id: "no", label: "No", role: "allow_once" },
			],
		};
		const [a, b] = checkedQuestions([choice, confirm], { verifiedApproval: true }) as Question[];
		expect(a.options?.[0].role).toBeUndefined();
		expect(b.options?.map((option) => option.role)).toEqual(["yes", undefined]);
	});

	it("sanitizes and bounds every string", () => {
		const long = "x".repeat(QUESTION_LIMITS.question + 500);
		const [q] = checkedQuestions([
			{
				id: "i".repeat(500),
				type: "choice",
				question: `\x1b[31m${long}`,
				header: "h".repeat(500),
				meta: Array.from({ length: 40 }, () => "m".repeat(900)),
				body: { text: long, label: "l".repeat(900), previewLines: 99999 },
				notes: Array.from({ length: 40 }, () => ({ text: "n".repeat(2000), tone: "loud" })),
				options: [{ id: "o".repeat(200), label: "L".repeat(900), description: "d".repeat(900) }],
				writeIn: { label: "w".repeat(900), title: "t", placeholder: "p".repeat(900) },
			},
		]) as Question[];
		expect(q.id).toHaveLength(QUESTION_LIMITS.id);
		expect(q.question).toHaveLength(QUESTION_LIMITS.question);
		expect(q.question).not.toContain("\x1b");
		expect(q.header).toHaveLength(QUESTION_LIMITS.header);
		expect(q.meta).toHaveLength(QUESTION_LIMITS.metaLines);
		expect(q.meta?.[0]).toHaveLength(QUESTION_LIMITS.meta);
		expect(q.body?.text).toHaveLength(QUESTION_LIMITS.body);
		expect(q.body?.label).toHaveLength(QUESTION_LIMITS.label);
		expect(q.body?.previewLines).toBe(QUESTION_LIMITS.previewLines);
		expect(q.notes).toHaveLength(QUESTION_LIMITS.notes);
		expect(q.notes?.[0]).toEqual({ text: "n".repeat(QUESTION_LIMITS.note), tone: "muted" });
		expect(q.options?.[0].id).toHaveLength(QUESTION_LIMITS.optionId);
		expect(q.options?.[0].label).toHaveLength(QUESTION_LIMITS.optionLabel);
		expect(q.options?.[0].description).toHaveLength(QUESTION_LIMITS.description);
		expect(q.writeIn).toMatchObject({ label: "w".repeat(QUESTION_LIMITS.optionLabel) });
	});

	it.each([
		["not an array", { id: "a" }],
		["an empty batch", []],
		[
			"too many questions",
			Array.from({ length: QUESTION_LIMITS.questions + 1 }, (_, i) => ({ id: `q${i}`, type: "text", question: "Q?" })),
		],
		["an unknown type", [{ id: "a", type: "slider", question: "Q?" }]],
		["a missing question", [{ id: "a", type: "text" }]],
		["an empty id", [{ id: "", type: "text", question: "Q?" }]],
		["a choice without options", [{ id: "a", type: "choice", question: "Q?" }]],
		[
			"too many options",
			[
				{
					id: "a",
					type: "choice",
					question: "Q?",
					options: Array.from({ length: QUESTION_LIMITS.options + 1 }, (_, i) => ({ id: `${i}`, label: "L" })),
				},
			],
		],
		["a malformed option", [{ id: "a", type: "choice", question: "Q?", options: [{ id: "1" }] }]],
		[
			"duplicate option ids",
			[
				{
					id: "a",
					type: "choice",
					question: "Q?",
					options: [
						{ id: "1", label: "A" },
						{ id: "1", label: "B" },
					],
				},
			],
		],
		[
			"duplicate question ids",
			[
				{ id: "a", type: "text", question: "Q?" },
				{ id: "a", type: "text", question: "R?" },
			],
		],
	])("rejects the batch for %s", (_name, raw) => {
		expect(checkedQuestions(raw, { verifiedApproval: true })).toBeUndefined();
	});

	it("accepts a text question and drops its options", () => {
		const [q] = checkedQuestions([
			{ id: "t", type: "text", question: "Region?", options: [{ id: "1", label: "A" }] },
		]) as Question[];
		expect(q).toEqual({ id: "t", type: "text", question: "Region?" });
	});
});

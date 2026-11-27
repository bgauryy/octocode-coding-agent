import { describe, expect, it } from "vitest";
import { runInproc } from "../src/agents/inproc.ts";
import { script } from "../src/gateway.ts";
import { extractJson, type StandardSchemaIssue, type StandardSchemaV1 } from "../src/matchers/answer.ts";
import { gateway } from "./helpers.ts";
import { traceOf } from "./matchers-fixtures.ts";

/** A hand-written Standard Schema: an object with a string `answer` and a `citation` ending in `:<line>`. */
const Answer: StandardSchemaV1<{ answer: string; citation: string }> = {
	"~standard": {
		version: 1,
		vendor: "testkit-test",
		validate(value) {
			const issues: StandardSchemaIssue[] = [];
			const v = value as Record<string, unknown> | null;
			if (!v || typeof v !== "object") return { issues: [{ message: "expected an object" }] };
			if (typeof v.answer !== "string") issues.push({ message: "expected a string", path: ["answer"] });
			if (typeof v.citation !== "string" || !/:\d+$/.test(v.citation))
				issues.push({ message: "expected file:line", path: [{ key: "citation" }] });
			return issues.length ? { issues } : { value: v as { answer: string; citation: string } };
		},
	},
};

const asyncSchema: StandardSchemaV1 = {
	"~standard": { version: 1, vendor: "testkit-test", validate: async (value) => ({ value }) },
};

describe("extractJson", () => {
	it("prefers a fenced block, then the whole text, then the first JSON span", () => {
		expect(extractJson('Here:\n```json\n{"a":1}\n```\nand {"b":2}')).toEqual({ a: 1 });
		expect(extractJson("```\n[1, 2]\n```")).toEqual([1, 2]);
		expect(extractJson(' {"whole": true} ')).toEqual({ whole: true });
		expect(extractJson('The result is {"x": [1]} as asked.')).toEqual({ x: [1] });
	});

	it("throws when nothing parses", () => {
		expect(() => extractJson("no json here")).toThrow(/no JSON value/);
		expect(() => extractJson("```json\n{broken\n```")).toThrow(/no JSON value/);
	});
});

describe("toMatchSchema", () => {
	it("checks a string answer and names each failing path", () => {
		expect('```json\n{"answer":"3","citation":"src/retry.ts:42"}\n```').toMatchSchema(Answer);
		expect(() => expect('{"answer":3,"citation":"nope"}').toMatchSchema(Answer)).toThrow(
			/answer: expected a string\n {2}citation: expected file:line/,
		);
		expect(() => expect("3").toMatchSchema(Answer)).toThrow(/\(root\): expected an object/);
		expect(() => expect("no json").toMatchSchema(Answer)).toThrow(/no JSON value found[\s\S]*answer: "no json"/);
	});

	it("reads the last answer of a trace, optionally of one agent", () => {
		const t = traceOf([
			{ kind: "answer", data: '{"answer":"child","citation":"a.ts:1"}', agent: "researcher" },
			{ kind: "answer", data: "plain text" },
		]);
		expect(() => expect(t).toMatchSchema(Answer)).toThrow(/no JSON value/);
		expect(t).toMatchSchema(Answer, { agent: "researcher" });
		expect(t).not.toMatchSchema(Answer);
	});

	it("checks the answer a scripted agent gave through the gateway", async () => {
		const gw = await gateway({
			responder: script([{ text: 'Done.\n```json\n{"answer":"3","citation":"r.ts:9"}\n```' }]),
		});
		await runInproc({ gatewayUrl: gw.url, trace: gw.trace }, "what is MAX_RETRIES?");
		expect(gw.trace).toMatchSchema(Answer);
	});

	it("cannot observe a trace without an answer, also under .not", () => {
		const t = traceOf([{ kind: "model_tool_call", name: "a", args: {} }]);
		expect(() => expect(t).toMatchSchema(Answer)).toThrow(/cannot observe: no answer in the trace/);
		expect(() => expect(t).not.toMatchSchema(Answer)).toThrow(/cannot observe/);
		expect(() => expect(t).toMatchSchema(Answer, { agent: "x" })).toThrow(/no answer in the trace from x/);
		expect(() => expect(42).toMatchSchema(Answer)).toThrow(/not a Trace/);
	});

	it("rejects an async validator instead of passing it", () => {
		expect(() => expect('{"a":1}').toMatchSchema(asyncSchema)).toThrow(/needs a synchronous schema/);
	});
});

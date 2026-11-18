import { describe, expect, it } from "vitest";
import { explainJudgement, judge, judgePanel } from "../src/judge.ts";
import { script, type ResponderContext } from "../src/gateway.ts";
import { resolveTier } from "../src/tiers.ts";
import { gateway } from "./helpers.ts";

const lastUser = (ctx: ResponderContext): string => {
	const m = ctx.request.messages.filter((x) => x.role === "user").at(-1);
	return typeof m?.content === "string" ? m.content : "";
};

/** A fake grader: passes "cites-file" only when the transcript mentions a file path, and always passes "polite". */
const grader = script([
	(ctx) => {
		const cites = /src\/\w+\.ts/.test(lastUser(ctx));
		return {
			text: JSON.stringify({
				verdicts: [
					{ id: "cites-file", pass: cites, reason: cites ? "names src/a.ts" : "no file named" },
					{ id: "polite", pass: true, reason: "ok" },
				],
			}),
		};
	},
]);

const rubric = [
	{ id: "cites-file", text: "The answer names the file that holds the fix" },
	{ id: "polite", text: "The tone is polite" },
];

async function model(responder = grader) {
	const gw = await gateway({ responder });
	return { gw, model: { baseUrl: `${gw.url}/v1`, model: "judge-x", api: "openai" as const } };
}

describe("judge", () => {
	it("returns per-criterion verdicts with reasons and sends rubric and transcript to the model", async () => {
		const { gw, model: m } = await model();
		const j = await judge({ rubric, transcript: "The fix is in src/a.ts, thanks!", model: m });
		expect(j.pass).toBe(true);
		expect(j.criteria).toEqual([
			{ id: "cites-file", criterion: rubric[0].text, pass: true, reason: "names src/a.ts" },
			{ id: "polite", criterion: rubric[1].text, pass: true, reason: "ok" },
		]);
		const sent = JSON.stringify(gw.trace.requests[0].messages);
		expect(sent).toContain("cites-file: The answer names the file");
		expect(sent).toContain("The fix is in src/a.ts");
		expect(gw.trace.requests[0].model).toBe("judge-x");
	});

	it("fails a bad transcript and explains which criterion failed (must-fail)", async () => {
		const { model: m } = await model();
		const j = await judge({ rubric, transcript: "I could not find anything.", model: m });
		expect(j.pass).toBe(false);
		expect(j.criteria.map((c) => c.pass)).toEqual([false, true]);
		expect(explainJudgement(j)).toBe("cites-file (The answer names the file that holds the fix): no file named");
	});

	it("accepts chat messages and string criteria (ids c1, c2)", async () => {
		const { gw, model: m } = await model(
			script([{ text: '```json\n{"verdicts":[{"id":"c1","pass":true,"reason":"r"}]}\n```' }]),
		);
		const j = await judge({
			rubric: ["says hi", "says bye"],
			transcript: [
				{ role: "user", content: "greet" },
				{ role: "assistant", content: "hi" },
			],
			model: m,
		});
		expect(JSON.stringify(gw.trace.requests[0].messages)).toContain("assistant: hi");
		expect(j.criteria).toMatchObject([
			{ id: "c1", pass: true },
			{ id: "c2", pass: false, reason: "judge gave no verdict" },
		]);
		expect(j.pass).toBe(false);
	});

	it("shows the grader each tool call with its args and each result with its call id, unshortened (must-fail)", async () => {
		/** Passes "verified" only when the transcript shows a read of src/a.ts whose result came back before the claim. */
		const processGrader = script([
			(ctx) => {
				const seen = lastUser(ctx);
				const call = /read\b.*\bc1\b.*"path":"src\/a\.ts"/.exec(seen);
				const result = /\bc1\b.*MAX_RETRIES = 3/.exec(seen);
				const claim = seen.indexOf("It is 3");
				const ok = call !== null && result !== null && call.index < result.index && result.index < claim;
				return {
					text: JSON.stringify({ verdicts: [{ id: "verified", pass: ok, reason: ok ? "read first" : "no read" }] }),
				};
			},
		]);
		const { gw, model: m } = await model(processGrader);
		const long = `export const MAX_RETRIES = 3;\n${"// filler\n".repeat(5000)}END-OF-FILE`;
		const verified = await judge({
			rubric: [{ id: "verified", text: "Read the file before stating the value" }],
			transcript: [
				{ role: "user", content: "What is MAX_RETRIES?" },
				{
					role: "assistant",
					content: "",
					tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: '{"path":"src/a.ts"}' } }],
				},
				{ role: "tool", tool_call_id: "c1", content: long },
				{ role: "assistant", content: "It is 3." },
			],
			model: m,
		});
		expect(verified.pass).toBe(true);
		expect(lastUser({ request: gw.trace.requests[0] } as ResponderContext)).toContain("END-OF-FILE");
		const guessed = await judge({
			rubric: [{ id: "verified", text: "Read the file before stating the value" }],
			transcript: [
				{ role: "user", content: "What is MAX_RETRIES?" },
				{ role: "assistant", content: "It is 3." },
			],
			model: m,
		});
		expect(guessed.pass).toBe(false);
	});

	it("throws when the judge does not answer in JSON, never a pass (must-fail)", async () => {
		const { model: m } = await model(script([{ text: "Looks fine to me." }]));
		await expect(judge({ rubric, transcript: "x", model: m })).rejects.toThrow(/not JSON/);
		const { model: m2 } = await model(script([{ text: '{"ok":true}' }]));
		await expect(judge({ rubric, transcript: "x", model: m2 })).rejects.toThrow(/no verdicts/);
	});

	it("rejects duplicate criterion ids, including a string id that collides with an explicit one", async () => {
		const { model: m } = await model();
		await expect(
			judge({
				rubric: [
					{ id: "a", text: "x" },
					{ id: "a", text: "y" },
				],
				transcript: "x",
				model: m,
			}),
		).rejects.toThrow("judge: duplicate criterion id a");
		await expect(judge({ rubric: ["first", { id: "c1", text: "second" }], transcript: "x", model: m })).rejects.toThrow(
			"judge: duplicate criterion id c1",
		);
	});

	it("sizes max_tokens to the rubric: 256 + 160 per criterion", async () => {
		const { gw, model: m } = await model(script([{ text: '{"verdicts":[]}' }]));
		await judge({ rubric: ["a", "b", "c"], transcript: "x", model: m });
		expect(gw.trace.requests[0].raw).toMatchObject({ max_tokens: 736 });
	});

	it("appends instructions to the system prompt on a new line, after the fixed rules", async () => {
		const { gw, model: m } = await model(script([{ text: '{"verdicts":[]}' }]));
		await judge({
			rubric,
			transcript: "x",
			model: m,
			instructions: "Grade strictly: a vague answer fails.",
		});
		const system = String(gw.trace.requests[0].messages.find((x) => x.role === "system")?.content);
		expect(system).toContain("Reply with JSON only");
		expect(system.endsWith("\nGrade strictly: a vague answer fails.")).toBe(true);
	});

	it("rejects an empty rubric", async () => {
		const { model: m } = await model();
		await expect(judge({ rubric: [], transcript: "x", model: m })).rejects.toThrow(/empty rubric/);
	});

	it("takes a resolved tier as the model", async () => {
		const { gw } = await model();
		const r = resolveTier({
			TESTKIT_TIER: "local",
			TESTKIT_LOCAL_BASE_URL: `${gw.url}/v1`,
			TESTKIT_LOCAL_MODEL: "tier-judge",
		});
		if (!("tier" in r)) throw new Error(r.skip);
		const j = await judge({ rubric, transcript: "see src/a.ts", model: r.tier });
		expect(j.pass).toBe(true);
		expect(gw.trace.requests[0].model).toBe("tier-judge");
		expect(gw.trace.requests[0].raw).toMatchObject({ reasoning_effort: "none", temperature: 0 });
	});
});

/** A fake grader that answers every criterion with the given score and pass value. */
const scoring = (scores: Record<string, unknown>, pass = true) =>
	script([
		{
			text: JSON.stringify({
				verdicts: Object.entries(scores).map(([id, score]) => ({ id, score, pass, reason: `score ${score}` })),
			}),
		},
	]);

describe("judge scores", () => {
	const scoredRubric = [{ id: "depth", text: "Explains the cause" }];

	it("passes a criterion scored at the threshold and fails one just below it (boundary)", async () => {
		const at = await model(scoring({ depth: 0.7 }, false));
		const pass = await judge({
			rubric: scoredRubric,
			transcript: "x",
			model: at.model,
			scored: { threshold: 0.7 },
		});
		expect(pass.pass).toBe(true);
		expect(pass.criteria[0]).toMatchObject({ pass: true, score: 0.7 });

		const below = await model(scoring({ depth: 0.69 }, true));
		const fail = await judge({
			rubric: scoredRubric,
			transcript: "x",
			model: below.model,
			scored: { threshold: 0.7 },
		});
		expect(fail.pass).toBe(false);
		expect(fail.criteria[0]).toMatchObject({ pass: false, score: 0.69 });
		expect(explainJudgement(fail)).toBe("depth (Explains the cause) [score 0.69]: score 0.69\nmean score 0.69");
	});

	it("asks for a score in the system prompt only in scored mode", async () => {
		const plain = await model(scoring({ depth: 1 }));
		await judge({ rubric: scoredRubric, transcript: "x", model: plain.model });
		const plainSystem = String(plain.gw.trace.requests[0].messages.find((x) => x.role === "system")?.content);
		expect(plainSystem).not.toContain("score");

		const scored = await model(scoring({ depth: 1 }));
		await judge({ rubric: scoredRubric, transcript: "x", model: scored.model, scored: { threshold: 0.5 } });
		const scoredSystem = String(scored.gw.trace.requests[0].messages.find((x) => x.role === "system")?.content);
		expect(scoredSystem).toContain('"score":<number from 0 to 1>');
	});

	it.each([
		["a missing score", { depth: undefined }],
		["a score above 1", { depth: 1.5 }],
		["a negative score", { depth: -0.1 }],
		["a string score", { depth: "0.9" }],
	])("throws on %s, never a pass (must-fail)", async (_label, scores) => {
		const { model: m } = await model(
			script([{ text: JSON.stringify({ verdicts: [{ id: "depth", pass: true, reason: "r", ...scores }] }) }]),
		);
		await expect(
			judge({ rubric: scoredRubric, transcript: "x", model: m, scored: { threshold: 0.5 } }),
		).rejects.toThrow("judge: criterion depth has no valid score");
	});

	it("throws when the grader gives no verdict for a criterion in scored mode", async () => {
		const { model: m } = await model(scoring({}));
		await expect(
			judge({ rubric: scoredRubric, transcript: "x", model: m, scored: { threshold: 0.5 } }),
		).rejects.toThrow("judge: criterion depth has no valid score");
	});

	it.each([0, -0.2, 1.01])("rejects threshold %s", async (threshold) => {
		const { model: m } = await model(scoring({ depth: 1 }));
		await expect(judge({ rubric: scoredRubric, transcript: "x", model: m, scored: { threshold } })).rejects.toThrow(
			"judge: scored threshold must be in (0, 1]",
		);
	});

	it("reports the mean criterion score as the judgement score", async () => {
		const { model: m } = await model(scoring({ a: 0.2, b: 0.6, c: 1 }));
		const j = await judge({
			rubric: ["x", "y", "z"].map((text, i) => ({ id: ["a", "b", "c"][i], text })),
			transcript: "x",
			model: m,
			scored: { threshold: 0.5 },
		});
		expect(j.score).toBeCloseTo(0.6, 10);
		expect(j.criteria.map((c) => c.pass)).toEqual([false, true, true]);
		expect(explainJudgement(j)).toBe("a (x) [score 0.20]: score 0.2\nmean score 0.60");
	});

	it("leaves score fields out of the default mode", async () => {
		const { model: m } = await model(scoring({ depth: 1 }));
		const j = await judge({ rubric: scoredRubric, transcript: "x", model: m });
		expect(j.score).toBeUndefined();
		expect("score" in j.criteria[0]).toBe(false);
		expect(explainJudgement(j)).toBe("all criteria passed");
	});
});

describe("judgePanel", () => {
	const cites = (pass: boolean) =>
		script([
			{
				text: JSON.stringify({
					verdicts: [{ id: "cites-file", pass, reason: pass ? "names src/a.ts" : "no file named" }],
				}),
			},
		]);

	it("passes by majority with 2 of 3 judges and reports per-criterion votes and agreement", async () => {
		const judges = await Promise.all([model(cites(true)), model(cites(true)), model(cites(false))]);
		const panel = await judgePanel({
			rubric: [{ id: "cites-file", text: rubric[0].text }],
			transcript: "see src/a.ts",
			models: judges.map((j) => j.model),
		});
		expect(panel.pass).toBe(true);
		expect(panel.judgements.map((j) => j.pass)).toEqual([true, true, false]);
		expect(panel.perCriterion).toEqual([{ id: "cites-file", passes: 2, of: 3 }]);
		expect(panel.agreement).toBeCloseTo(1 / 3, 10);
	});

	it("sends the rubric to every judge in parallel, each on its own endpoint", async () => {
		const judges = await Promise.all([model(grader), model(grader), model(grader)]);
		const panel = await judgePanel({
			rubric,
			transcript: "The fix is in src/a.ts, thanks!",
			models: judges.map((j) => j.model),
		});
		expect(panel.pass).toBe(true);
		for (const j of judges) expect(j.gw.trace.requests).toHaveLength(1);
		// Two criteria, three judges: 3 criterion pairs each, all agreeing.
		expect(panel.agreement).toBe(1);
		expect(panel.perCriterion).toEqual([
			{ id: "cites-file", passes: 3, of: 3 },
			{ id: "polite", passes: 3, of: 3 },
		]);
	});

	it("fails a 2-judge tie (must-fail)", async () => {
		const judges = await Promise.all([model(cites(true)), model(cites(false))]);
		const panel = await judgePanel({
			rubric: [{ id: "cites-file", text: rubric[0].text }],
			transcript: "x",
			models: judges.map((j) => j.model),
		});
		expect(panel.pass).toBe(false);
		expect(panel.agreement).toBe(0);
	});

	it("reports agreement 1 and no pairs for a single judge", async () => {
		const only = await model(cites(false));
		const panel = await judgePanel({
			rubric: [{ id: "cites-file", text: rubric[0].text }],
			transcript: "x",
			models: [only.model],
		});
		expect(panel.pass).toBe(false);
		expect(panel.agreement).toBe(1);
	});

	it("rejects the whole panel when one judge throws, never counting it as a vote (must-fail)", async () => {
		const judges = await Promise.all([
			model(cites(true)),
			model(cites(true)),
			model(script([{ text: "Looks fine to me." }])),
		]);
		await expect(
			judgePanel({
				rubric: [{ id: "cites-file", text: rubric[0].text }],
				transcript: "x",
				models: judges.map((j) => j.model),
			}),
		).rejects.toThrow(/not JSON/);
	});

	it("rejects an empty model list", async () => {
		await expect(judgePanel({ rubric, transcript: "x", models: [] })).rejects.toThrow(
			"judge: panel needs at least one model",
		);
	});
});

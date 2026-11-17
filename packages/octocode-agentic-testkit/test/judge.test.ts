import { describe, expect, it } from "vitest";
import { explainJudgement, judge } from "../src/judge.ts";
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

	it("throws when the judge does not answer in JSON, never a pass (must-fail)", async () => {
		const { model: m } = await model(script([{ text: "Looks fine to me." }]));
		await expect(judge({ rubric, transcript: "x", model: m })).rejects.toThrow(/not JSON/);
		const { model: m2 } = await model(script([{ text: '{"ok":true}' }]));
		await expect(judge({ rubric, transcript: "x", model: m2 })).rejects.toThrow(/no verdicts/);
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

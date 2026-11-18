import { describe, expect, it } from "vitest";
import { classify, compareTable, type SkillRow } from "./compare.ts";

const s = (successes: number, trials: number, decision: "pass" | "fail" | "inconclusive") =>
	({
		decision,
		trials,
		successes,
		failures: trials - successes,
		passRate: trials ? successes / trials : 0,
		probability: 0,
		threshold: 0.5,
		stoppedEarly: true,
	}) as const;
const row = (fire: ReturnType<typeof s>, notFired = s(3, 3, "pass")): SkillRow => ({ fire, nearMiss: notFired });
const good = row(s(3, 3, "pass"));
const miss = row(s(0, 3, "fail"));

describe("trigger verdicts", () => {
	it("ok when every tier fires", () => expect(classify(good, [good, good])).toBe("ok"));
	it("description problem when no tier fires", () => expect(classify(miss, [miss, miss])).toBe("description problem"));
	it("small-model limit when only the small model misses", () =>
		expect(classify(miss, [good, good])).toBe("small-model limit"));
	it("model-specific when a strong tier splits", () => expect(classify(good, [miss, good])).toBe("model-specific"));
	it("over-broad when a near-miss fires on any tier", () =>
		expect(classify(good, [row(s(3, 3, "pass"), s(0, 3, "fail"))])).toBe("over-broad"));
	it("a near-miss that only the small model fires is a small-model limit", () =>
		expect(classify(row(s(3, 3, "pass"), s(0, 3, "fail")), [good])).toBe("small-model limit"));
	it("errors are not answers: an all-error tier is ignored, not a miss", () => {
		const errored: SkillRow = { fire: s(0, 3, "fail"), nearMiss: s(0, 3, "fail"), fireErrors: 3, nearMissErrors: 3 };
		expect(classify(miss, [good, errored])).toBe("small-model limit");
		expect(classify(miss, [errored])).toBe("no data");
		expect(compareTable([{ name: "a", result: { skills: { x: errored } } }])).toContain("error (0 answered)");
	});
	it("description problem needs haiku to miss too", () => {
		const errored: SkillRow = { fire: s(0, 3, "fail"), fireErrors: 3 };
		expect(classify(miss, [errored, miss])).not.toBe("description problem");
	});
	it("no data without rows", () => expect(classify(undefined, [undefined])).toBe("no data"));
	it("renders a row per skill with percentages", () => {
		const md = compareTable([
			{ name: "bonsai", result: { skills: { a: miss } } },
			{ name: "haiku", result: { skills: { a: good } } },
		]);
		expect(md).toContain("| a | 0% (0/3) fail | 100% (3/3) pass |");
		expect(md).toContain("small-model limit");
	});
});

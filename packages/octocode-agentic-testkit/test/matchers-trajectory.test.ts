import { describe, expect, it } from "vitest";
import { call, traceOf } from "./matchers-fixtures.ts";

const t = traceOf([call("a", { q: 1, x: 2 }), call("b", { z: 1 }), call("a", { q: 1, x: 2 })]);

describe("toFollowTrajectory modes", () => {
	it("strict: same calls, order and count", () => {
		expect(t).toFollowTrajectory(["a", "b", "a"]);
		expect(() => expect(t).toFollowTrajectory(["a", "b"])).toThrow(/trajectory does not match/);
		expect(() => expect(t).toFollowTrajectory(["b", "a", "a"])).toThrow(/trajectory does not match/);
		expect(() => expect(t).toFollowTrajectory(["a", "b", "a", "a"])).toThrow(/expected: a -> b -> a -> a/);
	});

	it("unordered: same multiset", () => {
		expect(t).toFollowTrajectory(["b", "a", "a"], { mode: "unordered" });
		expect(() => expect(t).toFollowTrajectory(["b", "a"], { mode: "unordered" })).toThrow(/does not match/);
		expect(() => expect(t).toFollowTrajectory(["b", "b", "a"], { mode: "unordered" })).toThrow(/does not match/);
	});

	it("superset: actual contains every expected call", () => {
		expect(t).toFollowTrajectory(["b", "a"], { mode: "superset" });
		expect(t).toFollowTrajectory(["a", "a"], { mode: "superset" });
		expect(() => expect(t).toFollowTrajectory(["a", "a", "a"], { mode: "superset" })).toThrow(/does not match/);
		expect(() => expect(t).toFollowTrajectory(["c"], { mode: "superset" })).toThrow(/does not match/);
	});

	it("subset: every actual call is an expected step", () => {
		expect(t).toFollowTrajectory(["a", "b", "c"], { mode: "subset" });
		expect(() => expect(t).toFollowTrajectory(["a"], { mode: "subset" })).toThrow(/does not match/);
	});

	it("works under .not and shows expected and actual", () => {
		expect(t).not.toFollowTrajectory(["a"]);
		expect(() => expect(t).not.toFollowTrajectory(["a", "b", "a"])).toThrow(/not to match/);
		expect(() => expect(t).toFollowTrajectory(["z"])).toThrow(/actual:   a\(.*\) -> b/);
	});
});

describe("toFollowTrajectory args", () => {
	const one = traceOf([call("a", { q: 1, x: 2 })]);

	it("subset (default): expected args are contained", () => {
		expect(one).toFollowTrajectory([{ tool: "a", args: { q: 1 } }]);
		expect(() => expect(one).toFollowTrajectory([{ tool: "a", args: { q: 2 } }])).toThrow(/does not match/);
		expect(() => expect(one).toFollowTrajectory([{ tool: "a", args: { y: 1 } }])).toThrow(/does not match/);
	});

	it("exact: canonical equality", () => {
		expect(one).toFollowTrajectory([{ tool: "a", args: { x: 2, q: 1 } }], { args: "exact" });
		expect(() => expect(one).toFollowTrajectory([{ tool: "a", args: { q: 1 } }], { args: "exact" })).toThrow(
			/does not match/,
		);
	});

	it("ignore: name only", () => {
		expect(one).toFollowTrajectory([{ tool: "a", args: { nothing: 1 } }], { args: "ignore" });
		expect(() => expect(one).toFollowTrajectory([{ tool: "b" }], { args: "ignore" })).toThrow(/does not match/);
	});
});

describe("toFollowTrajectory agent and observability", () => {
	it("filters by agent", () => {
		const m = traceOf([call("a", {}, "main"), call("b", {}, "coder")]);
		expect(m).toFollowTrajectory(["b"], { agent: "coder" });
		expect(() => expect(m).toFollowTrajectory(["b"], { agent: "main" })).toThrow(/does not match/);
	});

	it("passes an empty expectation when requests exist but no calls", () => {
		expect(traceOf([], [{}])).toFollowTrajectory([]);
	});

	it("cannot observe an empty run, also under .not", () => {
		const e = traceOf([{ kind: "answer" }]);
		expect(() => expect(e).not.toFollowTrajectory(["a"])).toThrow(/cannot observe/);
	});
});

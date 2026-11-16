import { describe, expect, it } from "vitest";
import { compileQuery, PATTERN_MAX } from "../../src/octocode/memory/safe-pattern.ts";

describe("memory query patterns", () => {
	it("rejects patterns that backtrack exponentially, fast", () => {
		const started = Date.now();
		for (const bad of ["(a+)+$", "(a*)*b", "(x+x+)+y", "(a{1,5})+", "(a)\\1", "((ab)+c)*"])
			expect(() => compileQuery(bad), bad).toThrow(/rejected/);
		expect(() => compileQuery("a".repeat(PATTERN_MAX + 1))).toThrow(/at most/);
		expect(() => compileQuery("(")).toThrow(/not a valid/);
		expect(Date.now() - started).toBeLessThan(1000);
	});

	it("keeps ordinary expressions", () => {
		expect(compileQuery("foo|bar").test("a BAR")).toBe(true);
		expect(compileQuery("(foo|bar)+baz").test("foobarbaz")).toBe(true);
		expect(compileQuery("(ab)?c+").test("abccc")).toBe(true);
		expect(compileQuery("[a+]+x").test("a+x")).toBe(true);
		expect(compileQuery("\\d+\\.\\d+").test("v1.25")).toBe(true);
	});
});

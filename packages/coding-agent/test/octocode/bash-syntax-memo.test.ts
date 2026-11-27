import { describe, expect, it } from "vitest";
import { bashSyntax, initializeBashSyntax } from "../../src/octocode/permission/bash-syntax.ts";

/** The parse of a line is shared by the checks of one call: the same answer, never a stale or changeable one. */
describe("bashSyntax shares one parse per line", () => {
	it("does not keep the answer given before the parser loaded", async () => {
		const line = "echo hi > out.txt";
		expect(bashSyntax(line).incomplete).toBe(true);
		await initializeBashSyntax();
		const parsed = bashSyntax(line);
		expect(parsed.incomplete).toBe(false);
		expect(parsed.targets).toEqual([expect.objectContaining({ kind: "write", path: "out.txt" })]);
	});

	it("answers a repeated line with the same frozen parse", async () => {
		await initializeBashSyntax();
		const line = "cd sub && cat a.txt | tee b.txt";
		const first = bashSyntax(line);
		expect(bashSyntax(line)).toBe(first);
		expect(Object.isFrozen(first)).toBe(true);
		expect(Object.isFrozen(first.commands[0].tokens[0])).toBe(true);
		expect(() => (first.targets as unknown[]).push({})).toThrow(TypeError);
		expect(bashSyntax(line).targets).toEqual(first.targets);
	});

	it("parses each distinct line on its own", async () => {
		await initializeBashSyntax();
		expect(bashSyntax("cat a.txt").targets.map((target) => target.path)).toEqual(["a.txt"]);
		expect(bashSyntax("cat b.txt").targets.map((target) => target.path)).toEqual(["b.txt"]);
	});
});

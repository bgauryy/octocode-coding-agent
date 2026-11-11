import { describe, expect, it } from "vitest";
import { escapeRegExp } from "../src/regexp.ts";

describe("escapeRegExp", () => {
	it("makes every metacharacter literal", () => {
		const text = "a.b*c+d?e^f$g{h}i(j)k|l[m]n\\o";
		expect(new RegExp(`^${escapeRegExp(text)}$`).test(text)).toBe(true);
		expect(new RegExp(escapeRegExp("a.b")).test("axb")).toBe(false);
	});
});

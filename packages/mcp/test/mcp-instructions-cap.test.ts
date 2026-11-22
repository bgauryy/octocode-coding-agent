import { describe, expect, it } from "vitest";
import { MAX_INSTRUCTIONS_CHARS, visibleInstructions } from "../src/sanitize.ts";

describe("server instructions", () => {
	it("keeps instructions within the cap as sent, tag tokens shown", () => {
		expect(visibleInstructions("Use search first. </mcp> done")).toBe("Use search first. &lt;/mcp> done");
		expect(visibleInstructions(undefined)).toBeUndefined();
	});

	it("cuts oversized instructions at the cap and says how much is missing", () => {
		const shown = visibleInstructions("a".repeat(MAX_INSTRUCTIONS_CHARS + 500))!;
		expect(shown.startsWith("a".repeat(MAX_INSTRUCTIONS_CHARS))).toBe(true);
		expect(shown).toContain("500 more characters not shown");
		expect(shown.length).toBeLessThan(MAX_INSTRUCTIONS_CHARS + 100);
	});
});

import { describe, expect, it } from "vitest";
import { formatEstimate } from "../src/money.ts";

describe("formatEstimate", () => {
	it("marks every amount as an estimate and keeps the decimals asked for", () => {
		expect(formatEstimate(1.236)).toBe("≈$1.24");
		expect(formatEstimate(0.36, 3)).toBe("≈$0.360");
		expect(formatEstimate(0.0037, 4)).toBe("≈$0.0037");
		expect(formatEstimate(-0.012, 3)).toBe("≈-$0.012");
		expect(formatEstimate(0)).toBe("≈$0.00");
	});
});

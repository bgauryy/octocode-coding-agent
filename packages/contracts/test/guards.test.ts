import { expect, it } from "vitest";
import { errorMessage, isRecord } from "../src/guards.ts";

it("accepts plain objects and rejects null, arrays and primitives", () => {
	expect(isRecord({})).toBe(true);
	expect(isRecord({ a: 1 })).toBe(true);
	expect(isRecord(null)).toBe(false);
	expect(isRecord([])).toBe(false);
	expect(isRecord("text")).toBe(false);
	expect(isRecord(undefined)).toBe(false);
});

it("reads an error's message and stringifies other values", () => {
	expect(errorMessage(new Error("boom"))).toBe("boom");
	expect(errorMessage("plain")).toBe("plain");
	expect(errorMessage(42)).toBe("42");
});

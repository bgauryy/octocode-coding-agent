import { describe, expect, it } from "vitest";
import { formatDuration } from "../src/utils/duration.ts";

describe("formatDuration", () => {
	it.each([
		[0, "0s"],
		[45_000, "45s"],
		[134_000, "2m14s"],
		[900_000, "15m"],
		[3_780_000, "1h03m"],
		[7_200_000, "2h"],
	])("default %i -> %s", (ms, text) => expect(formatDuration(ms)).toBe(text));

	it.each([
		[850, "850ms"],
		[1_200, "1.2s"],
		[6_000, "6s"],
		[134_000, "2m14s"],
	])("precise %i -> %s", (ms, text) => expect(formatDuration(ms, true)).toBe(text));

	it.each([
		[59_000, ""],
		[45 * 60_000, "45m"],
		[60 * 60_000, "1h"],
		[93 * 60_000, "1h 33m"],
		[(51 * 60 + 10) * 60_000, "2d 3h"],
		[48 * 3_600_000, "2d"],
	])("compact %i -> %s", (ms, text) => expect(formatDuration(ms, { style: "compact" })).toBe(text));
});

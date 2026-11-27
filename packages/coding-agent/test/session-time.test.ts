import { describe, expect, it } from "vitest";
import {
	formatDuration,
	formatSessionTime,
	formatStart,
} from "../src/modes/interactive/components/session-selector/utils.ts";

const clock = (date: Date) => date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

describe("session time on /resume rows", () => {
	it("formats a span as its two largest units and nothing under a minute", () => {
		expect(formatDuration(59_000)).toBe("");
		expect(formatDuration(45 * 60_000)).toBe("45m");
		expect(formatDuration(60 * 60_000)).toBe("1h");
		expect(formatDuration(93 * 60_000)).toBe("1h 33m");
		expect(formatDuration((51 * 60 + 10) * 60_000)).toBe("2d 3h");
		expect(formatDuration(48 * 3_600_000)).toBe("2d");
	});

	it("dates the start only as far as needed", () => {
		const now = new Date(2026, 9, 31, 18, 0);
		const today = new Date(2026, 9, 31, 9, 5);
		const thisWeek = new Date(2026, 9, 28, 9, 5);
		const thisYear = new Date(2026, 5, 2, 9, 5);
		const lastYear = new Date(2025, 5, 2, 9, 5);
		expect(formatStart(today, now)).toBe(clock(today));
		expect(formatStart(thisWeek, now)).toBe(
			`${thisWeek.toLocaleDateString(undefined, { weekday: "short" })} ${clock(thisWeek)}`,
		);
		expect(formatStart(thisYear, now)).not.toContain("2026");
		expect(formatStart(lastYear, now)).toContain("2025");
	});

	it("joins start and span, and is empty for an unknown start", () => {
		const now = new Date(2026, 9, 31, 18, 0);
		const start = new Date(2026, 9, 31, 14, 32);
		expect(formatSessionTime(start, new Date(2026, 9, 31, 16, 5), now)).toBe(`${clock(start)} (1h 33m)`);
		expect(formatSessionTime(start, start, now)).toBe(clock(start));
		expect(formatSessionTime(new Date(0), now, now)).toBe("");
		expect(formatSessionTime(new Date(Number.NaN), now, now)).toBe("");
	});
});

import { describe, expect, it } from "vitest";
import { historyWindows, resolveRetention, retentionProblems } from "../../src/storage/retention.ts";

describe("resolveRetention", () => {
	it("defaults to 30 days for data and 90 for transcripts", () => {
		expect(resolveRetention({}, {})).toEqual({ days: 30, sessionDays: 90 });
	});

	it("reads the retention setting per field", () => {
		expect(resolveRetention({}, { retention: { days: 7 } })).toEqual({ days: 7, sessionDays: 90 });
		expect(resolveRetention({}, { retention: { sessionDays: 365 } })).toEqual({ days: 30, sessionDays: 365 });
	});

	it("lets the environment override the setting: env 7 beats setting 30", () => {
		const settings = { retention: { days: 30, sessionDays: 30 } };
		expect(resolveRetention({ OCTOCODE_CLEANUP_DAYS: "7" }, settings)).toEqual({ days: 7, sessionDays: 30 });
		expect(resolveRetention({ OCTOCODE_SESSION_RETENTION_DAYS: "200" }, settings)).toEqual({
			days: 30,
			sessionDays: 200,
		});
	});

	it("treats 0 as keep forever, from the setting and from the environment", () => {
		expect(resolveRetention({}, { retention: { days: 0, sessionDays: 0 } })).toEqual({ days: 0, sessionDays: 0 });
		expect(resolveRetention({ OCTOCODE_CLEANUP_DAYS: "0" }, { retention: { days: 30 } }).days).toBe(0);
	});

	it("ignores invalid values and falls back to the next source", () => {
		const settings = { retention: { days: -1, sessionDays: 1.5 } };
		expect(resolveRetention({ OCTOCODE_CLEANUP_DAYS: "abc", OCTOCODE_SESSION_RETENTION_DAYS: "-3" }, settings)).toEqual(
			{
				days: 30,
				sessionDays: 90,
			},
		);
		expect(resolveRetention({ OCTOCODE_CLEANUP_DAYS: "-3" }, { retention: { days: 12 } }).days).toBe(12);
		expect(resolveRetention({}, { retention: "yes" }).days).toBe(30);
	});

	it("derives the history windows from the one retention", () => {
		expect(historyWindows({ OCTOCODE_CLEANUP_DAYS: "45" })).toEqual({ archiveAfterDays: 14, keepDays: 45 });
	});
});

describe("retentionProblems", () => {
	it("reports nothing for a valid or absent value", () => {
		expect(retentionProblems(undefined)).toEqual([]);
		expect(retentionProblems({ days: 0, sessionDays: 90 })).toEqual([]);
	});

	it("names each bad field", () => {
		const problems = retentionProblems({ days: -2, sessionDays: "90", extra: 1 });
		expect(problems).toHaveLength(3);
		expect(problems.join("\n")).toContain("retention.days");
		expect(problems.join("\n")).toContain("retention.sessionDays");
		expect(problems.join("\n")).toContain("retention.extra");
		expect(retentionProblems(5)[0]).toContain("must be an object");
	});
});

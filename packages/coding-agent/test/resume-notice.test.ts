import { describe, expect, it } from "vitest";
import { formatResumeNotice } from "../src/modes/interactive/interactive-mode/resume-notice.ts";

function host(name: string | undefined, types: string[], timestamp: string) {
	return {
		sessionManager: {
			getSessionName: () => name,
			getSessionId: () => "abcdef123456",
			getEntries: () => types.map((type) => ({ type, timestamp })),
		},
	} as never;
}

describe("formatResumeNotice", () => {
	const now = Date.parse("2026-01-01T03:00:00Z");
	it("names the session, counts messages and gives the age", () => {
		expect(
			formatResumeNotice(host("fix auth", ["message", "message", "compaction"], "2026-01-01T00:00:00Z"), now),
		).toBe("Resumed fix auth · 2 messages · last active 3h ago");
	});
	it("falls back to the short id", () => {
		expect(formatResumeNotice(host(undefined, ["message"], "2026-01-01T02:59:50Z"), now)).toBe(
			"Resumed abcdef12 · 1 message · last active just now",
		);
	});
});

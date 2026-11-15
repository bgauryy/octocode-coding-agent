import { describe, expect, it } from "vitest";
import { timerFields } from "../../../src/octocode/timer/model.ts";

const owner = { workspaceId: "w", sessionId: "s", cwd: "/tmp" };
const set = (input: Parameters<typeof timerFields>[0]) => timerFields(input, 0, owner);

describe("timer set rules", () => {
	it("refuses a set without a note", () => {
		expect(() => set({ after: 60 })).toThrow("set needs a note");
		expect(() => set({ after: 60, note: "  " })).toThrow("set needs a note");
	});

	it("accepts maxRuns on a repeating timer and defaults it to 20", () => {
		expect(set({ note: "poll", every: 30, maxRuns: 3 })).toMatchObject({ kind: "every", maxRuns: 3 });
		expect(set({ note: "poll", every: 30 })).toMatchObject({ kind: "every", maxRuns: 20 });
	});

	it("refuses maxRuns on an until timer and on a lone after", () => {
		expect(() => set({ note: "n", until: { command: "true" }, maxRuns: 2 })).toThrow("maxRuns counts wakes of every");
		expect(() => set({ note: "n", after: 60, maxRuns: 2 })).toThrow("maxRuns and deadline bound every or until");
	});
});

import type { Usage } from "@octocodeai/octocode-ai";
import { describe, expect, it } from "vitest";
import type { SessionEntry } from "../src/core/session-manager.ts";
import { compactionUsage } from "../src/modes/interactive/interactive-mode/compaction-cost.ts";

const usage = (total: number, input = 10): Usage => ({
	input,
	output: 1,
	cacheRead: 100,
	cacheWrite: 0,
	totalTokens: input + 101,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total },
});
const attempt = (id: string, total: number): SessionEntry => ({
	type: "usage",
	id,
	parentId: null,
	timestamp: "",
	kind: "compaction_attempt",
	provider: "anthropic",
	model: "claude-opus-5-5",
	usage: usage(total),
});

describe("the cost line under a compaction", () => {
	const entries = new Map([
		["a1", attempt("a1", 0.1)],
		["a2", attempt("a2", 0.05)],
	]);
	const getEntry = (id: string) => entries.get(id);

	it("sums the summary attempts the entry names when the entry carries no usage", () => {
		const cost = compactionUsage({ details: { attemptIds: ["a1", "a2", "gone"] } }, getEntry);
		expect(cost?.cost.total).toBeCloseTo(0.15, 10);
		expect(cost?.input).toBe(20);
	});

	it("keeps the usage an older entry carries, and shows nothing without either", () => {
		expect(compactionUsage({ usage: usage(0.3), details: { attemptIds: ["a1"] } }, getEntry)?.cost.total).toBe(0.3);
		expect(compactionUsage({ details: { readFiles: [] } }, getEntry)).toBeUndefined();
		expect(compactionUsage({}, getEntry)).toBeUndefined();
	});
});

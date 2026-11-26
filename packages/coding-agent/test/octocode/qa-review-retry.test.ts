import { beforeEach, describe, expect, it, vi } from "vitest";

const spawnAgent = vi.fn();
vi.mock("../../src/octocode/subagents/spawn.ts", () => ({ spawnAgent: (...args: unknown[]) => spawnAgent(...args) }));
vi.mock("../../src/octocode/subagents/small-call.ts", () => ({ smallModelLabel: () => "anthropic/haiku" }));

const { qaReviewer } = await import("../../src/octocode/subagents/qa-review.ts");
const { applyReview } = await import("../../src/octocode/backlog/qa-gate.ts");
const { fakeCtx } = await import("./fake-host.ts");

const request = { ref: "B1", title: "t", goal: "g", summary: "s", verification: "v", files: [] as string[] };
const invalid = { details: { structured: { status: "invalid" } }, usage: { cost: 0.01 } };
const valid = {
	details: { structured: { status: "valid", data: { verdict: "Ready", summary: "fine", findings: [] } } },
	usage: { cost: 0.02 },
};

beforeEach(() => {
	spawnAgent.mockReset();
});

describe("the QA reviewer's answer off the schema", () => {
	it("is retried exactly once and the valid verdict of the retry is used, both costs counted", async () => {
		spawnAgent.mockResolvedValueOnce(invalid).mockResolvedValueOnce(valid);
		const review = await qaReviewer({} as never)(request, fakeCtx({ cwd: "/tmp" }));
		expect(spawnAgent).toHaveBeenCalledTimes(2);
		expect(review).toMatchObject({ verdict: { verdict: "Ready" }, cost: 0.03 });
	});

	it("does not retry a valid first answer", async () => {
		spawnAgent.mockResolvedValueOnce(valid);
		await qaReviewer({} as never)(request, fakeCtx({ cwd: "/tmp" }));
		expect(spawnAgent).toHaveBeenCalledTimes(1);
	});

	it("owes the review after two invalid answers, with the reason in the note", async () => {
		spawnAgent.mockResolvedValue(invalid);
		const review = await qaReviewer({} as never)(request, fakeCtx({ cwd: "/tmp" }));
		expect(spawnAgent).toHaveBeenCalledTimes(2);
		expect(review).toHaveProperty("unavailable");
		const note = await applyReview({} as never, review, async () => undefined);
		expect(note).toMatch(/^QA owed: .*no valid verdict twice/);
	});
});

describe("a reviewer that cannot run", () => {
	it("is unavailable, not skipped, when the start throws; the gate marks the review owed", async () => {
		spawnAgent.mockRejectedValue(new Error("spawn ENOENT"));
		const review = await qaReviewer({} as never)(request, fakeCtx({ cwd: "/tmp" }));
		expect(review).toEqual({ unavailable: "the reviewer could not start: spawn ENOENT" });
		const note = await applyReview({} as never, review, async () => undefined);
		expect(note).toMatch(/^QA owed: .*spawn ENOENT.*it reruns when a reviewer can start/);
	});

	it("is unavailable when the review times out", async () => {
		spawnAgent.mockImplementation(
			(...args: unknown[]) =>
				new Promise((_resolve, reject) =>
					(args[3] as AbortSignal).addEventListener("abort", () => reject(new Error("aborted"))),
				),
		);
		const review = await qaReviewer({} as never, { timeoutMs: 20 })(request, fakeCtx({ cwd: "/tmp" }));
		expect(review).toHaveProperty("unavailable", expect.stringMatching(/timed out/));
	});
});

describe("the QA review's scope", () => {
	it("tells the reviewer to judge only the item's own changes, against HEAD when there is no baseline", async () => {
		spawnAgent.mockResolvedValueOnce(valid);
		await qaReviewer({} as never)({ ...request, files: ["a.ts"] }, fakeCtx({ cwd: "/tmp" }));
		const task: string = spawnAgent.mock.calls[0][2].task;
		expect(task).toContain("Judge only the item's own changes");
		expect(task).toContain("against HEAD");
	});

	it("keeps findings that are only context from blocking: a Ready verdict completes and shows them", async () => {
		const sendBack = vi.fn();
		const review = {
			verdict: {
				verdict: "Ready" as const,
				summary: "fine",
				findings: [],
				context: ["x.test.ts fails from a sibling's edit"],
			},
			model: "m",
			cost: 0,
		};
		const note = await applyReview({ ref: "B1" } as never, review, sendBack);
		expect(sendBack).not.toHaveBeenCalled();
		expect(note).toContain("Context, not blocking:\n- x.test.ts fails from a sibling's edit");
	});
});

import { beforeEach, describe, expect, it, vi } from "vitest";

const spawn = vi.hoisted(() => ({
	calls: [] as unknown[][],
	reply: undefined as unknown,
	fail: undefined as Error | undefined,
}));
const small = vi.hoisted(() => ({ label: "anthropic/claude-haiku" as string | undefined }));

vi.mock("../../src/octocode/subagents/spawn.ts", () => ({
	spawnAgent: async (...args: unknown[]) => {
		spawn.calls.push(args);
		if (spawn.fail) throw spawn.fail;
		return spawn.reply;
	},
}));
vi.mock("../../src/octocode/subagents/small-call.ts", () => ({ smallModelLabel: () => small.label }));

import { QA_PR_SKILL, QA_RESULT_SCHEMA, QA_SKILL, qaReviewer } from "../../src/octocode/subagents/qa-review.ts";
import { admitResultSchema } from "../../src/octocode/subagents/result-schema.ts";
import { linkedPullRequest } from "../../src/octocode/backlog/qa-gate.ts";

const request = {
	ref: "B7",
	title: "Gate",
	goal: "Gate works",
	summary: "did it",
	verification: "ran tests (status: passed)",
	files: ["does-not-exist.ts"],
};
const ctx = { cwd: process.cwd() } as never;
const review = () => qaReviewer({} as never)(request, ctx);
const valid = (data: unknown, cost = 0.002) => ({
	details: { structured: { version: 1, schemaHash: "h", status: "valid", data } },
	usage: { cost },
});

beforeEach(() => {
	spawn.calls = [];
	spawn.reply = undefined;
	spawn.fail = undefined;
	small.label = "anthropic/claude-haiku";
});

describe("the QA reviewer child", () => {
	it("admits its verdict schema", () => {
		expect(() => admitResultSchema(QA_RESULT_SCHEMA)).not.toThrow();
	});

	it("starts a foreground read-only reviewer on the priced small model with the code-review skill", async () => {
		spawn.reply = valid({ verdict: "Ready", summary: "fine", findings: [] });
		await review();
		const [, id, params, , , , mail, holdTurn] = spawn.calls[0] as [
			unknown,
			string,
			Record<string, unknown>,
			...unknown[],
		];
		expect(id).toBe("qa-B7");
		expect(params).toMatchObject({
			profile: "reviewer",
			model: "anthropic/claude-haiku:low",
			skills: [QA_SKILL],
			background: false,
			resultSchema: QA_RESULT_SCHEMA,
		});
		expect(QA_SKILL).toBe("octocode-code-review");
		expect(params.task).toMatch(/Gate works[\s\S]*did it[\s\S]*ran tests[\s\S]*does-not-exist\.ts/);
		expect([mail, holdTurn]).toEqual([false, true]);
	});

	it("finds the pull request an item links, and nothing for other links", () => {
		const external = (url: string) => ({
			relation: "related" as const,
			target: { resource: "external" as const, url },
		});
		expect(
			linkedPullRequest([external("https://example.com/docs"), external("https://github.com/acme/app/pull/7")]),
		).toBe("https://github.com/acme/app/pull/7");
		expect(linkedPullRequest([external("https://github.com/acme/app/issues/7")])).toBeUndefined();
		expect(linkedPullRequest([])).toBeUndefined();
	});

	it("reviews with the pull-request skill when the item links a pull request", async () => {
		spawn.reply = valid({ verdict: "Ready", summary: "fine", findings: [] });
		const pullRequest = "https://github.com/acme/app/pull/7";
		await qaReviewer({} as never)({ ...request, pullRequest }, ctx);
		const params = spawn.calls[0][2] as Record<string, unknown>;
		expect(params.skills).toEqual([QA_PR_SKILL]);
		expect(QA_PR_SKILL).toBe("octocode-pr-review");
		expect(params.task).toContain(pullRequest);
		expect(params.task).toContain(QA_PR_SKILL);
	});

	it.each(["Ready", "Changes required", "Verification incomplete"])(
		"maps the %s verdict with its model and cost",
		async (word) => {
			spawn.reply = valid({ verdict: word, summary: "why", findings: word === "Ready" ? [] : ["a.ts:1 bad"] }, 0.0042);
			expect(await review()).toEqual({
				verdict: { verdict: word, summary: "why", findings: word === "Ready" ? [] : ["a.ts:1 bad"] },
				model: "anthropic/claude-haiku",
				cost: 0.0042,
			});
		},
	);

	it("adds a finding when a non-Ready verdict names none", async () => {
		spawn.reply = valid({ verdict: "Changes required", summary: "bad", findings: [] });
		const result = await review();
		expect("verdict" in result && result.verdict.findings).toHaveLength(1);
	});

	it("is skipped, never refused, with no priced small model (no child is started)", async () => {
		small.label = undefined;
		expect(await review()).toEqual({ skipped: "no priced small model is connected" });
		expect(spawn.calls).toHaveLength(0);
	});

	it("is unavailable when the child cannot start, and owed when it answers off the schema", async () => {
		spawn.fail = new Error("slot limit");
		expect(await review()).toEqual({ unavailable: "the reviewer could not start: slot limit" });
		spawn.fail = undefined;
		spawn.reply = { details: { structured: { version: 1, schemaHash: "h", status: "invalid" } } };
		// Contract change: an answer off the schema is retried once before the review is owed.
		expect(await review()).toMatchObject({ unavailable: expect.stringContaining("no valid verdict twice") });
		spawn.reply = valid({ verdict: "Maybe", summary: "x", findings: [] });
		expect(await review()).toMatchObject({ unavailable: expect.stringContaining("no valid verdict") });
	});

	it("keeps the rejection explanation and location in the owed note, bounded", async () => {
		spawn.reply = {
			details: { structured: { version: 1, schemaHash: "h", status: "invalid", error: { code: "schema", path: "$.findings" } } },
		};
		const result = await review();
		const reason = "unavailable" in result ? result.unavailable : "";
		expect(reason).toContain("schema");
		expect(reason).toContain("$.findings");
		expect(reason).toContain("did not match");
		spawn.reply = {
			details: { structured: { version: 1, schemaHash: "h", status: "invalid", error: { code: "schema", path: `$.${"x".repeat(2000)}` } } },
		};
		const long = await review();
		expect("unavailable" in long && long.unavailable.length).toBeLessThan(500);
	});
});

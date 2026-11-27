import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeSharedAgentDb } from "../../../db/src/api.ts";
import { workspaceDb } from "../../src/storage/workspace-database.ts";
import { registerBacklog } from "../../src/octocode/backlog/index.ts";
import type { QaRequest, QaReview, QaReviewer } from "../../src/octocode/backlog/qa-gate.ts";
import { BacklogStore } from "../../src/octocode/backlog/store.ts";
import { Subcommands } from "../../src/octocode/shared/commands.ts";
import { admitResultSchema, validateResultAnswer } from "../../src/octocode/subagents/result-schema.ts";
import { QA_RESULT_SCHEMA } from "../../src/octocode/subagents/qa-review.ts";
import { backlogToolName } from "./backlog-fixture.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";

const spawn = vi.hoisted(() => ({
	calls: [] as unknown[][],
	impl: undefined as undefined | ((...a: unknown[]) => unknown),
}));
vi.mock("../../src/octocode/subagents/spawn.ts", () => ({
	spawnAgent: (...args: unknown[]) => {
		spawn.calls.push(args);
		return spawn.impl?.(...args);
	},
}));
vi.mock("../../src/octocode/subagents/small-call.ts", () => ({ smallModelLabel: () => "anthropic/haiku" }));

let tmp: string;
let saved: string | undefined;
beforeEach(() => {
	tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "octo-qa-flow-")));
	saved = process.env.OCTOCODE_AGENT_DB;
	process.env.OCTOCODE_AGENT_DB = path.join(tmp, "home", "octocode.db");
});
afterEach(() => {
	closeSharedAgentDb();
	if (saved === undefined) delete process.env.OCTOCODE_AGENT_DB;
	else process.env.OCTOCODE_AGENT_DB = saved;
	fs.rmSync(tmp, { recursive: true, force: true });
});

const contract = admitResultSchema(QA_RESULT_SCHEMA);
const BLOCK = `Structured result:\n\`\`\`json\n{"verdict":"Changes required","summary":"Window is process-wide.","findings":["request-rate.ts:64 — singleton"],"context":["other edits"]}\n\`\`\``;
const B213_TRAILER = `Noticed: the holder's "each session has its own window" claim is false for in-process sessions.
For coordinator: fix scoping, then rerun the three focused suites.
Ask user: none.`;

describe("the QA verdict with the profile's report trailer", () => {
	it("is valid after the closing fence when only Noticed, For coordinator and Ask user sections follow, kept as notes", () => {
		const result = validateResultAnswer(`**Findings**\n\n1. one\n\n${BLOCK}\n\n${B213_TRAILER}`, contract);
		expect(result.status).toBe("valid");
		expect(result.notes).toContain("For coordinator: fix scoping");
		expect(result.notes).toContain("Ask user: none.");
	});

	it("keeps a section's bullet lines", () => {
		const result = validateResultAnswer(`${BLOCK}\n\nNoticed:\n- a\n- b\n\n- c\nAsk user: none`, contract);
		expect(result.status).toBe("valid");
	});

	it("keeps the verdict and carries stray prose after the block as notes, before or among the sections", () => {
		expect(validateResultAnswer(`${BLOCK}\n\nLooks good to me overall.`, contract)).toMatchObject({
			status: "valid",
			notes: "Looks good to me overall.",
		});
		expect(validateResultAnswer(`${BLOCK}\n\nNoticed: x\n\nAnd one more thing.`, contract)).toMatchObject({
			status: "valid",
			notes: "Noticed: x\n\nAnd one more thing.",
		});
	});

	it("has no notes without a trailer", () => {
		const result = validateResultAnswer(BLOCK, contract);
		expect(result.status).toBe("valid");
		expect(result.notes).toBeUndefined();
	});
});

describe("the QA reviewer's retry, skip reason and time limit", () => {
	const request = { ref: "B1", title: "t", goal: "g", summary: "s", verification: "v", files: [] as string[] };
	const framing = { details: { structured: { status: "invalid", error: { code: "framing" } } }, usage: { cost: 0 } };

	it("tells the retry why the first answer was rejected and names the code in the skip", async () => {
		const { qaReviewer } = await import("../../src/octocode/subagents/qa-review.ts");
		spawn.calls = [];
		spawn.impl = () => framing;
		const review = await qaReviewer({} as never)(request, fakeCtx({ cwd: "/tmp" }));
		expect(spawn.calls).toHaveLength(2);
		expect((spawn.calls[0][2] as { task: string }).task).not.toContain("was rejected");
		expect((spawn.calls[1][2] as { task: string }).task).toMatch(/last answer was rejected: framing/);
		expect(review).toEqual({
			unavailable: expect.stringMatching(/^the reviewer gave no valid verdict twice \(framing: .*"Structured result:"/),
		});
	});

	it("stops the child at the limit, is unavailable as timed out and does not retry", async () => {
		const { qaReviewer } = await import("../../src/octocode/subagents/qa-review.ts");
		spawn.calls = [];
		let child: AbortSignal | undefined;
		spawn.impl = (...args) =>
			new Promise((_resolve, reject) => {
				child = args[3] as AbortSignal;
				child.addEventListener("abort", () => reject(new Error("stopped")));
			});
		const review = await qaReviewer({} as never, { timeoutMs: 30 })(request, fakeCtx({ cwd: "/tmp" }));
		expect(review).toHaveProperty("unavailable", expect.stringContaining("timed out"));
		expect(spawn.calls).toHaveLength(1);
		expect(child?.aborted).toBe(true);
	});
});

const READY = { goal: "Result can be checked", why: "Users need it" };
const DONE = (n: number) => ({ summary: `did ${n}`, verification: "passed: ran the check", files: [`src/a${n}.ts`] });

function setup(reviewer: QaReviewer) {
	const fake = fakeHost({ backlog: { qa: "all" } });
	registerBacklog(fake.api, { commands: new Subcommands(), isSubagent: false, review: reviewer });
	const cwd = path.join(tmp, "repo");
	fs.mkdirSync(cwd, { recursive: true });
	const ctx = fakeCtx({ cwd, idle: false });
	const updates: string[] = [];
	const call = async (params: Record<string, unknown>) =>
		(
			(await fake.tools
				.get(backlogToolName(params.op))
				.execute(
					"id",
					{ reason: "test", ...params },
					undefined,
					(update: { content: Array<{ text: string }> }) => updates.push(update.content[0].text),
					ctx,
				)) as { content: Array<{ text: string }> }
		).content[0].text;
	const store = () => new BacklogStore(() => workspaceDb(cwd).agent, workspaceDb(cwd).workspace.id);
	const open = async (count: number) => {
		for (let n = 1; n <= count; n++)
			await call({ op: "add", items: [{ title: `Work ${n}`, ...READY, state: "todo", priority: "p1" }] });
		for (let n = 1; n <= count; n++) await call({ op: "claim", id: `B${n}` });
	};
	return { call, store, open, updates };
}

const ready: QaReview = {
	verdict: { verdict: "Ready", summary: "fine", findings: [] },
	model: "m",
	cost: 0,
};

describe("done through the backlog tool", () => {
	it("reports the summary, the verification and the QA outcome", async () => {
		const t = setup(async () => ready);
		await t.open(1);
		const text = await t.call({ op: "done", id: "B1", completion: DONE(1) });
		expect(text).toContain("Summary: did 1");
		expect(text).toContain("Verification: passed: ran the check");
		expect(text).toContain("QA Ready");
	});

	it("runs a batch's reviews in parallel, at most 3 at once, and reports progress per entry; writes keep their order", async () => {
		let running = 0;
		let peak = 0;
		const order: string[] = [];
		const gate = Promise.withResolvers<void>();
		const t = setup(async (request: QaRequest) => {
			running++;
			peak = Math.max(peak, running);
			await gate.promise;
			running--;
			order.push(request.ref);
			return ready;
		});
		await t.open(5);
		const pending = t.call({
			op: "done",
			items: [1, 2, 3, 4, 5].map((n) => ({ id: `B${n}`, completion: DONE(n) })),
		});
		// Three reviews are held open together: they run in parallel, and a fourth does not start.
		await vi.waitFor(() => expect(running).toBe(3));
		gate.resolve();
		const text = await pending;
		expect(peak).toBe(3);
		expect(text.split("\n")[0]).toBe("Done 5 of 5.");
		expect([...text.matchAll(/^Updated B(\d) /gm)].map((m) => m[1])).toEqual(["1", "2", "3", "4", "5"]);
		expect(t.updates).toEqual([1, 2, 3, 4, 5].map((n) => `reviewing B${n} (${n} of 5)…`));
		expect(t.store().get("B5")?.state).toBe("done");
	});

	it("refuses one entry without aborting the others, and a send-back names the item's new version", async () => {
		const t = setup(async (request: QaRequest) =>
			request.ref === "B2"
				? { verdict: { verdict: "Changes required", summary: "no", findings: ["a.ts:1 bug"] }, model: "m", cost: 0 }
				: ready,
		);
		await t.open(3);
		const text = await t.call({ op: "done", items: [1, 2, 3].map((n) => ({ id: `B${n}`, completion: DONE(n) })) });
		expect(text).toContain("Done 2 of 3; 1 refused.");
		const version = t.store().get("B2")!.version;
		expect(text).toContain(`B2: refused - B2 was not completed`);
		expect(text).toContain(`now at version ${version}`);
		expect(t.store().get("B3")?.state).toBe("done");
	});

	it("writes with the version current after the review, so a version the review itself moved is not stale", async () => {
		const later: { call?: ReturnType<typeof setup>["call"] } = {};
		const t = setup(async () => {
			await later.call?.({ op: "note", id: "B1", note: "someone else" });
			return ready;
		});
		later.call = t.call;
		await t.open(1);
		const version = t.store().get("B1")!.version;
		const text = await t.call({ op: "done", id: "B1", completion: DONE(1), version });
		expect(text).toContain("QA Ready");
		expect(t.store().get("B1")?.state).toBe("done");
	});
});

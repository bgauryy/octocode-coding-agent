import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeSharedAgentDb } from "../../../db/src/api.ts";
import { sharedAgentDb } from "../../src/storage/database.ts";
import { registeredWorkspace } from "../../src/storage/workspace-database.ts";
import { registerBacklog } from "../../src/octocode/backlog/index.ts";
import {
	qaRequired,
	type QaMode,
	type QaRequest,
	type QaReview,
	type QaReviewer,
	type QaVerdictWord,
} from "../../src/octocode/backlog/qa-gate.ts";
import { BacklogStore } from "../../src/octocode/backlog/store.ts";
import { Subcommands } from "../../src/octocode/shared/commands.ts";
import { backlogToolName } from "./backlog-fixture.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";

let tmp: string;
let saved: string | undefined;
beforeEach(() => {
	tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "octo-qa-gate-")));
	saved = process.env.OCTOCODE_AGENT_DB;
	process.env.OCTOCODE_AGENT_DB = path.join(tmp, "home", "octocode.db");
});
afterEach(() => {
	closeSharedAgentDb();
	if (saved === undefined) delete process.env.OCTOCODE_AGENT_DB;
	else process.env.OCTOCODE_AGENT_DB = saved;
	fs.rmSync(tmp, { recursive: true, force: true });
});

const READY = { goal: "Result can be checked", why: "Users need it" };
const DONE = { summary: "did it", verification: "passed: ran the check", files: ["src/a.ts"] };

const verdict = (word: QaVerdictWord, findings: string[] = []): QaReview => ({
	verdict: { verdict: word, summary: `${word}: reviewed`, findings },
	model: "anthropic/claude-haiku",
	cost: 0.0123,
});

/** A registered backlog tool whose QA reviewer is a scripted port: the model and the child are external boundaries. */
function setup(options: { qa?: QaMode; reviewer?: QaReviewer | undefined } = {}) {
	const requests: QaRequest[] = [];
	let reply: QaReview | { skipped: string } = verdict("Ready");
	const review: QaReviewer = async (request) => {
		requests.push(request);
		return reply;
	};
	const fake = fakeHost(options.qa ? { backlog: { qa: options.qa } } : {});
	const reviewer = "reviewer" in options ? options.reviewer : review;
	registerBacklog(fake.api, {
		commands: new Subcommands(),
		isSubagent: false,
		...(reviewer ? { review: reviewer } : {}),
	});
	const cwd = path.join(tmp, "repo");
	fs.mkdirSync(cwd, { recursive: true });
	const ctx = fakeCtx({ cwd, idle: false });
	const call = async (params: Record<string, unknown>) =>
		(
			(await fake.tools
				.get(backlogToolName(params.op))
				.execute("id", { reason: "test", ...params }, undefined, undefined, ctx)) as {
				content: Array<{ text: string }>;
			}
		).content[0].text;
	const store = () => new BacklogStore(() => sharedAgentDb(), registeredWorkspace(cwd).id);
	const open = async (item: Record<string, unknown> = {}) => {
		await call({
			op: "add",
			items: [{ title: "Work", ...READY, state: "todo", priority: "p1", type: "feature", ...item }],
		});
		await call({ op: "claim", id: "B1" });
	};
	return { call, store, open, requests, answer: (next: QaReview | { skipped: string }) => (reply = next) };
}

const notes = (store: BacklogStore) =>
	store
		.notes(store.get("B1")!, -1)
		.map((note) => note.text)
		.join("\n");

describe("which items the QA gate covers", () => {
	const item = (type: string, priority: number) => ({ type, priority }) as never;
	it.each([
		["important", "feature", 0, true],
		["important", "bug", 1, true],
		["important", "bug", 2, false],
		["important", "feature", 3, false],
		["important", "research", 0, false],
		["important", "epic", 0, false],
		["all", "feature", 3, true],
		["all", "research", 2, true],
		["all", "epic", 0, false],
		["off", "bug", 0, false],
	] as const)("%s: %s p%i -> %s", (mode, type, priority, expected) => {
		expect(qaRequired(item(type, priority), mode)).toBe(expected);
	});
});

describe("done on an important item", () => {
	it("is reviewed first: the reviewer gets the goal, summary, verification and files; a pass completes it with the verdict recorded", async () => {
		const t = setup();
		await t.open();
		const text = await t.call({ op: "done", id: "B1", completion: DONE });
		expect(t.requests).toHaveLength(1);
		expect(t.requests[0]).toMatchObject({
			ref: "B1",
			goal: READY.goal,
			summary: DONE.summary,
			verification: "passed: ran the check (status: passed)",
			files: DONE.files,
		});
		expect(t.store().get("B1")?.state).toBe("done");
		expect(notes(t.store())).toMatch(/QA Ready \(anthropic\/claude-haiku, \$0\.0123\)/);
		expect(text).toMatch(/QA Ready/);
	});

	it("returns to ongoing on Changes required: findings noted, nothing completed, the holder told", async () => {
		const t = setup();
		await t.open();
		t.answer(verdict("Changes required", ["src/a.ts:4 drops the error"]));
		await expect(t.call({ op: "done", id: "B1", completion: DONE })).rejects.toThrow(
			/B1 was not completed: QA found changes required.*src\/a\.ts:4 drops the error/s,
		);
		const item = t.store().get("B1")!;
		expect(item.state).toBe("ongoing");
		expect(item.assignee).toBeDefined();
		expect(item.completions).toHaveLength(0);
		expect(notes(t.store())).toMatch(/QA Changes required.*src\/a\.ts:4 drops the error/s);
	});

	it("returns to the backlog on Verification incomplete: claim released, findings noted", async () => {
		const t = setup();
		await t.open();
		t.answer(verdict("Verification incomplete", ["no test exercises the failure path"]));
		await expect(t.call({ op: "done", id: "B1", completion: DONE })).rejects.toThrow(
			/B1 was not completed: QA could not verify it.*no test exercises the failure path/s,
		);
		const item = t.store().get("B1")!;
		expect(item.state).toBe("backlog");
		expect(item.assignee).toBeUndefined();
		expect(notes(t.store())).toMatch(/QA Verification incomplete.*no test exercises the failure path/s);
	});

	it("passes again after a fix: the second done is reviewed anew", async () => {
		const t = setup();
		await t.open();
		t.answer(verdict("Changes required", ["bug"]));
		await expect(t.call({ op: "done", id: "B1", completion: DONE })).rejects.toThrow();
		t.answer(verdict("Ready"));
		await t.call({ op: "done", id: "B1", completion: DONE });
		expect(t.requests).toHaveLength(2);
		expect(t.store().get("B1")?.state).toBe("done");
	});

	it("is refused by the store's own checks before a review is paid for: a stale version, an open step", async () => {
		const t = setup();
		await t.open();
		const stale = t.store().get("B1")!.version;
		await t.call({ op: "note", id: "B1", note: "progress" });
		await expect(t.call({ op: "done", id: "B1", completion: DONE, version: stale })).rejects.toThrow(
			/changed elsewhere/,
		);
		t.store().tasks.add({ item: "B1", goal: "a step" }, { id: "user", kind: "human" });
		await expect(t.call({ op: "done", id: "B1", completion: DONE })).rejects.toThrow(/open tasks/);
		expect(t.requests).toHaveLength(0);
		const item = t.store().get("B1")!;
		expect(item.state).toBe("ongoing");
		expect(item.completions).toHaveLength(0);
	});

	it("completes with a note when no reviewer could run (no priced small model, a refused start)", async () => {
		const t = setup();
		await t.open();
		t.answer({ skipped: "no priced small model is connected" });
		await t.call({ op: "done", id: "B1", completion: DONE });
		expect(t.store().get("B1")?.state).toBe("done");
		expect(notes(t.store())).toMatch(/QA skipped: UNVERIFIED.*no priced small model is connected/);
	});

	it("reviews a p2 item whose summary says the goal is unmet", async () => {
		const t = setup();
		await t.open({ priority: "p2" });
		t.answer(verdict("Changes required", ["goal not met"]));
		await expect(
			t.call({ op: "done", id: "B1", completion: { ...DONE, summary: "goal not met: ps still spawns twice" } }),
		).rejects.toThrow(/not completed/);
		expect(t.requests).toHaveLength(1);
		expect(t.store().get("B1")?.state).toBe("ongoing");
	});

	it("completes as before when the session has no reviewer at all (a child session)", async () => {
		const t = setup({ reviewer: undefined });
		await t.open();
		await t.call({ op: "done", id: "B1", completion: DONE });
		expect(t.store().get("B1")?.state).toBe("done");
		expect(notes(t.store())).not.toMatch(/QA/);
	});
});

describe("done on items the gate does not cover", () => {
	it.each([
		["a p2 feature", { priority: "p2" }],
		["a p3 bug", { priority: "p3", type: "bug" }],
		["a p0 research item", { priority: "p0", type: "research" }],
	])("completes %s at once, with no review", async (_name, item) => {
		const t = setup();
		await t.open(item);
		await t.call({ op: "done", id: "B1", completion: DONE });
		expect(t.requests).toHaveLength(0);
		expect(t.store().get("B1")?.state).toBe("done");
	});

	it("never reviews a close", async () => {
		const t = setup();
		await t.open();
		await t.call({ op: "close", id: "B1", close: { kind: "obsolete", text: "gone" } });
		expect(t.requests).toHaveLength(0);
	});
});

describe("the backlog.qa setting", () => {
	it("off: an important item completes without a review", async () => {
		const t = setup({ qa: "off" });
		await t.open();
		await t.call({ op: "done", id: "B1", completion: DONE });
		expect(t.requests).toHaveLength(0);
		expect(t.store().get("B1")?.state).toBe("done");
	});

	it("all: a small item is reviewed too", async () => {
		const t = setup({ qa: "all" });
		await t.open({ priority: "p3" });
		await t.call({ op: "done", id: "B1", completion: DONE });
		expect(t.requests).toHaveLength(1);
		expect(t.store().get("B1")?.state).toBe("done");
	});

	it("important is the default", async () => {
		const t = setup();
		await t.open({ priority: "p3" });
		await t.call({ op: "done", id: "B1", completion: DONE });
		expect(t.requests).toHaveLength(0);
	});
});

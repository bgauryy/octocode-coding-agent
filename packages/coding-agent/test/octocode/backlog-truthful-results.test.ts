import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeSharedAgentDb } from "../../../db/src/api.ts";
import { openBacklog } from "../../src/octocode/backlog/context.ts";
import { registerBacklog } from "../../src/octocode/backlog/index.ts";
import { Subcommands } from "../../src/octocode/shared/commands.ts";
import { BACKLOG_ITEM_ENV, PARENT_SESSION_ENV } from "../../../common/src/env.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { backlogToolName } from "./backlog-fixture.ts";

/** The backlog and steps tools say what they did: nothing a caller sent is dropped without a word. */

const READY = { goal: "Expected result", why: "Required work" };
const completion = (operationKey: string) => ({
	summary: "Implemented",
	files: [],
	verification: { status: "passed", summary: "Focused check passed" },
	operationKey,
});

let tmp: string;
let savedDb: string | undefined;

beforeEach(() => {
	tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "octo-backlog-truth-")));
	savedDb = process.env.OCTOCODE_AGENT_DB;
	process.env.OCTOCODE_AGENT_DB = path.join(tmp, "home", "octocode.db");
});

afterEach(() => {
	closeSharedAgentDb();
	if (savedDb === undefined) delete process.env.OCTOCODE_AGENT_DB;
	else process.env.OCTOCODE_AGENT_DB = savedDb;
	fs.rmSync(tmp, { recursive: true, force: true });
});

function setup(options: { isSubagent?: boolean; parentSession?: string } = {}) {
	const fake = fakeHost();
	// The tests may run inside an Octocode subagent: only the options name a parent.
	const env = { ...process.env };
	delete env[PARENT_SESSION_ENV];
	delete env[BACKLOG_ITEM_ENV];
	if (options.parentSession) env[PARENT_SESSION_ENV] = options.parentSession;
	registerBacklog(fake.api, { commands: new Subcommands(), isSubagent: options.isSubagent ?? false, env });
	const cwd = path.join(tmp, "repo");
	fs.mkdirSync(cwd, { recursive: true });
	const ctx = fakeCtx({ cwd });
	const call = async (named: string, params: Record<string, unknown>) =>
		(
			(await fake.tools
				.get(named === "backlog" ? backlogToolName(params.op) : named)
				.execute("id", params, undefined, undefined, ctx)) as {
				content: Array<{ text: string }>;
			}
		).content[0].text;
	return { call, backlog: () => openBacklog(ctx, { isSubagent: options.isSubagent ?? false, env }) };
}

describe("backlog add by a subagent", () => {
	it("refuses a completion instead of storing a proposal without it", async () => {
		const child = setup({ isSubagent: true, parentSession: "parent" });
		const finished = { title: "Finished follow-up", ...READY, state: "done" as const };
		// The store's rule, which every caller of `store.add` meets.
		const { store, actor } = child.backlog();
		expect(() =>
			store.add(
				{ ...finished, completion: completion("child-done-1") as never, createdBy: `agent:${actor.id}` },
				actor,
			),
		).toThrow(/A subagent proposal lands in backlog and cannot carry a completion/);
		// The tool takes no completion on add at all, and says where one goes.
		await expect(
			child.call("backlog", {
				op: "add",
				items: [{ ...finished, state: undefined, completion: completion("child-done-1") }],
			}),
		).rejects.toThrow("backlogPlan does not take completion: use backlog with op done.");
		await expect(child.call("backlog", { op: "add", items: [{ ...finished }] })).rejects.toThrow(
			"backlogPlan does not finish an item: use backlog with op done and its completion.",
		);
		// Nothing was written: the refusal comes before the item is created.
		const parent = setup();
		expect(await parent.call("backlog", { op: "list", states: ["backlog", "todo", "ongoing", "done"] })).toMatch(
			/^No backlog\/todo\/ongoing\/done items/,
		);
		// A proposal without a completion still lands in backlog, whatever state it asked for.
		expect(store.add({ ...finished, title: "Stored", createdBy: `agent:${actor.id}` }, actor).state).toBe("backlog");
		expect(
			await child.call("backlog", { op: "add", items: [{ title: "Follow-up", ...READY, state: "todo" }] }),
		).toMatch(/^Added B2 \[backlog p2\] Follow-up/);
	});
});

describe("backlog completion replay", () => {
	it("reports an operationKey already applied, and that the item was reopened since", async () => {
		const t = setup();
		await t.call("backlog", { op: "add", items: [{ title: "Ship it", ...READY, state: "ongoing" }] });
		const done = { op: "done", id: "B1", completion: completion("ship-1") };
		expect(await t.call("backlog", done)).toMatch(/^Updated B1 \[done p2\]/);
		// A replay while the item is still done says so and writes nothing.
		const again = await t.call("backlog", done);
		expect(again).toMatch(/^Completion ship-1 of B1 was already recorded \(.+\); nothing was written\./);
		expect(again).not.toMatch(/since/);
		await t.call("backlog", { op: "claim", id: "B1", note: "Regression found" });
		const replay = await t.call("backlog", done);
		expect(replay).toMatch(/^Completion ship-1 of B1 was already recorded \(.+\); nothing was written\./);
		expect(replay).toContain("B1 has changed since: it is now ongoing. Close it with a new operationKey.");
		expect(replay).toMatch(/\nB1 \[ongoing p2\] Ship it/);
	});
});

describe("backlog completion without an operationKey", () => {
	const keyless = {
		summary: "Implemented",
		files: [],
		verification: { status: "passed", summary: "Focused check passed" },
	};

	it("derives a key so a retry of the same completion writes nothing", async () => {
		const t = setup();
		await t.call("backlog", { op: "add", items: [{ title: "Ship it", ...READY, state: "ongoing" }] });
		const done = { op: "done", id: "B1", completion: keyless };
		expect(await t.call("backlog", done)).toMatch(/^Updated B1 \[done p2\]/);
		// Same content, keys written in another order: still the same completion.
		const reordered = {
			...done,
			completion: { verification: keyless.verification, files: [], summary: keyless.summary },
		};
		expect(await t.call("backlog", reordered)).toMatch(/was already recorded \(.+\); nothing was written\./);
	});

	it("lets an explicit key win and treats different content as a new completion", async () => {
		const t = setup();
		await t.call("backlog", { op: "add", items: [{ title: "Ship it", ...READY, state: "ongoing" }] });
		const explicit = { op: "done", id: "B1", completion: completion("mine-1") };
		await t.call("backlog", explicit);
		expect(await t.call("backlog", explicit)).toMatch(/^Completion mine-1 of B1 was already recorded/);
		const fixed = { ...explicit, completion: { ...keyless, summary: "Implemented, then corrected" } };
		expect(await t.call("backlog", fixed)).toMatch(/^Updated B1 \[done p2\]/);
	});
});

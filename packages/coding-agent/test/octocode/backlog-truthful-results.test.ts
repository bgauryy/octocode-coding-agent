import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeSharedAgentDb } from "../../../db/src/api.ts";
import { registerBacklog } from "../../src/octocode/backlog/index.ts";
import { Subcommands } from "../../src/octocode/shared/commands.ts";
import { BACKLOG_ITEM_ENV, PARENT_SESSION_ENV } from "../../../common/src/env.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";

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
	const call = async (tool: string, params: Record<string, unknown>) =>
		(
			(await fake.tools.get(tool).execute("id", params, undefined, undefined, ctx)) as {
				content: Array<{ text: string }>;
			}
		).content[0].text;
	return { call };
}

describe("backlog add by a subagent", () => {
	it("refuses a completion instead of storing a proposal without it", async () => {
		const child = setup({ isSubagent: true, parentSession: "parent" });
		await expect(
			child.call("backlog", {
				op: "add",
				title: "Finished follow-up",
				...READY,
				state: "done",
				completion: completion("child-done-1"),
			}),
		).rejects.toThrow(/A subagent proposal lands in backlog and cannot carry a completion/);
		// Nothing was written: the refusal comes before the item is created.
		const parent = setup();
		expect(await parent.call("backlog", { op: "list", states: ["backlog", "todo", "ongoing", "done"] })).toMatch(
			/^No backlog\/todo\/ongoing\/done items/,
		);
		// A proposal without a completion still lands in backlog, as before.
		expect(await child.call("backlog", { op: "add", title: "Follow-up", ...READY, state: "done" })).toMatch(
			/^Added B1 \[backlog p2\] Follow-up/,
		);
	});
});

describe("backlog completion replay", () => {
	it("reports an operationKey already applied, and that the item was reopened since", async () => {
		const t = setup();
		await t.call("backlog", { op: "add", title: "Ship it", ...READY, state: "ongoing" });
		const done = { op: "update", id: "B1", state: "done", completion: completion("ship-1") };
		expect(await t.call("backlog", done)).toMatch(/^Updated B1 \[done p2\]/);
		// A replay while the item is still done says so and writes nothing.
		const again = await t.call("backlog", done);
		expect(again).toMatch(/^Completion ship-1 of B1 was already recorded \(.+\); nothing was written\./);
		expect(again).not.toMatch(/since/);
		await t.call("backlog", { op: "update", id: "B1", state: "ongoing", note: "Regression found" });
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
		await t.call("backlog", { op: "add", title: "Ship it", ...READY, state: "ongoing" });
		const done = { op: "update", id: "B1", state: "done", completion: keyless };
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
		await t.call("backlog", { op: "add", title: "Ship it", ...READY, state: "ongoing" });
		const explicit = { op: "update", id: "B1", state: "done", completion: completion("mine-1") };
		await t.call("backlog", explicit);
		expect(await t.call("backlog", explicit)).toMatch(/^Completion mine-1 of B1 was already recorded/);
		const fixed = { ...explicit, completion: { ...keyless, summary: "Implemented, then corrected" } };
		expect(await t.call("backlog", fixed)).toMatch(/^Updated B1 \[done p2\]/);
	});
});

describe("steps list", () => {
	it("pages done steps like other lists, with a Next call", async () => {
		const t = setup();
		for (let i = 1; i <= 25; i++) {
			await t.call("steps", { op: "add", goal: `Step ${i}` });
			await t.call("steps", { op: "update", id: `T${i}`, state: "done", result: "ok" });
		}
		const first = (await t.call("steps", { op: "list", state: "done" })).split("\n");
		expect(first.filter((line) => line.startsWith("T"))).toHaveLength(20);
		expect(first.at(-1)).toBe(`Next: steps ${JSON.stringify({ op: "list", state: "done", limit: 20, offset: 20 })}`);
		const rest = (await t.call("steps", { op: "list", state: "done", limit: 20, offset: 20 })).split("\n");
		expect(rest).toHaveLength(5);
		expect(rest.every((line) => line.startsWith("T"))).toBe(true);
		expect(rest[0]).toMatch(/^T21 /);
	});
});

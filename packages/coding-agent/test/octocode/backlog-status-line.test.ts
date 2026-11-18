import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeSharedAgentDb } from "../../../db/src/api.ts";
import { sharedAgentDb } from "../../src/storage/database.ts";
import { registeredWorkspace } from "../../src/storage/workspace-database.ts";
import { BACKLOG_LINE_TYPE, lineText, statusLine } from "../../src/octocode/backlog/status-line.ts";
import { startBacklogFeed } from "../../src/octocode/backlog/peers.ts";
import { BacklogStore } from "../../src/octocode/backlog/store.ts";
import type { BacklogChange } from "../../src/octocode/shared/backlog-change.ts";
import { entryActivity } from "../../src/core/application/service/activity-data.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";

let tmp: string;
let saved: string | undefined;
beforeEach(() => {
	tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "octo-status-line-")));
	saved = process.env.OCTOCODE_AGENT_DB;
	process.env.OCTOCODE_AGENT_DB = path.join(tmp, "home", "octocode.db");
});
afterEach(() => {
	closeSharedAgentDb();
	if (saved === undefined) delete process.env.OCTOCODE_AGENT_DB;
	else process.env.OCTOCODE_AGENT_DB = saved;
	fs.rmSync(tmp, { recursive: true, force: true });
});

const change = (over: Partial<BacklogChange>): BacklogChange => ({
	id: 1,
	ref: "B7",
	kind: "edited",
	by: "peer",
	paths: [],
	beforePaths: [],
	title: "Fix the thing",
	...over,
});

describe("the line a state change gets", () => {
	it.each([
		[{ kind: "claimed" }, "Backlog B7 claimed · Fix the thing · peer"],
		[{ kind: "done" }, "Backlog B7 done · Fix the thing · peer"],
		[{ kind: "closed", surface: "web" }, "Backlog B7 closed · Fix the thing · web board"],
		[
			{ kind: "reopened", state: "todo", surface: "command" },
			"Backlog B7 reopened (now todo) · Fix the thing · /backlog",
		],
		[{ kind: "released", state: "todo" }, "Backlog B7 released (now todo) · Fix the thing · peer"],
		[{ kind: "edited", state: "backlog", beforeState: "todo" }, "Backlog B7 todo → backlog · Fix the thing · peer"],
	] as Array<[Partial<BacklogChange>, string]>)("%j", (over, line) => {
		expect(statusLine(change(over), false)).toBe(line);
	});

	it("omits the writer for this session's own writes and cuts a long title", () => {
		expect(statusLine(change({ kind: "done", title: "x".repeat(200) }), true)?.length).toBeLessThan(90);
		expect(statusLine(change({ kind: "done" }), true)).toBe("Backlog B7 done · Fix the thing");
	});

	it.each([["created"], ["note"], ["step"], ["paths_changed"], ["reassigned"], ["blocked"]])(
		"has no line for %s",
		(kind) => {
			expect(statusLine(change({ kind: kind as BacklogChange["kind"] }), false)).toBeUndefined();
		},
	);

	it("has no line for an edit that leaves the state alone", () => {
		expect(statusLine(change({ state: "todo", beforeState: "todo" }), false)).toBeUndefined();
	});

	it("reads back from an entry, and the web shows the line itself", () => {
		expect(lineText({ text: "Backlog B1 done" })).toBe("Backlog B1 done");
		expect(lineText({ text: " " })).toBeUndefined();
		expect(lineText(undefined)).toBeUndefined();
		const activity = entryActivity({
			type: "custom",
			customType: BACKLOG_LINE_TYPE,
			data: { text: "Backlog B1 done", ref: "B1", change: "done" },
		} as never);
		expect(activity).toMatchObject({ kind: "custom", text: "Backlog B1 done", data: { ref: "B1", change: "done" } });
	});
});

describe("the feed writes a line for each state change, and only a line", () => {
	it("appends one entry per claim, done, close, reopen and state edit, from any actor, with no message", () => {
		const fake = fakeHost();
		const cwd = path.join(tmp, "repo");
		fs.mkdirSync(cwd, { recursive: true });
		const ctx = fakeCtx({ cwd, idle: false });
		const pokes: Array<() => void> = [];
		const follower = { subscribe: (poke: () => void) => (pokes.push(poke), () => undefined) };
		const feed = startBacklogFeed(fake.api, ctx, { isSubagent: false }, follower as never);
		const store = new BacklogStore(() => sharedAgentDb(), registeredWorkspace(cwd).id);
		const web = { id: "user", surface: "web" as const };
		const mine = { id: "session-test", surface: "tool" as const };
		const add = (title: string) =>
			store.add({ title, goal: "checkable", why: "needed", state: "todo", createdBy: "user" });
		add("One");
		add("Two");
		store.update("B1", { state: "ongoing" }, mine);
		store.update("B1", { note: "half way" }, mine);
		store.update(
			"B1",
			{
				state: "done",
				completion: {
					summary: "ok",
					verification: { status: "passed", summary: "ran" },
					files: [],
					operationKey: "k1",
				} as never,
			},
			mine,
		);
		store.update("B1", { state: "todo", note: "reopened: more to do" }, web);
		store.update("B2", { state: "backlog" }, web);
		store.update("B2", { close: { kind: "obsolete", text: "gone" } }, web);
		pokes[0]();
		feed.stop();
		const lines = fake.entries
			.filter((entry) => entry.customType === BACKLOG_LINE_TYPE)
			.map((e) => (e.data as { text: string }).text);
		expect(lines).toEqual([
			"Backlog B1 claimed · One",
			"Backlog B1 done · One",
			"Backlog B1 reopened (now todo) · One · web board",
			"Backlog B2 todo → backlog · Two · web board",
			"Backlog B2 closed · Two · web board",
		]);
		expect(fake.entries).toHaveLength(lines.length);
		// Entries are not messages: nothing was sent to the model and no turn was asked for.
		expect(fake.sent).toEqual([]);
	});
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeSharedAgentDb } from "../../../db/src/api.ts";
import { openBacklog } from "../../src/octocode/backlog/context.ts";
import { itemLink } from "../../src/octocode/subagents/item-link.ts";
import { fakeCtx } from "./fake-host.ts";

let tmp: string;
let savedDb: string | undefined;
beforeEach(() => {
	tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "octo-item-claim-")));
	savedDb = process.env.OCTOCODE_AGENT_DB;
	process.env.OCTOCODE_AGENT_DB = path.join(tmp, "home", "octocode.db");
});
afterEach(() => {
	closeSharedAgentDb();
	if (savedDb === undefined) delete process.env.OCTOCODE_AGENT_DB;
	else process.env.OCTOCODE_AGENT_DB = savedDb;
	fs.rmSync(tmp, { recursive: true, force: true });
});

function session() {
	const cwd = path.join(tmp, "repo");
	fs.mkdirSync(cwd, { recursive: true });
	const ctx = fakeCtx({ cwd });
	ctx.sessionManager.getSessionId = () => "session-test";
	return { ctx, backlog: openBacklog(ctx, { isSubagent: false }) };
}

describe("agent task `item` for an item this session does not hold", () => {
	it("checks an unheld todo item first and claims it only when told to, saying so", () => {
		const { ctx, backlog } = session();
		backlog.store.add({ goal: "g", why: "w", title: "unheld", state: "todo", createdBy: "user" });
		const link = itemLink(ctx, "B1")!;
		expect(backlog.store.get("B1")).toMatchObject({ state: "todo" });
		link.claim();
		link.claim();
		const item = backlog.store.get("B1")!;
		expect(item).toMatchObject({ state: "ongoing", assignee: "session-test" });
		expect(link.attach(undefined, "w1")).toContain("Claimed B1 for this session");
		const notes = backlog.store.notes(item, -1).map((note) => note.text);
		expect(notes.some((text) => text.includes("delegating it to a subagent"))).toBe(true);
	});

	it("takes an item this session already holds as it is, without a claim line", () => {
		const { ctx, backlog } = session();
		backlog.store.add({ goal: "g", why: "w", title: "held", state: "todo", createdBy: "user" });
		backlog.store.update("B1", { state: "ongoing" }, { id: "session-test" });
		const link = itemLink(ctx, "B1")!;
		link.claim();
		expect(link.attach(undefined, "w1")).toBe("");
	});

	it("refuses at claim time an item another session took after the check", () => {
		const { ctx, backlog } = session();
		backlog.store.add({ goal: "g", why: "w", title: "raced", state: "todo", createdBy: "user" });
		const link = itemLink(ctx, "B1")!;
		backlog.store.update("B1", { state: "ongoing" }, { id: "other-session" });
		expect(() => link.claim()).toThrow("B1 is held by other-session, not by this session");
	});

	it("links a saved ref on the item, naming the patch file when the ref did not take the change cleanly", () => {
		const { ctx, backlog } = session();
		backlog.store.add({ goal: "g", why: "w", title: "held", state: "todo", createdBy: "user" });
		backlog.store.update("B1", { state: "ongoing" }, { id: "session-test" });
		const patch = "/repo/.octocode/tmp/isolate/w1.patch";
		const notes = () => backlog.store.notes(backlog.store.get("B1")!, -1).map((note) => note.text);
		expect(itemLink(ctx, "B1")!.attach(undefined, "w1", "refs/octocode/w1", patch)).toContain(
			"Linked refs/octocode/w1",
		);
		expect(notes().at(-1)).toContain(`its own change is the patch ${patch}`);
		itemLink(ctx, "B1")!.attach(undefined, "w2", "refs/octocode/w2");
		expect(notes().at(-1)).not.toContain("patch");
	});

	it("refuses an item without goal or why and names what to add", () => {
		const { ctx, backlog } = session();
		backlog.store.add({ title: "bare", state: "backlog", createdBy: "user" } as never);
		expect(() => itemLink(ctx, "B1")).toThrow(/B1 is backlog and needs a goal \(the done criterion\) and a why/);
		expect(backlog.store.get("B1")!.state).toBe("backlog");
	});

	it("still refuses an item another session holds", () => {
		const { ctx, backlog } = session();
		backlog.store.add({ goal: "g", why: "w", title: "theirs", state: "todo", createdBy: "user" });
		backlog.store.update("B1", { state: "ongoing" }, { id: "other-session" });
		expect(() => itemLink(ctx, "B1")).toThrow("B1 is held by other-session, not by this session");
		expect(backlog.store.get("B1")!.assignee).toBe("other-session");
	});

	it("still refuses a done item", () => {
		const { ctx, backlog } = session();
		backlog.store.add({ goal: "g", why: "w", title: "done", state: "todo", createdBy: "user" });
		backlog.store.update("B1", { state: "ongoing" }, { id: "session-test" });
		backlog.store.update(
			"B1",
			{
				state: "done",
				completion: { summary: "s", files: [], verification: { status: "passed", summary: "ok" }, operationKey: "k" },
			},
			{ id: "session-test" },
		);
		expect(() => itemLink(ctx, "B1")).toThrow("B1 is done, not held by this session");
	});

	it("refuses an epic", () => {
		const { ctx, backlog } = session();
		backlog.store.add({ goal: "g", why: "w", title: "epic", type: "epic", state: "todo", createdBy: "user" });
		expect(() => itemLink(ctx, "B1")).toThrow("B1 is an epic");
		expect(backlog.store.get("B1")!.state).toBe("todo");
	});
});

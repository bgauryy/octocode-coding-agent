import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { workspaceServerFixture } from "./workspace-server-fixture.ts";

let app: Awaited<ReturnType<typeof workspaceServerFixture>>;
beforeEach(async () => {
	app = await workspaceServerFixture();
});
afterEach(async () => {
	await app.close();
	vi.restoreAllMocks();
});

const send = (body: unknown) => app.request("/api/backlogs", body);
const human = { id: "user", kind: "human" as const };

function hierarchy() {
	const epic = app.store.add({ title: "Epic", type: "epic", createdBy: "user" });
	const a = app.store.add({ title: "Item A", goal: "g", why: "w", createdBy: "user" });
	const b = app.store.add({ title: "Item B", goal: "g", why: "w", createdBy: "user" });
	return { epic, a, b };
}

describe("hierarchy commands from the web page", () => {
	it("adds, updates, moves and reparents tasks as the human and reports the new copy", async () => {
		const { a, b } = hierarchy();
		const first = await send({ command: "task.add", goal: "Write test", item: a.ref });
		expect(first.status).toBe(200);
		const second = await send({ command: "task.add", goal: "Run test", reason: "proof", item: a.ref });
		const t1 = first.body.task as { ref: string; version: number };
		const t2 = second.body.task as { ref: string; version: number };
		expect(app.changed).toHaveBeenCalled();

		const moved = await send({ command: "task.move", task: t2.ref, version: t2.version, position: 0 });
		expect(moved.status).toBe(200);
		expect(app.store.tasks.list({ item: a.ref }).map((task) => task.ref)).toEqual([t2.ref, t1.ref]);

		const done = await send({
			command: "task.update",
			task: t1.ref,
			version: t1.version,
			state: "done",
			result: "passed",
		});
		expect(done.body.task).toMatchObject({ ref: t1.ref, state: "done", result: "passed" });

		const current = app.store.tasks.get(t1.ref)!;
		const handed = await send({ command: "task.reparent", task: t1.ref, version: current.version, item: b.ref });
		expect(handed.body.task).toMatchObject({ owner: { kind: "item", ref: b.ref } });
		expect(app.store.audit(b.ref).some((event) => event.actor.kind === "human")).toBe(true);
	});

	it("gives a task added with no owner to the hosting session and promotes it to an item", async () => {
		const { epic } = hierarchy();
		const added = await send({ command: "task.add", goal: "Look into flaky run" });
		const task = added.body.task as { ref: string; version: number; owner: unknown };
		expect(task.owner).toEqual({ kind: "session", id: app.session.sessionId });

		const promoted = await send({
			command: "task.promote",
			task: task.ref,
			version: task.version,
			title: "Flaky run",
			parentId: epic.ref,
		});
		expect(promoted.status).toBe(200);
		expect(promoted.body.item).toMatchObject({ title: "Flaky run", parentId: epic.ref, createdBy: "user" });
		expect(app.store.tasks.get(task.ref)?.owner).toMatchObject({ kind: "item" });
	});

	it("re-parents an item under an epic and back to the top level, and changes its state", async () => {
		const { epic, a } = hierarchy();
		const under = await send({ command: "item.reparent", id: a.ref, version: a.version, parentId: epic.ref });
		expect(under.body.item).toMatchObject({ parentId: epic.ref });
		const fresh = app.store.get(a.ref)!;
		const top = await send({ command: "item.reparent", id: a.ref, version: fresh.version, parentId: null });
		expect(top.body.item).toMatchObject({ ref: a.ref });
		expect(app.store.get(a.ref)?.parentId).toBeUndefined();
		const todo = await send({
			command: "item.state",
			id: a.ref,
			version: app.store.get(a.ref)!.version,
			state: "todo",
		});
		expect(todo.body.item).toMatchObject({ state: "todo" });
	});

	it("refuses with the store's one-line error: depth rules, owner rules and closing with open tasks", async () => {
		const { epic, a, b } = hierarchy();
		const deep = await send({ command: "item.reparent", id: a.ref, version: a.version, parentId: b.ref });
		expect(deep).toMatchObject({
			status: 409,
			body: { error: `${b.ref} is a feature, not an epic: items nest only under epics.` },
		});
		expect(app.store.get(a.ref)?.parentId).toBeUndefined();

		const underEpic = await send({ command: "task.add", goal: "x", item: epic.ref });
		expect(underEpic.status).toBe(409);
		expect(String(underEpic.body.error)).toContain("is an epic");
		expect(app.store.tasks.list()).toEqual([]);

		await send({ command: "task.add", goal: "Open step", item: a.ref });
		const closing = await send({ command: "item.state", id: a.ref, version: a.version, state: "done" });
		expect(closing.status).toBe(409);
		expect(app.store.get(a.ref)?.state).toBe("backlog");

		const both = await send({ command: "task.add", goal: "x", item: a.ref, session: "s" });
		expect(both).toMatchObject({ status: 409, body: { error: "A task belongs to an item or a session, not both." } });
		const neither = await send({ command: "task.reparent", task: "T1", version: 1 });
		expect(neither.body.error).toBe("Name one new owner: an item or a session.");
	});

	it("refuses a stale version and returns the current task so the page can reload", async () => {
		const { a } = hierarchy();
		const added = await send({ command: "task.add", goal: "Step", item: a.ref });
		const task = added.body.task as { ref: string; version: number };
		app.store.tasks.update(task.ref, { reason: "changed elsewhere" }, human);
		const stale = await send({ command: "task.update", task: task.ref, version: task.version, goal: "Mine" });
		expect(stale.status).toBe(409);
		expect(stale.body.error).toBe(`${task.ref} changed elsewhere \u2014 reload it.`);
		expect(stale.body.task).toMatchObject({ reason: "changed elsewhere" });
		expect(app.store.tasks.get(task.ref)?.goal).toBe("Step");
		const item = await send({ command: "item.state", id: a.ref, version: a.version + 5, state: "todo" });
		expect(item.status).toBe(409);
	});

	it("rejects a malformed command before touching the store", async () => {
		const { a } = hierarchy();
		for (const body of [
			{ command: "task.delete", task: "T1" },
			{ command: "task.update", task: "T1" },
			{ command: "task.move", task: "T1", version: 1, position: -1 },
			{ command: "item.state", id: a.ref, version: 1, state: "dropped" },
			{ command: "task.add", goal: "x", extra: true },
		])
			expect((await send(body)).status, JSON.stringify(body)).toBe(400);
		expect(app.store.tasks.list()).toEqual([]);
	});

	it("shows task changes in the next board snapshot", async () => {
		const { a } = hierarchy();
		await send({ command: "task.add", goal: "Visible step", item: a.ref });
		await send({ command: "task.add", goal: "Session step" });
		const board = (await app.request("/api/backlogs")).body as {
			items: { ref: string; tasks: { goal: string }[]; epicState?: string }[];
			sessionTasks: { goal: string }[];
		};
		expect(board.items.find((item) => item.ref === a.ref)?.tasks.map((task) => task.goal)).toEqual(["Visible step"]);
		expect(board.sessionTasks.map((task) => task.goal)).toEqual(["Session step"]);
	});

	it("refuses a hierarchy command from a foreign origin or without credentials, before the store is touched", async () => {
		const { a } = hierarchy();
		const command = { command: "task.add", goal: "Sneaky", item: a.ref };
		for (const headers of [{ host: "example.test" }, { origin: "https://example.test" }])
			expect((await app.request("/api/backlogs", command, { headers })).status).toBe(403);
		expect((await app.request("/api/backlogs", command, { headers: { authorization: "" } })).status).toBe(401);
		expect((await app.request("/api/backlogs", command, { headers: { authorization: "Bearer wrong" } })).status).toBe(
			401,
		);
		expect(app.store.tasks.list()).toEqual([]);
	});

	it("does not promote a task to an epic: the command schema leaves epic out", async () => {
		const task = (await send({ command: "task.add", goal: "Look into it" })).body.task as {
			ref: string;
			version: number;
		};
		const epic = await send({ command: "task.promote", task: task.ref, version: task.version, type: "epic" });
		expect(epic.status).toBe(400);
		const bug = await send({ command: "task.promote", task: task.ref, version: task.version, type: "bug" });
		expect(bug.body.item).toMatchObject({ type: "bug" });
	});

	it("refuses the removed item type `task` and unknown types in a backlog mutation", async () => {
		expect((await send({ op: "add", title: "Old page", goal: "g", why: "w", type: "task" })).status).toBe(400);
		expect((await send({ op: "add", title: "Bad", type: "story" })).status).toBe(400);
		expect((await send({ op: "add", title: "Page", goal: "g", why: "w", type: "feature" })).status).toBe(200);
		expect(app.store.list().items.map((item) => [item.title, item.type])).toEqual([["Page", "feature"]]);
	});
});

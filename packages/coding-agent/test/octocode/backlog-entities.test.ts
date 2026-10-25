import { WebSocket } from "ws";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openAgentDb, type AgentDb } from "../../src/octocode/agentdb/db.ts";
import { BacklogStore } from "../../src/octocode/backlog/store.ts";
import { startWorkspaceWeb } from "../../src/octocode/workspace/server.ts";
import { backlogSnapshot } from "../../src/octocode/backlog/snapshot.ts";
import type { BacklogWeb } from "../../src/octocode/backlog/context.ts";

let db: AgentDb;
let store: BacklogStore;
let dir: string;
let web: BacklogWeb | undefined;
const actor = { id: "session", kind: "agent" as const };
const result = (operationKey = "done") => ({
	summary: "Implemented and checked",
	files: [{ path: "src/a.ts", role: "changed" as const }],
	verification: { status: "passed" as const, summary: "Focused tests passed" },
	operationKey,
});
const add = (title: string, fields = {}) =>
	store.add({
		title,
		reason: "Users need this",
		goal: "Result can be checked",
		createdBy: "user",
		...fields,
	});
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "entities-"));
	db = openAgentDb(path.join(dir, "db"));
	store = new BacklogStore(() => db, "repo");
});
afterEach(async () => {
	await web?.close();
	web = undefined;
	db.close();
	fs.rmSync(dir, { recursive: true, force: true });
});

describe("backlog composition", () => {
	it("captures a title, then enforces context and completion at the store", () => {
		const item = store.add({ title: "Quick thought", createdBy: "user" });
		expect(item).toMatchObject({ type: "task", dependsOn: [], goal: "", reason: "" });
		expect(() => store.update(item.ref, { state: "ongoing" }, actor)).toThrow(/reason and goal/);
		store.update(item.ref, { state: "ongoing", reason: "Need it", goal: "Works" }, actor);
		expect(() => store.update(item.ref, { state: "done" }, actor)).toThrow(/completion/);
		expect(store.get(item.ref)?.state).toBe("ongoing");
	});
	it("separates epics, provenance and dependencies and rejects combined deadlocks atomically", () => {
		const epic = add("Epic", { type: "epic" });
		const api = add("API", { parentId: epic.ref });
		const ui = add("UI", { parentId: epic.ref, dependsOn: [api.ref, api.ref], from: api.ref });
		expect(ui).toMatchObject({
			parentId: epic.ref,
			from: api.seq,
			dependsOn: [{ resource: "backlogs", repositoryKey: "repo", id: api.ref }],
		});
		expect(() => store.update(api.ref, { dependsOn: [epic.ref] }, actor)).toThrow(/cycle/);
		expect(store.get(api.ref)?.dependsOn).toEqual([]);
		expect(() => store.update(ui.ref, { state: "ongoing" }, actor)).toThrow(/Blocked by/);
		expect(() => store.update(epic.ref, { state: "done", completion: result() }, actor)).toThrow(/child/);
		expect(() => store.remove(api.ref)).toThrow(/dependencies/);
		store.update(api.ref, { state: "done", completion: result() }, actor);
		expect(store.update(ui.ref, { state: "ongoing" }, actor).state).toBe("ongoing");
	});
	it("keeps completion history, checks policy, retries safely and flags reopened prerequisites", () => {
		const item = add("API");
		const dependent = add("UI", { dependsOn: [item.ref] });
		expect(() =>
			store.update(
				item.ref,
				{
					state: "done",
					completion: { ...result(), verification: { status: "not_run", summary: "No check" } },
				},
				actor,
			),
		).toThrow(/verify/);
		const input = { state: "done" as const, version: item.version, completion: result() };
		const done = store.update(item.ref, input, actor);
		expect(store.update(item.ref, input, actor)).toEqual(done);
		expect(() =>
			store.update(item.ref, { ...input, completion: { ...result(), summary: "Different" } }, actor),
		).toThrow(/different content/);
		store.update(dependent.ref, { state: "done", completion: result() }, actor);
		store.update(item.ref, { state: "todo", note: "Found a regression" }, actor);
		expect(store.get(item.ref)?.completions).toHaveLength(1);
		expect(backlogSnapshot(store, "repo", Date.now()).items.find((i) => i.ref === dependent.ref)?.needsReview).toBe(
			true,
		);
		expect(store.update(item.ref, { state: "done", completion: result("retry") }, actor).completions).toHaveLength(2);
	});
	it("rolls back failed creation and rejects stale versions, unsafe paths and conflicting aliases", () => {
		expect(() => add("bad", { dependsOn: ["B999"] })).toThrow(/Dependencies/);
		expect(store.list().total).toBe(0);
		const item = add("good");
		expect(item.ref).toBe("B1");
		store.update(item.ref, { title: "edited", version: item.version }, actor);
		expect(() => store.update(item.ref, { title: "stale", version: item.version }, actor)).toThrow(/reload/);
		expect(() => store.update(item.ref, { reason: "one", why: "two" }, actor)).toThrow(/agree/);
		expect(() =>
			store.update(
				item.ref,
				{ state: "done", completion: { ...result(), files: [{ path: "../secret", role: "changed" }] } },
				actor,
			),
		).toThrow(/relative/);
	});
	it("allows explicitly unverified human completion with no files", () => {
		const item = add("Decision");
		const done = store.update(
			item.ref,
			{
				state: "done",
				completion: {
					...result(),
					files: [],
					verification: { status: "not_run", summary: "Human decision" },
				},
			},
			{ id: "human-session", kind: "human" },
		);
		expect(done.completions[0]?.files).toEqual([]);
	});
	it("allows notes after a prerequisite reopens, while preventing another completion", () => {
		const prerequisite = add("Prerequisite");
		store.update(prerequisite.ref, { state: "done", completion: result() }, actor);
		const dependent = add("Dependent", { dependsOn: [prerequisite.ref] });
		store.update(dependent.ref, { state: "ongoing" }, actor);
		store.update(prerequisite.ref, { state: "todo", note: "Regression" }, actor);
		expect(
			store.update(
				dependent.ref,
				{ state: "ongoing", dependsOn: [prerequisite.ref], note: "Waiting on the fix" },
				actor,
			).state,
		).toBe("ongoing");
		expect(() => store.update(dependent.ref, { state: "done", completion: result() }, actor)).toThrow(/Blocked by/);
	});

	it("retains corrected results and searches their files and lessons", () => {
		const item = add("Work");
		const done = store.update(item.ref, { state: "done", completion: result() }, actor);
		const prior = done.completions[0];
		const correction = {
			...result("correction"),
			replaces: prior.id,
			summary: "Clarified result",
			lesson: "Check invalidation after resume",
		};
		const corrected = store.update(item.ref, { completion: correction }, actor);
		expect(corrected.completions).toHaveLength(2);
		expect(corrected.completions[0]).toEqual(prior);
		expect(store.list({ query: "invalidation" }).items.map((i) => i.ref)).toEqual([item.ref]);
		expect(store.list({ query: "src/a.ts" }).total).toBe(1);
	});
	it("checks open descendants beyond an already completed child", () => {
		const epic = add("Epic", { type: "epic" });
		const child = add("Child", { parentId: epic.ref });
		const grandchild = add("Grandchild", { parentId: child.ref });
		store.update(grandchild.ref, { state: "done", completion: result() }, actor);
		store.update(child.ref, { state: "done", completion: result() }, actor);
		store.update(grandchild.ref, { state: "todo", note: "New evidence" }, actor);
		expect(() => store.update(epic.ref, { state: "done", completion: result() }, actor)).toThrow(/child/);
		expect(backlogSnapshot(store, "repo", Date.now()).items.find((i) => i.ref === child.ref)?.needsReview).toBe(true);
	});
	it("enforces subagent authority in the domain and preserves parent claims", () => {
		const item = add("Assigned");
		store.update(item.ref, { state: "ongoing" }, actor);
		const child = { id: "child", owners: new Set([actor.id]) };
		expect(() => store.update(item.ref, { title: "Changed" }, child)).toThrow(/only state/);
		expect(() => store.update(item.ref, { state: "todo" }, child)).toThrow(/release/);
		expect(store.update(item.ref, { state: "done", completion: result() }, child).assignee).toBe(actor.id);
	});

	it("refuses writes from an older connection but leaves reads available", () => {
		const item = add("protected");
		const old = new DatabaseSync(db.file);
		try {
			expect(old.prepare("SELECT title FROM backlog").get()).toMatchObject({ title: "protected" });
			expect(() => old.prepare("UPDATE backlog SET state = 'done' WHERE id = ?").run(item.rowId)).toThrow(
				/octocode_(backlog_writer|audit_actor)/,
			);
			expect(() => old.prepare("DELETE FROM backlog WHERE id = ?").run(item.rowId)).toThrow(
				/octocode_(backlog_writer|audit_actor)/,
			);
		} finally {
			old.close();
		}
	});
});

describe("live local backlog", () => {
	it("pushes authenticated snapshots and changes from another database connection", async () => {
		web = await startWorkspaceWeb({ store, actor, session: actor.id, repoName: "repo", repoRoot: dir });
		const url = new URL(web.url);
		const address = url.origin.replace("http:", "ws:") + "/api/backlogs/live";
		const bad = new WebSocket(address, { origin: url.origin });
		await once(bad, "open");
		const denied = once(bad, "close");
		bad.send("wrong");
		expect((await denied)[0]).toBe(1008);
		const foreign = new WebSocket(address, { origin: "https://evil.example" });
		expect((await once(foreign, "error"))[0].message).toContain("403");
		const client = new WebSocket(address, { origin: url.origin });
		await once(client, "open");
		const initial = once(client, "message");
		client.send(url.hash.slice(8));
		expect(JSON.parse((await initial)[0].toString()).data.items).toEqual([]);
		const other = openAgentDb(db.file);
		try {
			const update = once(client, "message");
			new BacklogStore(() => other, "repo").add({ title: "From another session", createdBy: "user" });
			expect(JSON.parse((await update)[0].toString()).data.items[0].title).toBe("From another session");
		} finally {
			other.close();
			client.terminate();
		}
	});
	it("authenticates reads and writes, rejects other origins and preserves version conflicts", async () => {
		web = await startWorkspaceWeb({ store, actor, session: actor.id, repoName: "repo", repoRoot: dir });
		const url = new URL(web.url);
		const token = url.hash.slice(8);
		const api = url.origin + "/api/backlogs";
		expect((await fetch(api)).status).toBe(401);
		const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
		expect((await fetch(api, { headers: { ...headers, Origin: "https://evil.example" } })).status).toBe(403);
		const create = await fetch(api, {
			method: "POST",
			headers,
			body: JSON.stringify({ op: "add", title: "From browser", type: "epic" }),
		});
		expect(create.status).toBe(200);
		const { item } = (await create.json()) as { item: { ref: string; version: number } };
		const update = {
			op: "update",
			id: item.ref,
			version: item.version,
			reason: "Need a board",
			goal: "Users can manage work",
			state: "ongoing",
		};
		expect((await fetch(api, { method: "POST", headers, body: JSON.stringify(update) })).status).toBe(200);
		expect((await fetch(api, { method: "POST", headers, body: JSON.stringify(update) })).status).toBe(409);
		const snapshot = (await (await fetch(api, { headers })).json()) as { items: { state: string }[] };
		expect(snapshot.items[0]?.state).toBe("ongoing");
		const html = await (await fetch(url.origin)).text();
		expect(html).toContain('data-live="true"');
		expect(html).not.toContain(token);
		expect(html).not.toContain("From browser");
	});
});

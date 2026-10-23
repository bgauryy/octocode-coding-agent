import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openAgentDb, type AgentDb } from "../../src/octocode/agentdb/db.ts";
import { BacklogStore } from "../../src/octocode/backlog/store.ts";
import { WorkspaceRuntime } from "../../src/octocode/workspace/runtime.ts";
import { startWorkspaceWeb } from "../../src/octocode/workspace/server.ts";
import { presentAgentReport } from "../../src/octocode/subagents/presentation.ts";
import { fakeCtx, fakePi } from "./fake-pi.ts";

let dir: string;
let db: AgentDb;
let store: BacklogStore;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-"));
	db = openAgentDb(path.join(dir, "db"));
	store = new BacklogStore(() => db, "repo");
});
afterEach(() => {
	db.close();
	fs.rmSync(dir, { recursive: true, force: true });
});
const actor = { id: "parent", kind: "agent" as const };
const add = () => store.add({ title: "Build it", goal: "Checks pass", reason: "Users need it", createdBy: "user" });
function setup() {
	const fake = fakePi();
	const ctx = fakeCtx({ cwd: dir });
	const tell = vi.fn(async () => ({ sent: ["worker"], id: 1 }));
	const runtime = new WorkspaceRuntime(fake.pi, {
		database: () => db,
		members: () => [{ id: "worker", role: "general", status: "working" } as never],
		traffic: () => [],
		tell,
		stop: () => "Not owned by this session",
	});
	const backlog = { store, actor, session: ctx.sessionManager.getSessionId(), repoName: "repo" };
	return { ...fake, ctx, tell, runtime, backlog, connection: runtime.bind(ctx, backlog) };
}

describe("workspace data and commands", () => {
	it("records all item fields, relationships, comments and deletion with actor identity", () => {
		const item = add();
		store.update(
			item.ref,
			{
				body: "Context",
				type: "epic",
				links: [{ relation: "evidence", target: { resource: "external", url: "https://example.com" } }],
			},
			actor,
		);
		store.comment(item.ref, "A human comment", { id: "user", kind: "human" });
		expect(store.comments(item.ref)[0]).toMatchObject({ backlogId: item.ref, author: "user", text: "A human comment" });
		expect(store.comments(item.ref)[0].id).toBeGreaterThan(0);
		const events = store.audit(item.ref);
		expect(events.some((e) => e.entity === "backlog_links" && e.action === "insert")).toBe(true);
		expect(events.some((e) => e.entity === "backlog_comments" && e.actor.kind === "human")).toBe(true);
		expect(events.some((e) => e.entity === "backlog" && (e.after as { body?: string })?.body === "Context")).toBe(true);
		expect(() => db.db.prepare("DELETE FROM backlog_audits").run()).toThrow(/immutable/);
		store.remove(item.ref, undefined, actor);
		expect(
			store
				.audit(item.ref)
				.some(
					(e) =>
						e.entity === "backlog" && e.action === "delete" && (e.before as { title: string }).title === "Build it",
				),
		).toBe(true);
	});

	it("rolls back audit and claim together when dispatch fails", () => {
		const item = add();
		const before = store.audit(item.ref);
		expect(() =>
			store.dispatch(item.ref, item.version, actor, () => {
				throw new Error("Disconnected");
			}),
		).toThrow("Disconnected");
		expect(store.get(item.ref)?.state).toBe("backlog");
		expect(store.audit(item.ref)).toEqual(before);
	});

	it("preserves legacy notes as comment entities once", () => {
		const item = add();
		db.db.exec("DROP TRIGGER backlog_note_comment");
		db.db
			.prepare("INSERT INTO backlog_notes(item,at,author,kind,text) VALUES (?,123,'old-agent','note','Legacy note')")
			.run(item.rowId);
		expect(store.comments(item.ref)).toEqual([]);
		db.close();
		db = openAgentDb(path.join(dir, "db"));
		const migrated = store.comments(item.ref);
		expect(migrated).toHaveLength(1);
		expect(migrated[0]).toMatchObject({ backlogId: item.ref, author: "old-agent", at: 123, text: "Legacy note" });
		db.close();
		db = openAgentDb(path.join(dir, "db"));
		expect(store.comments(item.ref)).toEqual(migrated);
	});

	it("queues a delegation once, retains receipts across reconnects and refuses altered retries", async () => {
		const app = setup();
		const item = add();
		const command = { id: "request-1", action: "delegate" as const, backlogId: item.ref, version: item.version };
		expect((await app.connection.execute(command)).status).toBe("accepted");
		expect(store.get(item.ref)?.state).toBe("ongoing");
		expect(app.sent).toHaveLength(1);
		expect(app.sent[0].message).toContain("Delegate backlog item B1");
		app.connection.close();
		const reconnected = app.runtime.bind(app.ctx, app.backlog);
		expect((await reconnected.execute(command)).status).toBe("accepted");
		expect(app.sent).toHaveLength(1);
		await expect(reconnected.execute({ ...command, action: "work" })).rejects.toThrow(/different input/);
		expect(store.audit(item.ref).some((event) => event.entity === "workspace_commands")).toBe(true);
		reconnected.close();
	});

	it("rejects stale work before delivery and isolates closed views", async () => {
		const app = setup();
		const item = add();
		store.update(item.ref, { title: "Changed" }, actor);
		expect(
			(await app.connection.execute({ id: "stale", action: "work", backlogId: item.ref, version: item.version }))
				.status,
		).toBe("failed");
		expect(app.sent).toHaveLength(0);
		app.connection.close();
		await expect(
			app.connection.execute({ id: "late", action: "message", to: "worker", text: "Hello" }),
		).rejects.toThrow(/session changed/);
		expect(app.tell).not.toHaveBeenCalled();
	});

	it("sends explicit messages and publishes structured reports independently of presentation", async () => {
		const app = setup();
		await app.emit("session_start", {}, app.ctx);
		await app.emit("agent_start", {}, app.ctx);
		expect(
			(await app.connection.execute({ id: "message-1", action: "message", to: "worker", text: "Please check" })).status,
		).toBe("accepted");
		expect(app.tell).toHaveBeenCalledWith("worker", "Please check", expect.any(AbortSignal));
		const details = {
			id: "worker",
			status: "done" as const,
			summary: "Checked",
			session: { id: "child", file: "/tmp/result.jsonl" },
		};
		const content = "Checked\nThe result";
		await app.emit(
			"message_end",
			{ message: { role: "custom", customType: "octocode-agent-result", content, details } },
			app.ctx,
		);
		expect(app.connection.snapshot().events.at(-1)?.details).toEqual(presentAgentReport(content, details));
		await app.emit(
			"tool_execution_end",
			{
				toolName: "verify",
				toolCallId: "test",
				isError: true,
				result: { content: [{ type: "text", text: "Check failed" }] },
			},
			app.ctx,
		);
		expect(app.connection.snapshot().events.at(-1)?.outcome).toBe("failed");
		app.connection.close();
	});

	it("keeps typed verdicts visible without projecting large result data", async () => {
		const app = setup();
		await app.emit("session_start", {}, app.ctx);
		const data = { payload: "x".repeat(40000) };
		for (const status of ["valid", "invalid", "unavailable"] as const) {
			await app.emit(
				"message_end",
				{
					message: {
						role: "custom",
						customType: "octocode-agent-result",
						content: `Checked\nNotes\nStructured result:\n\`\`\`json\n${JSON.stringify(data)}\n\`\`\``,
						details: {
							status: "done",
							outcome: "done",
							summary: "Checked",
							structured: {
								version: 1,
								schemaHash: "abc",
								status,
								...(status === "valid" ? { data } : { error: { code: "invalid_result" } }),
							},
						},
					},
				},
				app.ctx,
			);
			const event = app.connection.snapshot().events.at(-1)!;
			expect(event.details).toMatchObject({ structured: { schemaHash: "abc", status } });
			expect(JSON.stringify(event)).not.toContain(data.payload);
			expect(event.text).not.toContain('"payload"');
			expect(event.outcome).toBe(status === "valid" ? "succeeded" : "failed");
		}
		app.connection.close();
	});

	it("exposes comments and scoped commands through authenticated HTTP", async () => {
		const app = setup();
		const item = add();
		const web = await startWorkspaceWeb(app.backlog, () => {}, app.connection);
		try {
			const url = new URL(web.url);
			const headers = { Authorization: `Bearer ${url.hash.slice(8)}`, "Content-Type": "application/json" };
			expect((await fetch(url.origin + "/api/workspace")).status).toBe(401);
			const post = (route: string, body: unknown) =>
				fetch(url.origin + route, { method: "POST", headers, body: JSON.stringify(body) });
			expect(
				(await post("/api/backlogs", { op: "comment", id: item.ref, version: item.version, note: "From browser" }))
					.status,
			).toBe(200);
			expect(store.comments(item.ref)[0].author).toBe("user");
			const sent = await post("/api/workspace", { id: "http-1", action: "message", to: "worker", text: "Hello" });
			expect(await sent.json()).toMatchObject({ receipt: { status: "accepted" } });
			expect((await post("/api/workspace", { id: "bad", action: "shell", text: "anything" })).status).toBe(400);
			expect((await fetch(url.origin + "/api/audit", { headers })).status).toBe(200);
		} finally {
			await web.close();
		}
	});
	it("redacts credentials from historical audit reads and pages without overlap", () => {
		const item = add();
		const secret = "ghp_" + "a1B2c3D4e5".repeat(4);
		db.db.prepare("UPDATE backlog SET body = ? WHERE id = ?").run(secret, item.rowId);
		db.db.prepare("UPDATE backlog SET body = '' WHERE id = ?").run(item.rowId);
		expect(JSON.stringify(store.audit(item.ref))).not.toContain(secret);
		const last = store.audit(item.ref, 1);
		const previous = store.audit(item.ref, 1, last[0].id);
		expect(previous[0].id).toBeLessThan(last[0].id);
	});

	it("accepts a note-only comment on another live session's item", () => {
		const item = add();
		db.db.prepare("INSERT INTO sessions(id,pid) VALUES ('holder', ?)").run(process.ppid);
		const claimed = store.update(item.ref, { state: "ongoing" }, { id: "holder" });
		store.comment(item.ref, "Keep the owner", { id: "user", kind: "human" }, claimed.version);
		expect(store.get(item.ref)?.assignee).toBe("holder");
		expect(store.comments(item.ref)[0].text).toBe("Keep the owner");
	});
});

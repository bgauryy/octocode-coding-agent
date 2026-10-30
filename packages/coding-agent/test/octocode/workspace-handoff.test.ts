import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openAgentDb, type AgentDb } from "../../src/octocode/agentdb/db.ts";
import { BacklogStore } from "../../src/octocode/backlog/store.ts";
import { WorkspaceRuntime } from "../../src/octocode/workspace/runtime.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";

let dir: string;
let db: AgentDb;
let store: BacklogStore;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-handoff-"));
	db = openAgentDb(path.join(dir, "db"));
	store = new BacklogStore(() => db, "repo");
});
afterEach(() => {
	db.close();
	fs.rmSync(dir, { recursive: true, force: true });
});
const actor = { id: "session-test", kind: "human" as const };
const add = (title = "Build it") => store.add({ title, goal: "Checks pass", why: "Users need it", createdBy: "user" });

function setup() {
	const fake = fakeHost();
	const ctx = fakeCtx({ cwd: dir });
	const runtime = new WorkspaceRuntime(fake.api, {
		database: () => db,
		members: () => [],
		traffic: () => [],
		tell: async () => ({}),
		stop: () => undefined,
	});
	const backlog = { store, actor, session: ctx.sessionManager.getSessionId(), repoName: "repo", repoRoot: dir };
	return { ...fake, ctx, runtime, backlog, connection: runtime.bind(ctx, backlog) };
}

describe("backlog implementation handoff", () => {
	it.each(["work", "delegate"] as const)("delivers full saved context and every comment for %s", async (action) => {
		const app = setup();
		const origin = add("Original investigation");
		let item = store.add({
			title: "Fix login",
			goal: "Login submits without freezing",
			why: "Users cannot sign in",
			plan: "Original diagnosis",
			paths: ["src/login.ts"],
			evidence: ["src/login.ts:42 — unresolved request"],
			tags: ["auth"],
			from: origin.ref,
			parentId: origin.ref,
			links: [{ relation: "evidence", target: { resource: "external", url: "https://example.test/issue/123" } }],
			createdBy: "user",
		});
		const derived = store.add({ title: "Related follow-up", from: item.ref, createdBy: "user" });
		item = store.update(item.ref, { plan: "Current diagnosis\nAdd cancellation and a regression test" }, actor);
		const comments = Array.from({ length: 25 }, (_, index) => `Comment ${String(index).padStart(2, "0")} requirement`);
		for (const text of comments) item = store.comment(item.ref, text, { id: "reviewer", kind: "human" });
		item = store.comment(item.ref, "Multiline requirement\nPreserve cancellation", actor);
		const command = { id: "implement", action, backlogId: item.ref, version: item.version };
		expect((await app.connection.execute(command)).status).toBe("accepted");
		expect(app.sent).toHaveLength(1);
		const message = app.sent[0].message as string;
		expect(
			message.startsWith(
				action === "work" ? `Implement backlog item ${item.ref}\n` : `Delegate backlog item ${item.ref}`,
			),
		).toBe(true);
		for (const text of comments) expect(message.split(text)).toHaveLength(2);
		for (const text of [
			"Fix login",
			"Login submits without freezing",
			"Users cannot sign in",
			"Current diagnosis",
			"Original diagnosis",
			"Add cancellation and a regression test",
			"src/login.ts:42",
			"#auth",
			"Comments (26, oldest first)",
			"reviewer",
			"Multiline requirement\n  Preserve cancellation",
			"https://example.test/issue/123",
			`Parent: ${origin.ref}`,
			"Original investigation",
			derived.ref,
			"Related follow-up",
			"follow every Next page",
			"Follow existing permissions",
		])
			expect(message).toContain(text);
		expect(app.sent[0].options).toEqual({ deliverAs: "followUp" });
		expect(store.get(item.ref)).toMatchObject({ state: "ongoing", assignee: actor.id });
		// Replaying a request or a stale double click must not enqueue a second implementation.
		expect((await app.connection.execute(command)).status).toBe("accepted");
		expect((await app.connection.execute({ ...command, id: "duplicate-click" })).status).toBe("failed");
		expect(app.sent).toHaveLength(1);
		app.connection.close();
	});

	it("requires a fresh item version after comments change and rejects missing items", async () => {
		const app = setup();
		const item = add();
		const latest = store.comment(item.ref, "Do not start until this requirement is read", actor);
		const command = { id: "stale", action: "work" as const, backlogId: item.ref, version: item.version };
		expect(await app.connection.execute(command)).toMatchObject({
			status: "failed",
			message: expect.stringContaining("changed"),
		});
		expect(app.sent).toHaveLength(0);
		expect((await app.connection.execute({ ...command, id: "fresh", version: latest.version })).status).toBe(
			"accepted",
		);
		expect(app.sent[0].message).toContain("Do not start until this requirement is read");
		expect(await app.connection.execute({ ...command, id: "missing", backlogId: "B999" })).toMatchObject({
			status: "failed",
			message: expect.stringContaining("no longer exists"),
		});
		expect(app.sent).toHaveLength(1);
		app.connection.close();
	});

	it("rolls back the claim when agent message delivery fails", async () => {
		const app = setup();
		const item = add();
		vi.spyOn(app.api, "sendUserMessage").mockImplementation(() => {
			throw new Error("Session unavailable");
		});
		expect(
			await app.connection.execute({ id: "failed", action: "work", backlogId: item.ref, version: item.version }),
		).toMatchObject({
			status: "failed",
			message: "Session unavailable",
		});
		expect(store.get(item.ref)).toEqual(item);
		expect(app.sent).toHaveLength(0);
		app.connection.close();
	});
});

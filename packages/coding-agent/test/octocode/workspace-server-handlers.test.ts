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

describe("workspace HTTP handlers without network I/O", () => {
	it("rejects foreign origins, missing credentials and invalid payloads before any agent side effect", async () => {
		const command = { id: "work", action: "work", backlogId: "B1", version: 1 };
		for (const headers of [{ host: "example.test" }, { origin: "https://example.test" }])
			expect((await app.request("/api/workspace", command, { headers })).status).toBe(403);
		expect((await app.request("/api/workspace", command, { headers: { authorization: "" } })).status).toBe(401);
		expect((await app.request("/api/workspace", { ...command, action: "shell" })).status).toBe(400);
		expect((await app.request("/api/workspace", undefined, { raw: "{" })).status).toBe(400);
		expect((await app.request("/api/workspace", undefined, { raw: "x".repeat(262145) })).status).toBe(413);
		expect((await app.request("/api/workspace", command, { headers: { "content-type": "text/plain" } })).status).toBe(
			400,
		);
		expect(app.session.sendUserMessage).not.toHaveBeenCalled();
		expect(app.workspace.snapshot().receipts).toEqual([]);
		expect(app.changed).not.toHaveBeenCalled();
	});

	it("serves only a placeholder shell before authentication and protects backlog data", async () => {
		app.store.add({ title: "Private task title", createdBy: "user" });
		const shell = await app.request("/", undefined, { headers: { authorization: "" } });
		expect(shell.status).toBe(200);
		expect(shell.text).not.toContain("Private task title");
		expect(shell.text).not.toContain(app.token);
		expect((await app.request("/api/backlogs", undefined, { headers: { authorization: "" } })).status).toBe(401);
		expect((await app.request("/api/backlogs")).text).toContain("Private task title");
	});

	it("passes all saved comments through the implementation handoff, deduplicates retries and refreshes counts", async () => {
		let item = app.store.add({
			title: "Implement search",
			goal: "Results update",
			why: "Users need search",
			createdBy: "user",
		});
		const comments = Array.from({ length: 25 }, (_, index) => `Requirement ${index}: keep this context`);
		for (const note of comments) {
			const result = await app.request("/api/backlogs", { op: "comment", id: item.ref, version: item.version, note });
			expect(result.status).toBe(200);
			item = app.store.get(item.ref)!;
		}
		app.changed.mockClear();
		const command = { id: "implement-search", action: "work", backlogId: item.ref, version: item.version };
		const result = await app.request("/api/workspace", command);
		expect(result).toMatchObject({ status: 200, body: { receipt: { id: command.id, status: "accepted" } } });
		expect(app.changed).toHaveBeenCalledOnce();
		expect(app.store.get(item.ref)).toMatchObject({ state: "ongoing", assignee: app.session.sessionId });
		const prompt = app.session.sendUserMessage.mock.calls[0][0];
		expect(prompt).toMatch(/^Implement backlog item B1\n/);
		for (const comment of comments) expect(prompt.split(comment)).toHaveLength(2);
		expect(prompt).toContain("follow every Next page");
		expect((await app.request("/api/workspace", command)).body).toEqual(result.body);
		expect(app.session.sendUserMessage).toHaveBeenCalledOnce();
		expect((await app.request("/api/workspace", { ...command, id: "stale-click" })).body).toMatchObject({
			receipt: { status: "failed" },
		});
		expect(app.session.sendUserMessage).toHaveBeenCalledOnce();
		expect((await app.request("/api/audit?backlogId=B1")).text).toContain(comments[0]);
	});

	it("validates application commands and refuses stale sessions before dispatch", async () => {
		const command = { id: "prompt", sessionId: app.session.sessionId, action: "prompt", text: "Continue" };
		expect((await app.request("/api/application", { ...command, action: "shell" })).status).toBe(400);
		expect((await app.request("/api/application", { ...command, sessionId: "other-session" })).status).toBe(409);
		expect(app.session.prompt).not.toHaveBeenCalled();
		expect((await app.request("/api/application", command)).body).toMatchObject({
			receipt: { id: "prompt", status: "accepted" },
		});
		await vi.waitFor(() => expect(app.session.prompt).toHaveBeenCalledOnce());
		expect((await app.request("/api/application", command)).body).toMatchObject({
			receipt: { id: "prompt", status: "completed" },
		});
		expect(app.session.prompt).toHaveBeenCalledOnce();
		expect((await app.request("/api/application", { ...command, text: "Different command" })).status).toBe(409);
		app.session.sessionId = "replacement";
		expect((await app.request("/api/application", { ...command, id: "late" })).status).toBe(409);
		expect(app.session.prompt).toHaveBeenCalledOnce();
	});

	it("reports committed writes and accepted work when the terminal refresh callback fails", async () => {
		app.changed.mockImplementation(() => {
			throw new Error("Terminal view is closed");
		});
		const saved = await app.request("/api/backlogs", {
			op: "add",
			title: "Persist before refreshing views",
			goal: "Keep the accepted result",
			reason: "A view failure must not invite duplicate work",
		});
		expect(saved).toMatchObject({ status: 200, body: { item: { ref: "B1" } } });
		const item = app.store.get("B1")!;
		const command = { id: "work-with-closed-terminal", action: "work", backlogId: item.ref, version: item.version };
		const started = await app.request("/api/workspace", command);
		expect(started).toMatchObject({ status: 200, body: { receipt: { id: command.id, status: "accepted" } } });
		expect(app.session.sendUserMessage).toHaveBeenCalledOnce();
		expect((await app.request("/api/workspace", command)).body).toEqual(started.body);
		expect(app.session.sendUserMessage).toHaveBeenCalledOnce();
		expect(app.store.list().items).toHaveLength(1);
	});

	it("keeps the accepted receipt when a session change prevents the post-dispatch workspace update", async () => {
		const socket = app.upgrade().client!;
		socket.hello({ token: app.token, protocolVersion: 1 });
		await vi.waitFor(() => expect(socket.frames()[0]?.type).toBe("snapshot"));
		const item = app.store.add({
			title: "Finish dispatch",
			goal: "Queue once",
			why: "Preserve acceptance",
			createdBy: "user",
		});
		const previousSession = app.session.sessionId;
		app.changed.mockImplementation(() => {
			app.session.sessionId = "replacement";
		});
		const command = { id: "dispatch-before-switch", action: "work", backlogId: item.ref, version: item.version };
		const result = await app.request("/api/workspace", command);
		expect(result).toMatchObject({ status: 200, body: { receipt: { id: command.id, status: "accepted" } } });
		expect(app.store.get(item.ref)).toMatchObject({ state: "ongoing", assignee: previousSession });
		expect(app.session.sendUserMessage).toHaveBeenCalledOnce();
		expect(socket.closed).toBeDefined();
		expect((await app.request("/api/workspace", { ...command, id: "late" })).status).toBe(409);
		expect(app.session.sendUserMessage).toHaveBeenCalledOnce();
	});
});

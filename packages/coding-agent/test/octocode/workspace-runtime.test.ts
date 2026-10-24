import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApplicationService } from "../../src/core/application/index.ts";
import type { AgentSession } from "../../src/core/agent-session.ts";
import { openAgentDb, type AgentDb } from "../../src/octocode/agentdb/db.ts";
import { BacklogStore } from "../../src/octocode/backlog/store.ts";
import { WorkspaceCommands } from "../../src/octocode/workspace/commands.ts";
import { WorkspaceRuntime } from "../../src/octocode/workspace/runtime.ts";
import { fakeCtx, fakePi } from "./fake-pi.ts";

let dir: string;
let db: AgentDb;
let store: BacklogStore;
const applications: ApplicationService[] = [];
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-runtime-"));
	db = openAgentDb(path.join(dir, "db"));
	store = new BacklogStore(() => db, "repo");
});
afterEach(() => {
	for (const application of applications.splice(0)) application.dispose();
	db.close();
	fs.rmSync(dir, { recursive: true, force: true });
});
function setup(
	options: {
		send?: () => Promise<void>;
		tell?: (to: string, text: string, signal?: AbortSignal) => Promise<unknown>;
	} = {},
) {
	const fake = fakePi();
	const ctx = fakeCtx({ cwd: dir });
	const session = {
		sessionId: ctx.sessionManager.getSessionId(),
		messages: [],
		sendUserMessage: vi.fn(options.send ?? (async () => {})),
		subscribe: () => () => {},
	};
	const application = new ApplicationService(session as unknown as AgentSession);
	applications.push(application);
	const tell = vi.fn(options.tell ?? (async () => ({ sent: ["worker"], id: 1 })));
	const stop = vi.fn(() => "Not owned by this session");
	const runtime = new WorkspaceRuntime(fake.pi, {
		application: () => application,
		database: () => db,
		members: () => [{ id: "worker", role: "general", status: "working" } as never],
		traffic: () => [],
		tell,
		stop,
	});
	const backlog = { store, actor: { id: session.sessionId }, session: session.sessionId, repoName: "repo" };
	const connection = runtime.bind(ctx, backlog);
	const item = store.add({ title: "Fix login", goal: "Tests pass", reason: "Users are blocked", createdBy: "user" });
	const command = { id: "work-1", action: "work" as const, backlogId: item.ref, version: item.version };
	return { ...fake, ctx, session, application, runtime, backlog, connection, tell, stop, item, command };
}

describe("workspace runtime boundary", () => {
	it("keeps activity snapshots isolated and releases each view's store subscription", async () => {
		const app = setup();
		const second = app.runtime.bind(app.ctx, app.backlog);
		const firstChanged = vi.fn();
		const secondChanged = vi.fn();
		app.connection.subscribe(firstChanged);
		second.subscribe(secondChanged);
		await app.emit("agent_start", {}, app.ctx);
		const snapshot = app.connection.snapshot();
		snapshot.events[0].text = "tampered";
		snapshot.events.length = 0;
		expect(second.snapshot().events[0].text).toBe("Agent working");
		app.connection.close();
		await app.emit("agent_settled", { aborted: false }, app.ctx);
		expect(firstChanged).toHaveBeenCalledTimes(1);
		expect(secondChanged).toHaveBeenCalledTimes(2);
		await app.emit("session_shutdown", {}, app.ctx);
		await app.emit("agent_start", {}, app.ctx);
		expect(secondChanged).toHaveBeenCalledTimes(2);
		second.close();
	});

	it("dispatches backlog work through the session application without treating acceptance as completion", async () => {
		let resolve!: () => void;
		const app = setup({
			send: () =>
				new Promise<void>((done) => {
					resolve = done;
				}),
		});
		expect(await app.connection.execute(app.command)).toMatchObject({ status: "accepted" });
		expect(app.session.sendUserMessage).toHaveBeenCalledWith(expect.stringMatching(/^Implement backlog item B1\n/), {
			deliverAs: "followUp",
		});
		expect(app.sent).toHaveLength(0);
		app.connection.close();
		resolve();
		await Promise.resolve();
		const reconnected = app.runtime.bind(app.ctx, app.backlog);
		expect(await reconnected.execute(app.command)).toMatchObject({ status: "accepted" });
		expect(app.session.sendUserMessage).toHaveBeenCalledTimes(1);
		expect(store.get(app.item.ref)?.state).toBe("ongoing");
		reconnected.close();
	});

	it("persists a failed receipt when application delivery rejects asynchronously, including after a view closes", async () => {
		let reject!: (reason: Error) => void;
		const app = setup({
			send: () =>
				new Promise<void>((_resolve, fail) => {
					reject = fail;
				}),
		});
		expect(await app.connection.execute(app.command)).toMatchObject({ status: "accepted" });
		app.connection.close();
		reject(new Error("No model selected"));
		const reconnected = app.runtime.bind(app.ctx, app.backlog);
		await vi.waitFor(() =>
			expect(reconnected.snapshot().receipts).toEqual([
				expect.objectContaining({
					id: app.command.id,
					status: "failed",
					message: expect.stringContaining("No model selected"),
				}),
			]),
		);
		expect(reconnected.snapshot().receipts[0].message).toContain("B1 remains claimed");
		expect(reconnected.snapshot().events.at(-1)?.outcome).toBe("failed");
		expect(await reconnected.execute(app.command)).toMatchObject({ status: "failed" });
		expect(app.session.sendUserMessage).toHaveBeenCalledTimes(1);
		reconnected.close();
	});

	it("refuses a changed application session before recording or dispatching work", async () => {
		const app = setup();
		app.session.sessionId = "replacement";
		await expect(app.connection.execute(app.command)).rejects.toThrow(/session changed/);
		expect(app.session.sendUserMessage).not.toHaveBeenCalled();
		expect(new WorkspaceCommands(db, "repo", app.backlog.session).list()).toEqual([]);
		expect(store.get(app.item.ref)).toEqual(app.item);
		app.connection.close();
	});

	it("validates non-HTTP commands before any stop or receipt side effect", async () => {
		const app = setup();
		await expect(app.connection.execute({ id: "bad", action: "shell", to: "worker" } as never)).rejects.toThrow(
			"Invalid workspace command",
		);
		expect(app.stop).not.toHaveBeenCalled();
		expect(app.connection.snapshot().receipts).toEqual([]);
		app.connection.close();
		expect(() => app.connection.subscribe(() => {})).toThrow(/session changed/);
	});

	it.each(["session_start", "session_shutdown"] as const)(
		"cancels pending agent delivery at %s without publishing into another session",
		async (event) => {
			let signal!: AbortSignal;
			const app = setup({
				tell: async (_to, _text, value) =>
					new Promise((_resolve, reject) => {
						signal = value!;
						signal.addEventListener("abort", () => reject(signal.reason), { once: true });
					}),
			});
			const pending = app.connection.execute({ id: "message-1", action: "message", to: "worker", text: "Check this" });
			expect(signal.aborted).toBe(false);
			if (event === "session_start") {
				app.session.sessionId = "replacement";
				vi.spyOn(app.ctx.sessionManager, "getSessionId").mockReturnValue("replacement");
			}
			await app.emit(event, {}, app.ctx);
			expect(signal.aborted).toBe(true);
			expect(await pending).toMatchObject({
				status: "failed",
				message: expect.stringContaining("before delivery finished"),
			});
			const stored = new WorkspaceCommands(db, "repo", app.backlog.session).list();
			expect(stored[0].status).toBe("failed");
			app.connection.close();
		},
	);

	it("allows pending messages to finish when only the view closes", async () => {
		let signal!: AbortSignal;
		let resolve!: (value: unknown) => void;
		const app = setup({
			tell: async (_to, _text, value) =>
				new Promise((done) => {
					signal = value!;
					resolve = done;
				}),
		});
		const pending = app.connection.execute({ id: "message-1", action: "message", to: "worker", text: "Check this" });
		app.connection.close();
		expect(signal.aborted).toBe(false);
		resolve({ sent: ["worker"], id: 1 });
		expect(await pending).toMatchObject({ status: "accepted" });
	});
});

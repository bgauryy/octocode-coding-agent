import { fixtureBacklog } from "./backlog-fixture.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApplicationService } from "../../src/core/application/index.ts";
import type { AgentSession } from "../../src/core/agent-session.ts";
import { openAgentDb } from "../../src/storage/database.ts";
import { type AgentDb } from "../../../db/src/api.ts";
import type { BacklogStore } from "../../src/octocode/backlog/store.ts";
import { WorkspaceCommands } from "../../src/octocode/workspace/commands.ts";
import { teamView, WorkspaceRuntime } from "../../src/octocode/workspace/runtime.ts";
import { Team } from "../../src/octocode/team/session.ts";
import { TeamStore } from "../../src/octocode/team/store.ts";
import type { Member } from "@octocodeai/octocode-contracts/team";
import { fakeCtx, fakeHost } from "./fake-host.ts";

let dir: string;
let db: AgentDb;
let store: BacklogStore;
const applications: ApplicationService[] = [];
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-runtime-"));
	db = openAgentDb(path.join(dir, "db"));
	store = fixtureBacklog(() => db, "repo");
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
		expiry?: () => string;
		team?: Team;
		stop?: () => string | undefined;
	} = {},
) {
	const fake = fakeHost();
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
	const stop = vi.fn(options.stop ?? (() => "Not owned by this session"));
	const runtime = new WorkspaceRuntime(fake.api, {
		application: () => application,
		database: () => db,
		...(options.team
			? teamView(options.team)
			: {
					members: () => [{ id: "worker", role: "general", status: "working" } as never],
					traffic: () => [],
				}),
		tell,
		stop,
		expiry: options.expiry,
	});
	const backlog = {
		store,
		actor: { id: session.sessionId },
		session: session.sessionId,
		repoName: "repo",
		repoRoot: dir,
	};
	const connection = runtime.bind(ctx, backlog);
	const item = store.add({ title: "Fix login", goal: "Tests pass", why: "Users are blocked", createdBy: "user" });
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
			// Delivery starts once the command's receipt is recorded.
			await vi.waitFor(() => expect(signal).toBeDefined());
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
		// Delivery starts once the command's receipt is recorded.
		await vi.waitFor(() => expect(signal).toBeDefined());
		app.connection.close();
		expect(signal.aborted).toBe(false);
		resolve({ sent: ["worker"], id: 1 });
		expect(await pending).toMatchObject({ status: "accepted" });
	});

	describe("agents of other sessions in the same workspace", () => {
		const member = (id: string, extra: Partial<Member> = {}): Member => ({
			id,
			role: "researcher",
			pid: process.pid,
			status: "working",
			joinedAt: Date.now(),
			updatedAt: Date.now(),
			toolCalls: 0,
			input: 0,
			cacheRead: 0,
			output: 0,
			cost: 0,
			unpriced: false,
			...extra,
		});

		it("lists only this session's descendants and refuses a stop for the other session's child", async () => {
			const file = path.join(dir, "team.db");
			const sessions = [0, 1].map(() => {
				const host = fakeHost();
				const team = new Team(host.api, { OCTOCODE_AGENT_DB: file });
				const ctx = fakeCtx({ cwd: dir, hasUI: false });
				team.start(ctx);
				team.join();
				return { team, app: setup({ team, stop: () => undefined }) };
			});
			const store = TeamStore.open(dir, file, {});
			try {
				const [first, second] = sessions;
				const [firstId, secondId] = [first.team.id!, second.team.id!];
				expect(firstId).not.toBe(secondId);
				store.join(member("first-child", { parentId: firstId }));
				store.join(member("first-grandchild", { parentId: "first-child" }));
				store.join(member("second-child", { parentId: secondId }));
				store.send("first-child", [firstId], "from the first child", { replyRequired: false });
				store.send("second-child", [secondId], "from the second child", { replyRequired: false });

				const ids = (session: (typeof sessions)[number]) =>
					session.app.connection
						.snapshot()
						.agents.map((agent) => agent.id)
						.sort();
				expect(ids(first)).toEqual(["first-child", "first-grandchild"]);
				expect(ids(second)).toEqual(["second-child"]);
				expect(first.app.connection.snapshot().traffic.map((message) => message.text)).toEqual([
					"from the first child",
				]);
				expect(second.app.connection.snapshot().traffic.map((message) => message.text)).toEqual([
					"from the second child",
				]);

				expect(
					await first.app.connection.execute({ id: "stop-foreign", action: "stop", to: "second-child" }),
				).toMatchObject({ status: "failed", message: expect.stringContaining("not one of this session's agents") });
				expect(first.app.stop).not.toHaveBeenCalled();
				expect(
					await first.app.connection.execute({
						id: "message-foreign",
						action: "message",
						to: "second-child",
						text: "hi",
					}),
				).toMatchObject({ status: "failed" });
				expect(first.app.tell).not.toHaveBeenCalled();

				expect(
					await first.app.connection.execute({ id: "stop-own", action: "stop", to: "first-grandchild" }),
				).toMatchObject({
					status: "accepted",
				});
				expect(first.app.stop).toHaveBeenCalledWith("first-grandchild");
			} finally {
				store.close();
				for (const { team, app } of sessions) {
					app.connection.close();
					team.stop();
				}
			}
		});
	});

	describe("revision stamp", () => {
		it("is stable while nothing changes and moves for each snapshot input", async () => {
			let bucket = "1";
			const app = setup({ expiry: () => bucket });
			const stamp = () => app.connection.revision?.();
			const initial = stamp();
			expect(initial).toBeDefined();
			expect(stamp()).toBe(initial);

			await app.emit("agent_start", {}, app.ctx);
			const afterEvent = stamp();
			expect(afterEvent).not.toBe(initial);
			expect(stamp()).toBe(afterEvent);

			// Receipts (and every other database writer, members and traffic included) move the database stamp.
			expect(await app.connection.execute(app.command)).toMatchObject({ status: "accepted" });
			const afterReceipt = stamp();
			expect(afterReceipt).not.toBe(afterEvent);

			bucket = "2";
			expect(stamp()).not.toBe(afterReceipt);
			app.connection.close();
		});

		it("is undefined when members and traffic cannot be stamped, and throws once the view closed", () => {
			const unstamped = setup();
			expect(unstamped.connection.revision?.()).toBeUndefined();
			const stamped = setup({ expiry: () => "1" });
			stamped.connection.close();
			expect(() => stamped.connection.revision?.()).toThrow("This session changed");
			unstamped.connection.close();
		});
	});
});

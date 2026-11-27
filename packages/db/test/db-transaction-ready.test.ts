import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AgentDb, agentEvents, agents, openDatabase, transactionWhenReady, workspaces } from "../src/api.ts";
import { busyTimeout, isBusy } from "../src/sqlite.ts";
import { holdWrite } from "./hold-write.ts";
import { tmp } from "./helpers.ts";

let agent: AgentDb;
const holders: Awaited<ReturnType<typeof holdWrite>>[] = [];
beforeEach(() => {
	const root = tmp();
	agent = openDatabase({
		file: path.join(root, "ready.db"),
		mirrorFile: path.join(root, "mirror.db"),
		archiveDir: path.join(root, "archive"),
		privateParent: false,
	});
	agents.setBusyTimeout(agent.db, 200);
});
afterEach(async () => {
	for (const holder of holders.splice(0)) await holder.close();
	agent.close();
});

describe("transaction admission without blocking", () => {
	it("lets the caller release a peer lock, then executes the callback once", async () => {
		const holder = await holdWrite(agent.file);
		holders.push(holder);
		let released = false;
		const timer = setTimeout(() => {
			released = true;
			holder.release();
		}, 10);
		const work = vi.fn(() => {
			expect(released).toBe(true);
			return 42;
		});
		try {
			expect(await transactionWhenReady(agent, work)).toBe(42);
		} finally {
			clearTimeout(timer);
		}
		expect(work).toHaveBeenCalledTimes(1);
		expect(busyTimeout(agent.db)).toBe(200);
	});

	it("restores the timeout before callback, nested work, commit and event listeners", async () => {
		workspaces.register(agent.db, { id: "fixture", root: "/fixture", name: "fixture", binding: "fixture" });
		const waits: number[] = [];
		const committed = vi.fn(() => waits.push(busyTimeout(agent.db)));
		const appended = vi.fn(() => waits.push(busyTimeout(agent.db)));
		agent.onCommit(committed);
		agent.onEvents(appended);
		const work = vi.fn(() =>
			agent.transaction(() => {
				waits.push(busyTimeout(agent.db));
				agentEvents.append(agent.db, "fixture", {
					id: "event",
					name: null,
					parentId: null,
					sessionId: "actor-fixture",
					type: "create",
					time: new Date().toISOString(),
					version: 1,
					data: { actor: "actor-fixture" },
				});
				return 7;
			}),
		);
		expect(await transactionWhenReady(agent, work)).toBe(7);
		expect(work).toHaveBeenCalledTimes(1);
		expect(committed).toHaveBeenCalledTimes(1);
		expect(appended).toHaveBeenCalledTimes(1);
		expect(waits).toEqual([200, 200, 200]);
		expect(agentEvents.get(agent.db, "fixture", "event")?.sessionId).toBe("actor-fixture");
	});

	it("rolls back and never replays a callback that itself throws SQLITE_BUSY", async () => {
		const committed = vi.fn();
		agent.onCommit(committed);
		const error = Object.assign(new Error("callback busy"), { errcode: 5 });
		const work = vi.fn(() => {
			workspaces.register(agent.db, { id: "rolled-back", root: "/fixture", name: "fixture", binding: "fixture" });
			throw error;
		});
		await expect(transactionWhenReady(agent, work)).rejects.toBe(error);
		expect(work).toHaveBeenCalledTimes(1);
		expect(committed).not.toHaveBeenCalled();
		expect(workspaces.byId(agent.db, "rolled-back")).toBeUndefined();
		expect(busyTimeout(agent.db)).toBe(200);
	});

	it("aborts while waiting without entering the callback", async () => {
		const holder = await holdWrite(agent.file);
		holders.push(holder);
		const controller = new AbortController();
		const work = vi.fn();
		const timer = setTimeout(() => controller.abort(), 10);
		try {
			await expect(transactionWhenReady(agent, work, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
		} finally {
			clearTimeout(timer);
		}
		expect(work).not.toHaveBeenCalled();
		expect(busyTimeout(agent.db)).toBe(200);
	});

	it("rejects thenables before commit and rolls back synchronous changes", async () => {
		const committed = vi.fn();
		agent.onCommit(committed);
		const work = vi.fn(() => {
			workspaces.register(agent.db, { id: "async-misuse", root: "/fixture", name: "fixture", binding: "fixture" });
			return Promise.resolve(7);
		});
		await expect(transactionWhenReady(agent, work)).rejects.toThrow(/requires synchronous work/);
		expect(work).toHaveBeenCalledTimes(1);
		expect(committed).not.toHaveBeenCalled();
		expect(workspaces.byId(agent.db, "async-misuse")).toBeUndefined();
		expect(busyTimeout(agent.db)).toBe(200);
	});

	it("keeps the configured admission deadline and never enters on exhaustion", async () => {
		const holder = await holdWrite(agent.file);
		holders.push(holder);
		agents.setBusyTimeout(agent.db, 10);
		const work = vi.fn();
		await expect(transactionWhenReady(agent, work)).rejects.toSatisfy(isBusy);
		expect(work).not.toHaveBeenCalled();
		expect(busyTimeout(agent.db)).toBe(10);
	});

	it("handles a refused async callback rejection without committing its changes", async () => {
		const committed = vi.fn();
		agent.onCommit(committed);
		await expect(
			transactionWhenReady(agent, async () => {
				workspaces.register(agent.db, { id: "rejected-async", root: "/fixture", name: "fixture", binding: "fixture" });
				throw new Error("async misuse");
			}),
		).rejects.toThrow(/requires synchronous work/);
		await new Promise((resolve) => setImmediate(resolve));
		expect(committed).not.toHaveBeenCalled();
		expect(workspaces.byId(agent.db, "rejected-async")).toBeUndefined();
	});
});

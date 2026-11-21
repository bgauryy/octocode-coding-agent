import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeSharedAgentDb } from "../../../db/src/api.ts";
import { type Backlog } from "../../src/octocode/backlog/context.ts";
import { graphNotice } from "../../src/octocode/backlog/graph-notice.ts";
import { BacklogStore } from "../../src/octocode/backlog/store.ts";
import { type ItemSnap, workGraph } from "../../src/octocode/graph/model.ts";
import { busyPools, readyItems, readyText } from "../../src/octocode/graph/ready.ts";
import { sharedAgentDb } from "../../src/storage/database.ts";
import { registeredWorkspace } from "../../src/storage/workspace-database.ts";

// The full-run lock is host-wide (a run anywhere on this machine holds it); the tests choose its holder.
const hostLock = vi.hoisted(() => ({ snap: undefined as { label: string; agent?: string } | undefined }));
vi.mock("../../src/octocode/graph/run-lock.ts", () => ({ readRunLockSnap: () => hostLock.snap }));

const snap = (ref: string, over: Partial<ItemSnap> = {}): ItemSnap => ({
	ref,
	title: ref,
	state: "todo",
	priority: 2,
	createdAt: 100,
	dependsOn: [],
	...over,
});

const ready = (items: ItemSnap[], extra: Parameters<typeof workGraph>[0] = {}) =>
	readyItems(workGraph({ items, ...extra }), items).map((item) => item.ref);

describe("readyItems: code orders the work", () => {
	it("orders by priority, then transitive unblock count, then age", () => {
		const items = [
			snap("B1", { createdAt: 5 }),
			snap("B2", { createdAt: 9 }),
			snap("B3", { priority: 0, createdAt: 50 }),
			snap("B4", { dependsOn: ["B2"] }),
			snap("B5", { dependsOn: ["B4"] }),
			snap("B6", { createdAt: 1 }),
		];
		// B3 is p0; B2 unblocks B4 and B5 (2); B1 and B6 unblock none: B6 is older.
		expect(ready(items)).toEqual(["B3", "B2", "B6", "B1"]);
		expect(readyItems(workGraph({ items }), items)[1]).toMatchObject({ ref: "B2", unblocks: 2 });
	});

	it("takes accepted work only: a proposal (backlog) and an ongoing item are not ready", () => {
		const items = [snap("B1"), snap("B2", { state: "backlog" }), snap("B3", { state: "ongoing" })];
		expect(ready(items)).toEqual(["B1"]);
	});

	it("leaves out started, held, epic, unmet and resource-blocked items, and counts done prerequisites as met", () => {
		const items = [
			snap("B1", { state: "done" }),
			snap("B2", { dependsOn: ["B1"] }),
			snap("B3", { state: "ongoing", holder: "a" }),
			snap("B4", { type: "epic" }),
			snap("B5", { dependsOn: ["B3"] }),
			snap("B6", { dependsOn: ["B99"] }),
			snap("B7", { needs: ["resource:full-run"] }),
		];
		const held = {
			agents: [{ name: "b", state: "running" }],
			resources: [{ id: "full-run", label: "run", owner: "b" }],
		};
		expect(ready(items, held)).toEqual(["B2"]);
		expect(ready(items)).toEqual(["B2", "B7"]);
	});

	it("lists the first five and the busy pools", () => {
		const items = Array.from({ length: 7 }, (_, i) => snap(`B${i + 1}`, { createdAt: i }));
		const graph = workGraph({
			items,
			agents: [{ name: "a", state: "running" }],
			resources: [{ id: "full-run", label: "run", owner: "a", item: "B1" }],
		});
		const text = readyText(readyItems(graph, items), busyPools(graph));
		expect(text).toBe("ready: B1 (p2), B2 (p2), B3 (p2), B4 (p2), B5 (p2), +2 more; busy: full-run (B1)");
		expect(readyText([], ["x"])).toBe("");
	});
});

describe("graphNotice lists the ready items after what a completion unblocked", () => {
	let root: string;
	let env: NodeJS.ProcessEnv;
	beforeEach(() => {
		root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "octocode-ready-")));
		fs.mkdirSync(path.join(root, "repo", ".git"), { recursive: true });
		env = { ...process.env, OCTOCODE_HOME: path.join(root, "home"), OCTOCODE_AGENT_DB: path.join(root, "agent.db") };
		vi.stubEnv("OCTOCODE_HOME", env.OCTOCODE_HOME);
		vi.stubEnv("OCTOCODE_AGENT_DB", env.OCTOCODE_AGENT_DB);
		hostLock.snap = undefined;
	});
	afterEach(() => {
		hostLock.snap = undefined;
		closeSharedAgentDb();
		vi.unstubAllEnvs();
		fs.rmSync(root, { recursive: true, force: true });
	});

	it("names the other ready items in order, and nothing extra when the notice already names them all", () => {
		const db = sharedAgentDb(env);
		const store = new BacklogStore(() => db, registeredWorkspace(path.join(root, "repo"), db).id);
		const base = { goal: "Observable result", why: "Needed", createdBy: "agent" as const, state: "todo" as const };
		const first = store.add({ ...base, title: "first" });
		const next = store.add({ ...base, title: "next", dependsOn: [first.ref] });
		const low = store.add({ ...base, title: "low", priority: 3 });
		const high = store.add({ ...base, title: "high", priority: 0 });
		store.update(
			first.ref,
			{
				state: "done",
				completion: { summary: "ok", files: [], verification: { status: "passed", summary: "t" }, operationKey: "k" },
			},
			{ id: "human", surface: "command" },
		);
		const backlog = { store } as unknown as Backlog;
		const ready = `${next.ref} is ready to start: ${first.ref} was its last open prerequisite. ready: ${high.ref} (p0), ${low.ref} (p3)`;
		expect(graphNotice(backlog, first.ref)).toBe(ready);
		hostLock.snap = { label: "vitest in packages/db", agent: "swift-orca" };
		expect(graphNotice(backlog, first.ref)).toBe(`${ready}; busy: full-run (swift-orca)`);
	});
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeSharedAgentDb, leases } from "../../../db/src/api.ts";
import { BacklogStore } from "../../src/octocode/backlog/store.ts";
import {
	EDGE_KINDS,
	type GraphSources,
	type ItemSnap,
	type NodeId,
	nodeId,
	workGraph,
} from "../../src/octocode/graph/model.ts";
import { readGraphSources } from "../../src/octocode/backlog/graph-sources.ts";
import { sharedAgentDb } from "../../src/storage/database.ts";
import { registeredWorkspace } from "../../src/storage/workspace-database.ts";

const item = (ref: string, extra: Partial<ItemSnap> = {}): ItemSnap => ({
	ref,
	title: `Title ${ref}`,
	state: "todo",
	priority: 2,
	createdAt: 1,
	dependsOn: [],
	...extra,
});

const FULL: GraphSources = {
	items: [
		item("B1", { type: "epic" }),
		item("B2", { parent: "B1", holder: "sly-mantle", state: "ongoing" }),
		item("B3", { parent: "B1", dependsOn: ["B2"], needs: [nodeId("resource", "full-run")] }),
		item("B4", { dependsOn: ["B99"] }),
	],
	steps: [{ ref: "T1", goal: "First step", state: "ongoing", item: "B2" }],
	agents: [{ name: "sly-mantle", state: "running", item: "B2" }],
	jobs: [{ id: "bash-4", label: "yarn test", state: "running", item: "B2", agent: "sly-mantle" }],
	resources: [{ id: "full-run", label: "full-run: yarn test", owner: "sly-mantle", job: "bash-4", item: "B2" }],
	waits: [{ id: "#7", label: "until B2 done", state: "active", on: nodeId("item", "B2") }],
};

const has = (graph: ReturnType<typeof workGraph>, kind: string, from: NodeId, to: NodeId) =>
	graph.edges.some((edge) => edge.kind === kind && edge.from === from && edge.to === to);

describe("workGraph: a pure model over snapshots", () => {
	const graph = workGraph(FULL);

	it("has a node of every kind with its state, label and source row", () => {
		expect(new Set(graph.nodes.map((node) => node.kind))).toEqual(
			new Set(["item", "step", "agent", "job", "resource", "wait"]),
		);
		expect(graph.node("item:B2")).toMatchObject({ state: "ongoing", label: "B2 Title B2", source: "items:B2" });
		expect(graph.node("resource:full-run")).toMatchObject({ state: "held", source: "leases:full-run" });
	});

	it("derives each edge kind", () => {
		expect(has(graph, "depends", "item:B3", "item:B2")).toBe(true);
		expect(has(graph, "parent", "item:B2", "item:B1")).toBe(true);
		expect(has(graph, "parent", "step:T1", "item:B2")).toBe(true);
		expect(has(graph, "holds", "agent:sly-mantle", "item:B2")).toBe(true);
		expect(has(graph, "holds", "agent:sly-mantle", "resource:full-run")).toBe(true);
		expect(has(graph, "holds", "job:bash-4", "resource:full-run")).toBe(true);
		expect(has(graph, "serves", "job:bash-4", "item:B2")).toBe(true);
		expect(has(graph, "serves", "agent:sly-mantle", "item:B2")).toBe(true);
		expect(has(graph, "owns", "agent:sly-mantle", "job:bash-4")).toBe(true);
		expect(has(graph, "waits", "wait:#7", "item:B2")).toBe(true);
		expect(has(graph, "blocks", "resource:full-run", "item:B3")).toBe(true);
		expect(new Set(graph.edges.map((edge) => edge.kind))).toEqual(new Set(EDGE_KINDS));
	});

	it("shows an unknown prerequisite as a missing item and drops other edges to unknown nodes", () => {
		expect(graph.node("item:B99")).toMatchObject({ state: "missing" });
		expect(has(graph, "depends", "item:B4", "item:B99")).toBe(true);
		const lone = workGraph({ items: [item("B1", { parent: "B7", holder: "nobody" })] });
		expect(lone.edges).toEqual([]);
	});

	it("does not block the holder with its own resource", () => {
		const own = workGraph({
			items: [item("B1", { holder: "a", state: "ongoing", needs: [nodeId("resource", "full-run")] })],
			agents: [{ name: "a", state: "running" }],
			resources: [{ id: "full-run", label: "lock", owner: "a" }],
		});
		expect(own.edges.some((edge) => edge.kind === "blocks")).toBe(false);
	});

	it("leaves a free resource out and reads out/into by kind", () => {
		expect(workGraph({ resources: [{ id: "lease:x", label: "x" }] }).nodes).toEqual([]);
		expect(graph.out("agent:sly-mantle", "owns")).toHaveLength(1);
		expect(graph.into("item:B2", "serves").map((edge) => edge.from)).toEqual([
			"agent:sly-mantle",
			"job:bash-4",
			"resource:full-run",
		]);
	});

	it("reads no clock and no database", () => {
		const source = fs.readFileSync(new URL("../../src/octocode/graph/model.ts", import.meta.url), "utf8");
		expect(source).not.toMatch(/Date\.now|new Date|performance\.now|node:sqlite|db\/src/);
		expect(source).not.toMatch(/^import /m);
	});

	it("builds 500 items, 20 agents and 50 jobs in under 50 ms", () => {
		const items = Array.from({ length: 500 }, (_, i) =>
			item(`B${i + 1}`, { dependsOn: i > 0 ? [`B${i}`] : [], holder: i < 20 ? `a${i}` : undefined }),
		);
		const agents = Array.from({ length: 20 }, (_, i) => ({ name: `a${i}`, state: "running", item: `B${i + 1}` }));
		const jobs = Array.from({ length: 50 }, (_, i) => ({
			id: `bash-${i}`,
			label: "job",
			state: "running",
			item: `B${i + 1}`,
			agent: `a${i % 20}`,
		}));
		const started = performance.now();
		workGraph({ items, agents, jobs });
		expect(performance.now() - started).toBeLessThan(50);
	});
});

describe("readGraphSources: snapshots from the agent database", () => {
	let root: string;
	let env: NodeJS.ProcessEnv;
	beforeEach(() => {
		root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "octocode-graph-")));
		fs.mkdirSync(path.join(root, "repo", ".git"), { recursive: true });
		env = { ...process.env, OCTOCODE_HOME: path.join(root, "home"), OCTOCODE_AGENT_DB: path.join(root, "agent.db") };
	});
	afterEach(() => {
		closeSharedAgentDb();
		fs.rmSync(root, { recursive: true, force: true });
	});

	it("reads items, steps, a lease, the run lock and job sources into one graph", () => {
		const repoRoot = path.join(root, "repo");
		const agentDb = sharedAgentDb(env);
		const repo = registeredWorkspace(repoRoot, agentDb).id;
		const store = new BacklogStore(() => agentDb, repo);
		const base = { goal: "Observable result", why: "Needed", createdBy: "agent" as const };
		const first = store.add({ ...base, title: "First", state: "todo" });
		store.update(first.ref, { state: "ongoing" }, { id: "sly-mantle", kind: "agent" });
		const second = store.add({ ...base, title: "Second", state: "todo", dependsOn: [first.ref] });
		leases.insert(
			agentDb.db,
			repo,
			"sly-mantle",
			{ path: "src/a.ts", pathKey: "src/a.ts", kind: "file", reason: "edit" },
			1,
			10_000,
		);
		const sources = readGraphSources({
			agentDb,
			store,
			repo,
			root: repoRoot,
			now: 5,
			jobs: [() => [{ id: "bash-1", label: "yarn build", state: "running", item: first.ref, from: "bash-jobs" }]],
			runLock: { label: "vitest", agent: "sly-mantle", item: first.ref, job: "bash-1" },
		});
		const graph = workGraph(sources);
		expect(graph.node(`item:${first.ref}`)).toMatchObject({ state: "ongoing" });
		expect(has(graph, "depends", `item:${second.ref}`, `item:${first.ref}`)).toBe(true);
		expect(has(graph, "holds", "agent:sly-mantle", `item:${first.ref}`)).toBe(true);
		expect(has(graph, "serves", "job:bash-1", `item:${first.ref}`)).toBe(true);
		expect(graph.node("job:bash-1")?.source).toBe("bash-jobs:bash-1");
		expect(graph.node("resource:full-run")?.source).toBe("run-lock:full-run");
		expect(graph.nodes.some((node) => node.id === "resource:lease:src/a.ts")).toBe(true);
	});
});

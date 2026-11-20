import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeSharedAgentDb } from "../../../db/src/api.ts";
import { runBacklogCommand } from "../../src/cli/backlog-command.ts";
import { BacklogStore } from "../../src/octocode/backlog/store.ts";
import { workGraph } from "../../src/octocode/graph/model.ts";
import { linkRows } from "../../src/octocode/graph/running.ts";
import { RunningWork } from "../../src/octocode/shared/running-work.ts";
import { sharedAgentDb } from "../../src/storage/database.ts";
import { registeredWorkspace } from "../../src/storage/workspace-database.ts";

const READY = { goal: "Observable result", why: "Needed", createdBy: "agent" as const };
const AGENT = { id: "sly-mantle", kind: "agent" as const };

let root: string;
let repo: string;
let env: NodeJS.ProcessEnv;
let lockDir: string;

beforeEach(() => {
	root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "octocode-graph-cli-")));
	repo = path.join(root, "repo");
	fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
	lockDir = path.join(root, "lock");
	env = { ...process.env, OCTOCODE_HOME: path.join(root, "home"), OCTOCODE_AGENT_DB: path.join(root, "agent.db") };
	vi.stubEnv("OCTOCODE_HOME", env.OCTOCODE_HOME);
	vi.stubEnv("OCTOCODE_AGENT_DB", env.OCTOCODE_AGENT_DB);
});

afterEach(() => {
	closeSharedAgentDb();
	vi.unstubAllEnvs();
	fs.rmSync(root, { recursive: true, force: true });
});

function board() {
	const db = sharedAgentDb(env);
	return new BacklogStore(() => db, registeredWorkspace(repo, db).id);
}

async function graph(
	args: string[],
	extra: Parameters<typeof runBacklogCommand>[1] extends infer T ? Partial<T> : never = {},
) {
	const out: string[] = [];
	const err: string[] = [];
	const code = await runBacklogCommand(["graph", ...args], {
		cwd: repo,
		env,
		runLockDir: lockDir,
		out: (t) => out.push(t),
		err: (t) => err.push(t),
		...extra,
	});
	return { code, out: out.join("\n"), err: err.join("\n") };
}

function fixture() {
	const store = board();
	const first = store.add({ ...READY, title: "Build the thing", state: "todo" });
	store.update(first.ref, { state: "ongoing" }, AGENT);
	const second = store.add({ ...READY, title: "Ship the thing", state: "todo", dependsOn: [first.ref] });
	fs.mkdirSync(lockDir);
	fs.writeFileSync(
		path.join(lockDir, "owner.json"),
		JSON.stringify({ token: "t", pid: process.pid, label: "vitest", agent: AGENT.id, item: first.ref, job: "bash-4" }),
	);
	const jobs = [() => [{ id: "bash-4", label: "yarn test", state: "running", item: first.ref, agent: AGENT.id }]];
	return { first, second, jobs };
}

describe("octocode backlog graph", () => {
	it("prints item, agent, job and resource as one tree", async () => {
		const { first, second, jobs } = fixture();
		const result = await graph([], { jobs });
		expect(result).toMatchObject({ code: 0, err: "" });
		expect(result.out).toContain(`${first.ref} Build the thing · ongoing`);
		expect(result.out).toMatch(/agent sly-mantle[^\n]*\n\s+job bash-4 · yarn test · holds full-run/);
		expect(result.out).toContain(`${second.ref} Ship the thing · todo\n  after ${first.ref} (ongoing)`);
	});

	it("prints nodes and holds, serves and depends edges as JSON", async () => {
		const { first, second, jobs } = fixture();
		const json = JSON.parse((await graph(["--json"], { jobs })).out) as {
			nodes: Array<{ id: string; source: string }>;
			edges: Array<{ kind: string; from: string; to: string }>;
		};
		const edge = (kind: string, from: string, to: string) =>
			json.edges.some((e) => e.kind === kind && e.from === from && e.to === to);
		expect(json.nodes.map((node) => node.id)).toEqual(
			expect.arrayContaining([
				`item:${first.ref}`,
				`item:${second.ref}`,
				"agent:sly-mantle",
				"job:bash-4",
				"resource:full-run",
			]),
		);
		expect(edge("holds", "agent:sly-mantle", `item:${first.ref}`)).toBe(true);
		expect(edge("serves", "job:bash-4", `item:${first.ref}`)).toBe(true);
		expect(edge("depends", `item:${second.ref}`, `item:${first.ref}`)).toBe(true);
		expect(edge("holds", "job:bash-4", "resource:full-run")).toBe(true);
	});

	it("limits the output to one item and refuses an unknown one", async () => {
		const { first, second, jobs } = fixture();
		const one = await graph(["--item", first.ref], { jobs });
		expect(one.out).toContain(first.ref);
		expect(one.out).not.toContain(second.ref);
		const json = JSON.parse((await graph(["--json", "--item", second.ref], { jobs })).out) as {
			nodes: Array<{ id: string }>;
		};
		expect(json.nodes.map((node) => node.id).toSorted()).toEqual([`item:${first.ref}`, `item:${second.ref}`]);
		const missing = await graph(["--item", "B99"]);
		expect(missing).toMatchObject({ code: 1, err: "No backlog item B99." });
	});

	it("changes nothing and reports an idle workspace plainly", async () => {
		const store = board();
		store.add({ ...READY, title: "Idle", state: "todo" });
		const before = store.list({ states: ["backlog", "todo", "ongoing", "done"] }).items;
		expect((await graph([])).out).toBe("Nothing runs and nothing waits.");
		expect(store.list({ states: ["backlog", "todo", "ongoing", "done"] }).items).toEqual(before);
		expect((await graph(["extra"])).code).toBe(1);
	});

	it("ignores a lock whose holder is gone", async () => {
		board();
		fs.mkdirSync(lockDir);
		fs.writeFileSync(
			path.join(lockDir, "owner.json"),
			JSON.stringify({ token: "t", pid: 2 ** 22 + 12345, label: "old" }),
		);
		expect((await graph(["--json"])).out).not.toContain("full-run");
	});
});

describe("running-work rows name their item and resource", () => {
	it("adds the item a job serves and the resource it holds", () => {
		const work = new RunningWork();
		work.set("bash", [{ kind: "bash", id: "bash-4", title: "yarn test" }]);
		const g = workGraph({
			items: [{ ref: "B7", title: "t", state: "ongoing", priority: 2, createdAt: 1, dependsOn: [] }],
			jobs: [{ id: "bash-4", label: "yarn test", state: "running", item: "B7" }],
			resources: [{ id: "full-run", label: "lock", owner: "a", job: "bash-4" }],
			agents: [{ name: "a", state: "running" }],
		});
		expect(linkRows(work.all(), g)).toEqual([
			{ kind: "bash", id: "bash-4", title: "yarn test", item: "B7", resource: "full-run" },
		]);
	});
});

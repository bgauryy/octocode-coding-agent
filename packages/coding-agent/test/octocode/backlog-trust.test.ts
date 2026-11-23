import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openAgentDb, sharedAgentDb } from "../../src/storage/database.ts";
import { closeSharedAgentDb, type AgentDb } from "../../../db/src/api.ts";
import type { BacklogStore } from "../../src/octocode/backlog/store.ts";
import { checkMerged } from "../../src/octocode/backlog/merge-gate.ts";
import { ongoingBrief } from "../../src/octocode/sessions/brief.ts";
import { planningRefusal } from "../../src/octocode/plan/gate.ts";
import { registerBacklog } from "../../src/octocode/backlog/index.ts";
import { openBacklog } from "../../src/octocode/backlog/context.ts";
import { Subcommands } from "../../src/octocode/shared/commands.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { fixtureBacklog } from "./backlog-fixture.ts";
import { tmp } from "./helpers.ts";

let dir: string;
let db: AgentDb;
let store: BacklogStore;
const agent = { id: "session-a", kind: "agent" as const };
const add = (title: string, fields = {}) =>
	store.add({ title, why: "Users need this", goal: "Result can be checked", createdBy: "user", ...fields });

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "backlog-trust-"));
	db = openAgentDb(path.join(dir, "db"));
	store = fixtureBacklog(() => db, "repo");
});
afterEach(() => {
	closeSharedAgentDb();
	db.close();
	vi.unstubAllEnvs();
	fs.rmSync(dir, { recursive: true, force: true });
});

describe("completion gate and git", () => {
	const linked = { links: [{ relation: "output", target: "refs/octocode/abc" }], ref: "B1" } as never;

	// `checkMerged` is asynchronous (contract change): git runs before the write, outside its database transaction.
	it("refuses completion, naming git, when git cannot answer instead of treating the ref as absent", async () => {
		vi.stubEnv("PATH", path.join(dir, "empty"));
		await expect(checkMerged({ repoRoot: dir }, linked)).rejects.toThrow(/git could not check/);
	});

	it("treats a ref git reports missing as merged or discarded", async () => {
		const repo = path.join(dir, "repo");
		fs.mkdirSync(repo);
		await expect(checkMerged({ repoRoot: repo }, linked)).rejects.toThrow(/git could not check/);
		// A repository where the ref is simply absent lets the item complete.
		fs.writeFileSync(path.join(repo, ".gitkeep"), "");
		execFileSync("git", ["init", "-q", repo]);
		await expect(checkMerged({ repoRoot: repo }, linked)).resolves.toEqual(["refs/octocode/abc"]);
	});
});

it("lists every ongoing item the session still claims in the resume brief", () => {
	const refs = Array.from({ length: 25 }, (_, index) => {
		const item = add(`Item ${index}`, { state: "todo" });
		store.update(item.ref, { state: "ongoing" }, agent);
		return item.ref;
	});
	const text = ongoingBrief(db, "repo", agent.id).join("\n");
	for (const ref of refs) expect(text).toContain(ref);
});

describe("moving a step between owners", () => {
	it("refuses handing an ongoing step to an owner that already has one ongoing for the same actor", () => {
		const a = add("A", { state: "todo" });
		const b = add("B", { state: "todo" });
		store.update(a.ref, { state: "ongoing" }, agent);
		store.update(b.ref, { state: "ongoing" }, agent);
		const first = store.tasks.add({ goal: "one", item: a.ref }, agent);
		const second = store.tasks.add({ goal: "two", item: b.ref }, agent);
		store.tasks.update(first.ref, { state: "ongoing" }, agent);
		store.tasks.update(second.ref, { state: "ongoing" }, agent);
		expect(() => store.tasks.reparent(first.ref, { item: b.ref }, agent)).toThrow(/still ongoing/);
		expect(store.tasks.get(first.ref)!.owner).toMatchObject({ ref: a.ref });
	});
});

describe("plan mode and backlog reads", () => {
	const definition = { name: "x", sourceInfo: { path: "<inline:octocode>", owner: "native" } } as never;
	const refusal = (toolName: string, input: Record<string, unknown>) =>
		planningRefusal({ toolName, input }, definition);

	it("allows get, list and stat and blocks every write", () => {
		expect(refusal("backlog", { op: "get", id: "B1" })).toBeUndefined();
		expect(refusal("backlogPlan", { op: "list" })).toBeUndefined();
		expect(refusal("backlogPlan", { op: "stat" })).toBeUndefined();
		for (const op of ["claim", "note", "done", "close", "step"])
			expect(refusal("backlog", { op })).toContain("Plan mode blocks");
		for (const op of ["add", "edit"]) expect(refusal("backlogPlan", { op })).toContain("Plan mode blocks");
		expect(refusal("backlog", {})).toContain("Plan mode blocks");
	});
});

it("reports which entries a cancelled backlog write batch applied", async () => {
	const root = tmp("octocode-backlog-trust-");
	const env = {
		...process.env,
		HOME: path.join(root, "home"),
		OCTOCODE_HOME: path.join(root, "home"),
		OCTOCODE_AGENT_DB: path.join(root, "agent.db"),
	};
	const cwd = path.join(root, "repo");
	fs.mkdirSync(cwd);
	const ctx = fakeCtx({ cwd, hasUI: true });
	const fake = fakeHost();
	const options = { commands: new Subcommands(), isSubagent: false, env, changed: vi.fn() };
	registerBacklog(fake.api, options);
	const opened = openBacklog(ctx, options).store;
	const first = opened.add({ title: "First", why: "w", goal: "g", createdBy: "user", state: "todo" });
	const second = opened.add({ title: "Second", why: "w", goal: "g", createdBy: "user", state: "todo" });
	const controller = new AbortController();
	const unsubscribe = sharedAgentDb(env).onCommit(() => {
		if (opened.get(first.ref)?.state === "ongoing") controller.abort();
	});
	try {
		await expect(
			fake.tools.get("backlog")!.execute(
				"batch",
				{
					op: "claim",
					items: [
						{ id: first.ref, why: "w", goal: "g" },
						{ id: second.ref, why: "w", goal: "g" },
					],
				},
				controller.signal,
				undefined,
				ctx,
			),
		).rejects.toMatchObject({ name: "AbortError", result: { details: { applied: 1, notAttempted: 1 } } });
	} finally {
		unsubscribe();
	}
	expect(opened.get(second.ref)!.state).toBe("todo");
});

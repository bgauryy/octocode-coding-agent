import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { READ_ONLY_ENV, SUBAGENT_ENV } from "@octocodeai/octocode-common/env";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { closeSharedAgentDb } from "../../../db/src/api.ts";
import { runBacklogCommand } from "../../src/cli/backlog-command.ts";
import { BacklogStore } from "../../src/octocode/backlog/store.ts";
import { readOnlyRoleRefusal } from "../../src/octocode/permission/read-only-role.ts";
import { shellParserReady } from "../../src/octocode/permission/shell/mutation.ts";
import { registerBacklogPlanTool } from "../../src/octocode/native/tools/backlog-plan/tool.ts";
import { registerBacklogTool } from "../../src/octocode/native/tools/backlog/tool.ts";
import { workspaceDb } from "../../src/storage/workspace-database.ts";
import { fakeHost } from "./fake-host.ts";

const CHILD = { [SUBAGENT_ENV]: "1", [READ_ONLY_ENV]: "1" };

let root: string;
let repo: string;
let env: NodeJS.ProcessEnv;

beforeAll(shellParserReady);

beforeEach(() => {
	root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "octocode-backlog-cli-")));
	repo = path.join(root, "repo");
	fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
	env = { ...process.env, OCTOCODE_HOME: path.join(root, "home"), OCTOCODE_AGENT_DB: path.join(root, "agent.db") };
	vi.stubEnv("OCTOCODE_HOME", env.OCTOCODE_HOME);
	vi.stubEnv("OCTOCODE_AGENT_DB", env.OCTOCODE_AGENT_DB);
});

afterEach(() => {
	closeSharedAgentDb();
	vi.unstubAllEnvs();
	fs.rmSync(root, { recursive: true, force: true });
});

function seed(): BacklogStore {
	const store = new BacklogStore(() => workspaceDb(repo, env).agent, workspaceDb(repo, env).workspace.id);
	store.add({ title: "Docs sweep", goal: "Fix stale docs", why: "Required work", state: "todo", createdBy: "agent" });
	store.add({ title: "Cache audit", goal: "Check cache", why: "Required work", state: "todo", createdBy: "agent" });
	return store;
}

async function run(...args: string[]): Promise<{ code: number; out: string; err: string }> {
	const out: string[] = [];
	const err: string[] = [];
	const code = await runBacklogCommand(args, {
		cwd: repo,
		env,
		out: (text) => out.push(text),
		err: (text) => err.push(text),
	});
	return { code, out: out.join("\n"), err: err.join("\n") };
}

describe("a child reads the board through `octocode backlog`", () => {
	it("prints an item by id and changes nothing", async () => {
		const store = seed();
		const before = store.get(1);
		const result = await run("get", "B1");
		expect(result.code).toBe(0);
		expect(result.out).toContain("Docs sweep");
		expect(result.out).toContain("Fix stale docs");
		expect(result.out).not.toContain("Cache audit");
		expect(store.get(1)).toEqual(before);
	});

	it("lists the open items and filters them by text and state", async () => {
		seed();
		const all = await run("list");
		expect(all.out).toContain("Docs sweep");
		expect(all.out).toContain("Cache audit");
		const found = await run("list", "--query", "cache");
		expect(found.out).toContain("Cache audit");
		expect(found.out).not.toContain("Docs sweep");
		const none = await run("list", "--states", "done");
		expect(none.out).toMatch(/No done items/);
	});

	it("pages a list with a repeatable offset", async () => {
		seed();
		const first = await run("list", "--limit", "1");
		expect(first.out).toContain("--offset 1");
		const second = await run("list", "--limit", "1", "--offset", "1");
		const titles = (text: string) => ["Docs sweep", "Cache audit"].filter((title) => text.includes(title));
		expect(titles(first.out)).toHaveLength(1);
		expect(titles(second.out)).toHaveLength(1);
		expect(titles(second.out)).not.toEqual(titles(first.out));
	});

	it("writes the Markdown board to a file", async () => {
		seed();
		const file = path.join(root, "out", "board.md");
		const result = await run("export", file);
		expect(result.code).toBe(0);
		expect(fs.readFileSync(file, "utf8")).toContain("Docs sweep");
	});

	it("fails on an unknown item, bad options and a missing board without creating one", async () => {
		seed();
		expect((await run("get", "B99")).err).toContain("No backlog item");
		expect((await run("get")).code).toBe(1);
		expect((await run("list", "--states", "nonsense")).code).toBe(1);
		expect((await run("list", "--limit", "x")).code).toBe(1);
		expect((await run("frobnicate")).code).toBe(1);
		closeSharedAgentDb();
		fs.rmSync(env.OCTOCODE_AGENT_DB as string, { force: true });
		const missing = await run("list");
		expect(missing.code).toBe(1);
		expect(fs.existsSync(env.OCTOCODE_AGENT_DB as string)).toBe(false);
	});
});

describe("a read-only child's shell", () => {
	const refusal = (command: string) => readOnlyRoleRefusal({ toolName: "bash", input: { command } }, repo, CHILD);

	it.each([
		"octocode backlog get B1",
		"octocode backlog list --query docs --states todo",
		"octocode backlog get B1 | head -20",
	])("may run %s", (command) => {
		expect(refusal(command)).toBeUndefined();
	});

	it.each([
		"octocode",
		"octocode backlog",
		"octocode backlog export board.md",
		"octocode --model x backlog get B1",
		"octocode backlog get B1 && octocode",
		"octocode-cli backlog get B1",
	])("still refuses %s", (command) => {
		expect(refusal(command)).toContain("`octocode");
	});
});

describe("a read-only child's backlogPlan calls", () => {
	const refusal = (input: Record<string, unknown>, env: NodeJS.ProcessEnv = CHILD) =>
		readOnlyRoleRefusal({ toolName: "backlogPlan", input }, repo, env);

	it("may list and count items", () => {
		expect(refusal({ op: "list", query: "docs" })).toBeUndefined();
		expect(refusal({ op: "stat" })).toBeUndefined();
	});

	it("may not add or edit items, which a writing child may", () => {
		expect(refusal({ op: "add", items: [{ title: "t", goal: "g", why: "w" }] })).toContain("read-only role");
		expect(refusal({ op: "edit", items: [{ id: "B1", priority: "p0" }] })).toContain("read-only role");
		expect(refusal({ op: "add", items: [] }, { [SUBAGENT_ENV]: "1" })).toBeUndefined();
	});
});

describe("the board tools", () => {
	it("stay out of every child's tool list unless its task names an item", () => {
		for (const env of [CHILD, { [SUBAGENT_ENV]: "1" }]) {
			const host = fakeHost();
			registerBacklogTool(host.api, { isSubagent: true, env });
			registerBacklogPlanTool(host.api, { isSubagent: true, env });
			expect(host.api.tools.getActive()).toEqual([]);
		}
	});
});

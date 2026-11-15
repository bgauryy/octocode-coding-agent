import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { agents, closeSharedAgentDb } from "../../../db/src/api.ts";
import { holdWrite } from "../../../db/test/hold-write.ts";
import { sharedAgentDb } from "../../src/storage/database.ts";
import { openBacklog } from "../../src/octocode/backlog/context.ts";
import { registerBacklog } from "../../src/octocode/backlog/index.ts";
import { Subcommands } from "../../src/octocode/shared/commands.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";

let root: string;
let env: NodeJS.ProcessEnv;
const holders: Awaited<ReturnType<typeof holdWrite>>[] = [];
beforeEach(() => {
	root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "octocode-backlog-ready-")));
	env = {
		HOME: path.join(root, "home"),
		OCTOCODE_HOME: path.join(root, "home"),
		OCTOCODE_AGENT_DB: path.join(root, "agent.db"),
	};
});
afterEach(async () => {
	for (const holder of holders.splice(0)) await holder.close();
	closeSharedAgentDb();
	fs.rmSync(root, { recursive: true, force: true });
});

function setup() {
	const cwd = path.join(root, "repo");
	fs.mkdirSync(cwd);
	const fake = fakeHost();
	const options = { commands: new Subcommands(), isSubagent: false, env };
	registerBacklog(fake.api, options);
	const ctx = fakeCtx({ cwd });
	const agent = sharedAgentDb(env);
	agents.setBusyTimeout(agent.db, 200);
	const call = async (name: string, args: Record<string, unknown>, signal?: AbortSignal) => {
		const result = await fake.tools.get(name).execute("fixture", args, signal, undefined, ctx);
		return result.content[0].text as string;
	};
	return { fake, agent, call, store: () => openBacklog(ctx, options).store };
}
const entry = (title: string) => ({
	title,
	why: "Verify the owned fixture",
	goal: "Preserve native mutation semantics",
});

it("yields during a warm native write, then applies its note exactly once", async () => {
	const { agent, call, store } = setup();
	await call("backlogPlan", { op: "add", ...entry("Warm fixture") });
	const holder = await holdWrite(agent.file);
	holders.push(holder);
	let released = false;
	const timer = setTimeout(() => {
		released = true;
		holder.release();
	}, 10);
	try {
		expect(await call("backlog", { op: "note", id: "B1", note: "One owned note" })).toMatch(/^Updated B1/);
	} finally {
		clearTimeout(timer);
	}
	expect(released).toBe(true);
	expect(
		store()
			.comments("B1")
			.filter((comment) => comment.text === "One owned note"),
	).toHaveLength(1);
});

it("awaits the first workspace metadata write on an already open database", async () => {
	const { agent, call, store } = setup();
	const holder = await holdWrite(agent.file);
	holders.push(holder);
	let released = false;
	const timer = setTimeout(() => {
		released = true;
		holder.release();
	}, 10);
	try {
		await call("backlogPlan", { op: "add", ...entry("First registration") });
	} finally {
		clearTimeout(timer);
	}
	expect(released).toBe(true);
	expect(store().list().total).toBe(1);
});

it("keeps registered get and list shared and readable under another writer", async () => {
	const { agent, call, fake } = setup();
	await call("backlogPlan", { op: "add", ...entry("Read fixture") });
	// Let the seed's scheduled history housekeeping finish before observing only the reads.
	await new Promise((resolve) => setImmediate(resolve));
	const commits = vi.fn();
	agent.onCommit(commits);
	const holder = await holdWrite(agent.file);
	holders.push(holder);
	expect(fake.tools.get("backlog").concurrency({ op: "get" })).toBe("shared");
	expect(fake.tools.get("backlogPlan").concurrency({ op: "list" })).toBe("shared");
	expect(await call("backlog", { op: "get", id: "B1" })).toContain("Read fixture");
	expect(await call("backlogPlan", { op: "list" })).toContain("Read fixture");
	expect(commits).not.toHaveBeenCalled();
});

it("commits each successful batch entry and preserves actor and refused-entry rollback", async () => {
	const { agent, call, store } = setup();
	await call("backlogPlan", { op: "add", ...entry("Seed") });
	const commits = vi.fn();
	agent.onCommit(commits);
	const result = await call("backlogPlan", {
		op: "add",
		items: [entry("First"), { title: "Refused", why: "missing goal" }, entry("Last")],
	});
	expect(result).toMatch(/^Added 2 of 3; 1 refused/);
	expect(commits).toHaveBeenCalledTimes(2);
	expect(
		store()
			.list()
			.items.map((item) => item.title)
			.sort(),
	).toEqual(["First", "Last", "Seed"]);
	expect(
		store()
			.audit("B2")
			.map((row) => row.actor.id),
	).toEqual(["session-test"]);
	expect(
		store()
			.audit("B3")
			.map((row) => row.actor.id),
	).toEqual(["session-test"]);
});

it("aborts a waiting native mutation without applying it", async () => {
	const { agent, call, store } = setup();
	await call("backlogPlan", { op: "add", ...entry("Abort fixture") });
	const holder = await holdWrite(agent.file);
	holders.push(holder);
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 10);
	try {
		await expect(
			call("backlog", { op: "note", id: "B1", note: "Must not apply" }, controller.signal),
		).rejects.toMatchObject({ name: "AbortError" });
	} finally {
		clearTimeout(timer);
	}
	expect(store().comments("B1")).toHaveLength(0);
});

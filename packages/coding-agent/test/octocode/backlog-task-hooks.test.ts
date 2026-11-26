import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeSharedAgentDb } from "../../../db/src/api.ts";
import { registeredWorkspace, workspaceDb } from "../../src/storage/workspace-database.ts";
import { registerBacklog } from "../../src/octocode/backlog/index.ts";
import type { CompletionInfo } from "../../src/octocode/backlog/completion-gate.ts";
import { BacklogStore } from "../../src/octocode/backlog/store.ts";
import { emptyHooks } from "../../src/octocode/hooks/config/parse.ts";
import { registerBacklogHooks } from "../../src/octocode/hooks/register/backlog.ts";
import type { HookSession } from "../../src/octocode/hooks/register/types.ts";
import { BACKLOG_CHANGE_CHANNEL, type BacklogChange } from "../../src/octocode/shared/backlog-change.ts";
import { Subcommands } from "../../src/octocode/shared/commands.ts";
import { backlogToolName } from "./backlog-fixture.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";

let tmp: string;
let saved: string | undefined;
beforeEach(() => {
	tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "octo-task-hooks-")));
	saved = process.env.OCTOCODE_AGENT_DB;
	process.env.OCTOCODE_AGENT_DB = path.join(tmp, "home", "octocode.db");
});
afterEach(() => {
	closeSharedAgentDb();
	if (saved === undefined) delete process.env.OCTOCODE_AGENT_DB;
	else process.env.OCTOCODE_AGENT_DB = saved;
	fs.rmSync(tmp, { recursive: true, force: true });
});

describe("TaskCompleted gates the done write in the writing process (S4)", () => {
	const setup = (completing: (info: CompletionInfo) => Promise<string | undefined>) => {
		const fake = fakeHost();
		registerBacklog(fake.api, { commands: new Subcommands(), isSubagent: false, completing });
		const cwd = path.join(tmp, "repo");
		fs.mkdirSync(cwd, { recursive: true });
		const ctx = fakeCtx({ cwd, idle: false });
		const call = async (params: Record<string, unknown>) =>
			(
				(await fake.tools
					.get(backlogToolName(params.op))
					.execute("id", { reason: "test", ...params }, undefined, undefined, ctx)) as {
					content: Array<{ text: string }>;
				}
			).content[0].text;
		const store = () => new BacklogStore(() => workspaceDb(cwd).agent, registeredWorkspace(cwd).id);
		return { call, store };
	};
	const READY = { goal: "Result can be checked", why: "Users need it" };

	it("refuses the write with the hook's reason and leaves the item as it was", async () => {
		const asked: CompletionInfo[] = [];
		const t = setup(async (info) => {
			asked.push(info);
			return "tests not green";
		});
		await t.call({ op: "add", items: [{ ...READY, title: "Gated", state: "todo" }] });
		await t.call({ op: "claim", id: "B1" });
		await expect(
			t.call({ op: "close", id: "B1", close: { kind: "obsolete", text: "no longer needed" } }),
		).rejects.toThrow(/tests not green/);
		// The store's own refusals now run before the hooks (contract change), so this completion names a passed check: the
		// hook, not the store, refuses it.
		await expect(
			t.call({
				op: "done",
				id: "B1",
				completion: { summary: "did it", verification: "passed: ran the check", files: [] },
			}),
		).rejects.toThrow(/tests not green/);
		expect(t.store().get("B1")?.state).toBe("ongoing");
		expect(asked.map((info) => [info.ref, info.change])).toEqual([
			["B1", "closed"],
			["B1", "done"],
		]);
	});

	it("lets the write through when no hook refuses", async () => {
		const t = setup(async () => undefined);
		await t.call({ op: "add", items: [{ ...READY, title: "Open", state: "todo" }] });
		await t.call({ op: "claim", id: "B1" });
		await t.call({ op: "close", id: "B1", close: { kind: "obsolete", text: "no longer needed" } });
		expect(t.store().get("B1")?.state).toBe("done");
	});
});

describe("backlog hook events (S4)", () => {
	const change = (kind: BacklogChange["kind"]): BacklogChange => ({
		id: 1,
		ref: "B7",
		kind,
		by: "peer",
		paths: [],
		beforePaths: [],
		title: "T",
	});
	const setup = (events: Array<keyof ReturnType<typeof emptyHooks>>, verdict: { block?: string } = {}) => {
		const fake = fakeHost();
		const session: HookSession = { config: emptyHooks(), errors: [], root: undefined };
		for (const event of events) session.config[event] = [{ hooks: [{ timeoutMs: 1000 }] }] as never;
		const calls: Array<{ event: string; names: string[]; input: Record<string, unknown> }> = [];
		const dispatch = (async (_ctx: unknown, event: string, names: string[], input: () => Record<string, unknown>) => {
			calls.push({ event, names, input: input() });
			return verdict;
		}) as never;
		// The fake host's channels are inert: a small real one carries the announcements.
		const listeners: Array<(value: unknown) => void> = [];
		const api = {
			...fake.api,
			channels: {
				on: (_name: string, listener: (value: unknown) => void) => (listeners.push(listener), () => undefined),
				emit: (_name: string, value: unknown) => listeners.forEach((listener) => listener(value)),
			},
		};
		const taskCompleted = registerBacklogHooks(api, session, { dispatch, reportFailure: () => undefined });
		const ctx = fakeCtx({ cwd: tmp, idle: true });
		const emit = (value: BacklogChange, own: boolean) =>
			api.channels.emit(BACKLOG_CHANGE_CHANNEL, { change: value, own });
		return {
			fake,
			ctx,
			calls,
			taskCompleted,
			emit,
			start: () => fake.fire("session_start", { type: "session_start", reason: "startup" }, ctx),
		};
	};
	const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

	it("runs BacklogChange for every change by its kind, and TaskCreated only for items this process added", async () => {
		const t = setup(["BacklogChange", "TaskCreated"]);
		await t.start();
		t.emit(change("created"), false);
		t.emit(change("created"), true);
		t.emit(change("done"), false);
		await settle();
		expect(t.calls.map((call) => [call.event, call.names[0], call.input.own])).toEqual([
			["BacklogChange", "created", false],
			["TaskCreated", "created", true],
			["BacklogChange", "created", true],
			["BacklogChange", "done", false],
		]);
		expect(t.calls[0].input).toMatchObject({ task_id: "B7", change: "created", by: "peer", task_subject: "T" });
	});

	it("runs nothing for events no hook is configured for", async () => {
		const t = setup([]);
		await t.start();
		t.emit(change("done"), false);
		await settle();
		expect(t.calls).toHaveLength(0);
		expect(await t.taskCompleted({ ref: "B7", title: "T", goal: "g", change: "done" }, t.ctx)).toBeUndefined();
		expect(t.calls).toHaveLength(0);
	});

	it("answers a blocking TaskCompleted hook's reason, with the item in its input", async () => {
		const t = setup(["TaskCompleted"], { block: "needs review" });
		const reason = await t.taskCompleted(
			{ ref: "B7", title: "T", goal: "g", assignee: "me", change: "done", completion: { summary: "s" } },
			t.ctx,
		);
		expect(reason).toBe("needs review");
		expect(t.calls[0]).toMatchObject({ event: "TaskCompleted", names: ["done"] });
		expect(t.calls[0].input).toMatchObject({ task_id: "B7", task_description: "g", teammate_name: "me" });
	});
});

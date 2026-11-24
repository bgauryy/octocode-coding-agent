import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import * as importedModule1 from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type SessionInfo, SessionManager } from "../../src/core/session-manager.ts";
import type { SessionPickerOptions } from "../../src/core/session-picker.ts";
import { agents, closeSharedAgentDb, sessions } from "../../../db/src/api.ts";
import { sharedAgentDb, sharedAgentDbWriter } from "../../src/storage/database.ts";
import { BacklogStore } from "../../src/octocode/backlog/store.ts";
import { resumeBrief, shortDuration } from "../../src/octocode/sessions/brief.ts";
import { RESUME_MESSAGE_TYPE, RUNNING_WORK_TYPE, registerSessions } from "../../src/octocode/sessions/register.ts";
import * as sessionStore from "../../src/octocode/sessions/store.ts";
import { SessionIndex } from "../../src/octocode/sessions/store.ts";
import { describeWork, unreportedWork } from "../../src/octocode/sessions/work.ts";
import { pendingReportsDir, savePendingReport } from "../../src/octocode/subagents/handoff/pending.ts";
import { Subcommands } from "../../src/octocode/shared/commands.ts";
import { sessionDir, sessionsRoot, setCurrentSession } from "../../src/octocode/shared/home.ts";
import { processStartTime } from "../../src/octocode/shared/process.ts";
import { fakeCtx, fakeHost, rendered, theme } from "./fake-host.ts";
import { tmp } from "./helpers.ts";
import { registeredWorkspace } from "../../src/storage/workspace-database.ts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

let saved: { home?: string; db?: string };
let home: string;
let cwd: string;

beforeEach(() => {
	saved = { home: process.env.OCTOCODE_HOME, db: process.env.OCTOCODE_AGENT_DB };
	home = tmp();
	cwd = tmp();
	process.env.OCTOCODE_HOME = home;
	delete process.env.OCTOCODE_AGENT_DB;
	// Octocode's own session listing would read the real session directories: tests give it per case.
	listedSessions = [];
	vi.spyOn(SessionManager, "list").mockImplementation(async () => listedSessions);
	vi.spyOn(SessionManager, "listAll").mockImplementation(async () => listedSessions);
});

let listedSessions: SessionInfo[] = [];

afterEach(() => {
	vi.restoreAllMocks();
	closeSharedAgentDb();
	setCurrentSession(undefined);
	for (const [key, value] of [
		["OCTOCODE_HOME", saved.home],
		["OCTOCODE_AGENT_DB", saved.db],
	] as const) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

type Entry = {
	type: string;
	id: string;
	timestamp?: string;
	message?: Record<string, unknown>;
	customType?: string;
	details?: unknown;
};

/** An Octocode host with the sessions feature and a session the test can shape. */
function setup(options: { id?: string; entries?: Entry[]; hasUI?: boolean; name?: string; subagent?: boolean } = {}) {
	const fake = fakeHost();
	const names: string[] = [];
	const switched: string[] = [];
	Object.assign(fake.api, {
		setSessionName: (name: string) => names.push(name),
		getSessionName: () => names.at(-1) ?? options.name,
	});
	const commands = new Subcommands();
	registerSessions(fake.api, { commands, isSubagent: options.subagent ?? false, filesChanged: () => 3 });
	if (!options.subagent) commands.register(fake.api);
	const id = options.id ?? "sess-1";
	const file = path.join(tmp(), `${id}.jsonl`);
	fs.writeFileSync(file, "{}\n");
	const entries = options.entries ?? [];
	const ctx = fakeCtx({ cwd, hasUI: options.hasUI ?? true });
	Object.assign(ctx, {
		sessionManager: {
			getSessionId: () => id,
			getSessionFile: () => file,
			getSessionDir: () => path.dirname(file),
			getSessionName: () => options.name,
			getEntries: () => entries,
			getBranch: () => entries,
		},
		switchSession: async (target: string) => {
			switched.push(target);
			return { cancelled: false };
		},
	});
	const start = async (reason = "startup") => {
		setCurrentSession(id);
		await fake.fire("session_start", { type: "session_start", reason }, ctx);
	};
	return {
		...fake,
		hostCommands: fake.commands,
		commands,
		ctx,
		id,
		file,
		entries,
		names,
		switched,
		start,
		index: () => new SessionIndex(sharedAgentDb()),
	};
}

const row = (id: string) => new SessionIndex(sharedAgentDb()).get(id);
/** Lets a git result reach the database writer (the per-turn writes go through it), then waits for its commit. */
const written = async () => {
	await new Promise((resolve) => setImmediate(resolve));
	await sharedAgentDbWriter().drain(5_000);
};
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

describe("session extras", () => {
	it("records only what Octocode does not know: live pid, cost, tokens and files changed, keyed by session id", async () => {
		const usage = (total: number, tokens: number) => ({
			input: tokens,
			output: 0,
			totalTokens: tokens,
			cost: { total },
		});
		// A subagent's usage rides its `agent` tool result: it counts, as in the footer.
		// A background subagent's report carries its run's usage in `details.usage`: it counts too.
		const { fire, ctx, start, id, file } = setup({
			entries: [
				{ type: "message", id: "a0", message: { role: "assistant", usage: usage(0.25, 15) } },
				{ type: "message", id: "t0", message: { role: "toolResult", usage: usage(1, 100) } },
				{
					type: "custom_message",
					id: "r0",
					customType: "octocode-agent-result",
					details: { id: "bg", usage: usage(4, 400) },
				},
			],
		});
		await start();
		expect(row(id)).toEqual({
			id,
			workspace_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
			branch: null,
			head: null,
			cost: 0,
			tokens: 0,
			files_changed: 0,
			pid: process.pid,
			pid_started: processStartTime(process.pid) ?? null,
			unpriced: 0,
			dir: path.dirname(file),
			// The light of the process that has it open (contract change, RFC app-state T4): idle at the start.
			activity: "idle",
		});
		// Totals are read once at start, then each reply adds its usage: agent_end does not rescan the session.
		await fire("message_end", { type: "message_end", message: { role: "assistant", usage: usage(0.5, 25) } }, ctx);
		await fire("message_end", { type: "message_end", message: { role: "user", usage: usage(9, 9) } }, ctx);
		await fire("message_end", { type: "message_end", message: { role: "toolResult", usage: usage(2, 200) } }, ctx);
		await fire("agent_end", { type: "agent_end", messages: [] }, ctx);
		await fire(
			"message_end",
			{
				type: "message_end",
				message: {
					role: "custom",
					customType: "octocode-agent-result",
					details: { id: "bg2", usage: usage(1, 60) },
				},
			},
			ctx,
		);
		await fire("agent_end", { type: "agent_end", messages: [] }, ctx);
		expect(row(id)).toMatchObject({ tokens: 800, cost: 8.75, files_changed: 3, unpriced: 0 });
		// A subagent result that ran partly on a model without pricing marks the session.
		await fire(
			"message_end",
			{ type: "message_end", message: { role: "toolResult", usage: usage(0.1, 10), details: { unpriced: true } } },
			ctx,
		);
		await fire("agent_end", { type: "agent_end", messages: [] }, ctx);
		expect(row(id)).toMatchObject({ unpriced: 1 });
		await fire("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);
		expect(row(id)?.pid).toBeNull();
		// A fresh start says nothing.
		expect(await fire("before_agent_start", { type: "before_agent_start", prompt: "x" }, ctx)).toBeUndefined();
	});

	it("never names the session: Octocode owns names", async () => {
		const { fire, ctx, start, names, entries } = setup();
		await start();
		entries.push({ type: "message", id: "u1", message: { role: "user" } });
		await fire("agent_end", { type: "agent_end", messages: [] }, ctx);
		expect(names).toEqual([]);
	});

	it("records the git branch and HEAD without blocking the event", async () => {
		const run = (...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe", encoding: "utf8" });
		run("init", "-q", "-b", "main");
		run("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "one");
		const host = setup({ id: "sess-git" });
		await host.start();
		await vi.waitFor(() =>
			expect(row("sess-git")).toMatchObject({ branch: "main", head: run("rev-parse", "HEAD").trim() }),
		);
		run("checkout", "-q", "-b", "feature");
		await host.fire("agent_end", { type: "agent_end", messages: [] }, host.ctx);
		await vi.waitFor(() => expect(row("sess-git")?.branch).toBe("feature"));
	});

	it("records checkout and custom session directories so temporarily unavailable sessions survive housekeeping", async () => {
		const savedAgentDir = process.env.OCTOCODE_CODING_AGENT_DIR;
		process.env.OCTOCODE_CODING_AGENT_DIR = tmp();
		try {
			const custom = setup({ id: "sess-custom" });
			await custom.start();
			expect(custom.index().sessionDirs()).toEqual([path.dirname(custom.file)]);
			// Each session records the dir it runs from: the sweep keeps it while that dir cannot be read.
			expect(custom.index().get("sess-custom")?.dir).toBe(path.dirname(custom.file));
			const plain = setup({ id: "sess-default" });
			const defaultDir = path.join(plain.ctx.cwd, ".octocode", "agent", "sessions");
			Object.assign(plain.ctx.sessionManager, { getSessionDir: () => defaultDir });
			await plain.start();
			expect(plain.index().sessionDirs()).toEqual([path.dirname(custom.file), defaultDir]);
			expect(plain.index().get("sess-default")?.dir).toBe(defaultDir);
		} finally {
			if (savedAgentDir === undefined) delete process.env.OCTOCODE_CODING_AGENT_DIR;
			else process.env.OCTOCODE_CODING_AGENT_DIR = savedAgentDir;
		}
	});

	it("ignores git results after shutdown and older results that finish last", async () => {
		const requests: Array<(state: { branch: string }) => void> = [];
		vi.spyOn(sessionStore, "gitState").mockImplementation(() => new Promise((resolve) => requests.push(resolve)));
		const host = setup();
		await host.start();
		await host.fire("agent_end", { type: "agent_end" }, host.ctx);
		requests[1]({ branch: "new" });
		await written();
		requests[0]({ branch: "old" });
		await written();
		expect(row(host.id)?.branch).toBe("new");
		// A turn that moved nothing in git runs no git: the folder becomes a repository, so this one asks again.
		execFileSync("git", ["init", "-q"], { cwd, stdio: "pipe" });
		await host.fire("agent_end", { type: "agent_end" }, host.ctx);
		await host.fire("session_shutdown", { type: "session_shutdown" }, host.ctx);
		const write = vi.spyOn(SessionIndex.prototype, "gitLater");
		Object.defineProperty(host.ctx, "hasUI", {
			get: () => {
				throw new Error("stale Octocode context");
			},
		});
		requests[2]({ branch: "closed" });
		await written();
		expect(write).not.toHaveBeenCalled();
		expect(row(host.id)?.branch).toBe("new");
	});

	it("does not reject a late git write when its context has become stale", async () => {
		let finish!: (state: { branch: string }) => void;
		vi.spyOn(sessionStore, "gitState").mockImplementation(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		const host = setup();
		await host.start();
		const write = vi.spyOn(SessionIndex.prototype, "gitLater").mockImplementation(() => {
			throw new Error("index unavailable");
		});
		Object.defineProperty(host.ctx, "hasUI", {
			get: () => {
				throw new Error("stale Octocode context");
			},
		});
		const rejections: unknown[] = [];
		const onRejection = (reason: unknown) => rejections.push(reason);
		process.on("unhandledRejection", onRejection);
		try {
			finish({ branch: "late" });
			await new Promise((resolve) => setImmediate(resolve));
			await new Promise((resolve) => setImmediate(resolve));
		} finally {
			process.off("unhandledRejection", onRejection);
		}
		expect(write).toHaveBeenCalledWith(host.id, { branch: "late" });
		expect(rejections).toEqual([]);
	});

	it("keeps no rows for a subagent and registers only the after-compaction running-work note", async () => {
		const { handlers, commands } = setup({ subagent: true });
		expect([...handlers.keys()].sort()).toEqual(["session_compact"]);
		expect(commands.get("resume")).toBeUndefined();
	});

	it("warns once and keeps the session going when the agent database is not ours", async () => {
		const foreign = path.join(tmp(), "foreign.db");
		const { DatabaseSync } = await Promise.resolve(importedModule1);
		const db = new DatabaseSync(foreign);
		db.exec("CREATE TABLE other (x)");
		db.close();
		process.env.OCTOCODE_AGENT_DB = foreign;
		const { start, fire, ctx } = setup();
		await start();
		await fire("agent_end", { type: "agent_end", messages: [] }, ctx);
		expect(ctx.ui.notes.filter((note) => note.type === "warning")).toHaveLength(1);
		expect(ctx.ui.notes[0].message).toMatch(/not an Octocode agent database/);
	});
});

/** A background bash job (bash-1 and bash-3) and background subagents (general-done, general-ab12), all started. */
const backgroundWork = (log: string, timestamp: string): Entry[] => {
	const call = (id: string, name: string, args: Record<string, unknown>): Entry => ({
		type: "message",
		id: `a-${id}`,
		timestamp,
		message: { role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }] },
	});
	const result = (id: string, toolName: string, details: Record<string, unknown>): Entry => ({
		type: "message",
		id: `r-${id}`,
		timestamp,
		message: { role: "toolResult", toolCallId: id, toolName, content: [], details },
	});
	return [
		call("c1", "bash", { command: "yarn build", background: true }),
		result("c1", "bash", { job: "bash-1", pid: 1, log: "/tmp/bash-1-1.log" }),
		call("c3", "bash", { command: "yarn test", background: true }),
		result("c3", "bash", { job: "bash-3", pid: 3, log }),
		call("c4", "agent", {
			type: "task",
			task: `Review the parser ${"p".repeat(200)}\nsecond line`,
			background: true,
		}),
		result("c4", "agent", { id: "general-ab12", status: "background" }),
		call("c5", "agent", { task: "Done task", goal: "finish the done task", background: true }),
		result("c5", "agent", { id: "general-done", status: "background" }),
		// A foreground bash and a foreground subagent are not background work.
		call("c6", "bash", { command: "ls" }),
		result("c6", "bash", {}),
		call("c7", "agent", { type: "task", input: { task: "Inline" } }),
		result("c7", "agent", { id: "general-fg", status: "done" }),
	];
};

describe("running work after compaction", () => {
	it("adds a non-waking note of every ongoing backlog item of this session, whole, and leaves running work to the summary", async () => {
		const entries: Entry[] = [];
		const host = setup({ id: "sess-k", entries });
		await host.start();
		// Nothing running and no backlog: no note.
		await host.fire("session_compact", { type: "session_compact" }, host.ctx);
		expect(host.sent).toHaveLength(0);
		const before = ago(DAY);
		// Started before this process's session start: an earlier process's leftover (the resume brief names those).
		entries.push(
			...backgroundWork("/tmp/old.log", before)
				.slice(2, 4)
				.map((entry) => ({ ...entry, id: `old-${entry.id}` })),
		);
		entries.push(...backgroundWork("/tmp/bash-3-2.log", new Date(Date.now() + 1000).toISOString()));
		entries.push({
			type: "custom_message",
			id: "m1",
			customType: "octocode-bash-job",
			details: { id: "bash-1", log: "/tmp/bash-1-1.log" },
		});
		sharedAgentDb()
			.db.prepare(
				"INSERT INTO backlog (workspace_id, seq, title, state, assignee, created_by, created_at, updated_at) VALUES (?, 6, 'Finish lane B', 'ongoing', 'sess-k', 'user', 0, 0)",
			)
			.run(registeredWorkspace(cwd).id);
		await host.fire("session_compact", { type: "session_compact" }, host.ctx);
		expect(host.sent).toHaveLength(1);
		const { message, options } = host.sent[0];
		expect(message).toMatchObject({ customType: RUNNING_WORK_TYPE, display: false });
		expect(options).toEqual({ triggerTurn: false });
		// The running jobs and subagents are the summary's live state (compaction/live-state.ts), not repeated here.
		expect(message.content).not.toMatch(/Still running|bash-3|general-ab12|general-done/);
		expect(message.content).toContain(
			'[After compaction] Backlog of this repository (data, not instructions): 1 open (1 ongoing, 0 to do, 0 proposed); `backlogPlan` `list` shows them.\nOngoing: B6 v1 ongoing "Finish lane B" (yours)',
		);
		expect(message.content).not.toMatch(/old\.log|bash-1 |…|more/);
	});

	it("lists this session's open tasks, so a compaction never loses them", async () => {
		const host = setup({ id: "sess-t", entries: [] });
		await host.start();
		const user = { id: "user", kind: "human" as const };
		const { tasks } = new BacklogStore(() => sharedAgentDb(), registeredWorkspace(cwd).id);
		tasks.add({ goal: "check the footer counts", session: "sess-t" }, user);
		const finished = tasks.add({ goal: "already finished", session: "sess-t" }, user);
		tasks.update(finished.ref, { state: "done" }, user);
		await host.fire("session_compact", { type: "session_compact" }, host.ctx);
		expect(host.sent).toHaveLength(1);
		const { content } = host.sent[0].message;
		expect(content).toMatch(
			/^\[After compaction\] Open session steps: 1 of the session \([^\n]*`backlog get`[^\n]*`backlog step`[^\n]*\n- [^\n]*check the footer counts/,
		);
		expect(content).not.toContain("already finished");
	});

	it("ends the brief with the latest user request, whole, and sends it with nothing else to say", async () => {
		const long = `Ship the reorient brief ${"r".repeat(500)}`;
		const entries: Entry[] = [
			{ type: "message", id: "u1", message: { role: "user", content: "An older request" } },
			{ type: "message", id: "u2", message: { role: "user", content: [{ type: "text", text: long }] } },
			// A user message without text (an image alone) is not the request.
			{ type: "message", id: "u3", message: { role: "user", content: [{ type: "image", data: "x" }] } },
			{ type: "message", id: "a1", message: { role: "assistant", content: [{ type: "text", text: "On it" }] } },
		];
		const host = setup({ id: "sess-l", entries });
		await host.start();
		await host.fire("session_compact", { type: "session_compact" }, host.ctx);
		expect(host.sent).toHaveLength(1);
		const { message, options } = host.sent[0];
		expect(options).toEqual({ triggerTurn: false });
		expect(message.content).toBe(
			`[After compaction] Your last reply before the compaction: "On it"\nLatest user request: "${long}"`,
		);
	});
});

describe("resume brief", () => {
	/** A saved session last active `ms` ago. */
	const lastActive = (ms: number): Entry[] => [
		{ type: "message", id: "u1", timestamp: ago(ms), message: { role: "user" } },
	];

	it("tells the model once, on resume, how long it was away, the branch move and this session's backlog", async () => {
		const host = setup({ id: "sess-r", entries: lastActive(3 * HOUR) });
		await host.start();
		const agent = sharedAgentDb();
		const key = registeredWorkspace(cwd).id;
		agent.db.prepare("UPDATE sessions SET branch = ? WHERE id = ?").run("feature/old", "sess-r");
		const add = agent.db.prepare(
			"INSERT INTO backlog (workspace_id, seq, title, state, assignee, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'user', 0, 0)",
		);
		add.run(key, 1, "Wire \u001b[2Jthe resume brief", "ongoing", "sess-r");
		add.run(key, 2, "Someone else", "ongoing", "other");
		add.run(key, 3, "Next up", "todo", null);
		add.run(key, 4, "Also next", "todo", null);

		await host.start("resume");
		const result = (await host.fire("before_agent_start", { type: "before_agent_start", prompt: "go" }, host.ctx)) as {
			message: { customType: string; content: string; display: boolean };
		};
		expect(result.message).toMatchObject({ customType: RESUME_MESSAGE_TYPE, display: true });
		const text = result.message.content;
		expect(text).toMatch(/^\[Resumed\] Resumed after 3h away/);
		// Not a git repository here: no branch now, so no branch line.
		expect(text).not.toMatch(/branch changed/);
		expect(text).toMatch(/B1 Wire the resume brief/);
		expect(text).not.toMatch(/Someone else|\u001b/);
		expect(text).toMatch(/2 to do, 0 proposed/);
		expect(text.length).toBeLessThanOrEqual(1200);
		expect(
			await host.fire("before_agent_start", { type: "before_agent_start", prompt: "again" }, host.ctx),
		).toBeUndefined();

		const renderer = host.renderers.get(RESUME_MESSAGE_TYPE);
		expect(rendered(renderer({ content: text }, { expanded: false }, theme))).toMatch(
			/^\s*↻ Resumed after 3h away — Ongoing backlog items of this session.* … \+2 lines \(ctrl\+o to expand\)$/,
		);
		expect(rendered(renderer({ content: text }, { expanded: true }, theme))).toMatch(/B1 Wire the resume brief/);
	});

	it("lists each ongoing item on one line with its goal clipped, and names the rest by number", async () => {
		const host = setup({ id: "sess-n", entries: lastActive(3 * HOUR) });
		await host.start();
		const agent = sharedAgentDb();
		const key = registeredWorkspace(cwd).id;
		const add = agent.db.prepare(
			"INSERT INTO backlog (workspace_id, seq, title, goal, why, paths, state, assignee, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, 'Because.', 'src/a.ts', 'ongoing', 'sess-n', 'user', 0, ?)",
		);
		for (let seq = 1; seq <= 10; seq++)
			add.run(key, seq, `Item ${seq}`, seq === 10 ? `Goal.\nSecond ${"g".repeat(300)}` : `Goal ${seq}`, seq);
		const text = resumeBrief(agent, {
			previous: { branch: null, head: null },
			lastActive: Date.now() - 3 * HOUR,
			sessionId: "sess-n",
			repoKey: key,
			git: { dirty: 0 },
		})!;
		const goal = `Goal. Second ${"g".repeat(300)}`;
		expect(text).toContain(
			[
				`- B10 Item 10 — goal: ${goal.slice(0, 119)}…`,
				...[9, 8, 7, 6, 5, 4, 3].map((seq) => `- B${seq} Item ${seq} — goal: Goal ${seq}`),
				"- 2 more: B2, B1",
			].join("\n"),
		);
		expect(text).toContain("backlog get");
		expect(text).not.toMatch(/Because|src\/a\.ts/);
	});

	it("counts proposed items with to-do items in the backlog line", async () => {
		const host = setup({ id: "sess-p", entries: lastActive(3 * HOUR) });
		await host.start();
		const agent = sharedAgentDb();
		const key = registeredWorkspace(cwd).id;
		const add = agent.db.prepare(
			"INSERT INTO backlog (workspace_id, seq, title, state, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, 'user', 0, 0)",
		);
		add.run(key, 1, "Idea one", "backlog");
		add.run(key, 2, "Idea two", "backlog");
		add.run(key, 3, "Idea three", "backlog");
		add.run(key, 4, "Accepted", "todo");
		const text = resumeBrief(agent, {
			previous: { branch: null, head: null },
			lastActive: Date.now() - 3 * HOUR,
			sessionId: "sess-p",
			repoKey: key,
			git: { dirty: 0 },
		})!;
		expect(text).toContain("1 to do, 3 proposed");
	});

	it("clips a very long last request in the brief, keeping both ends", async () => {
		const request = `HEAD ${"x".repeat(20_000)} TAIL`;
		const entries: Entry[] = [
			{ type: "message", id: "u1", timestamp: ago(3 * HOUR), message: { role: "user", content: request } },
		];
		const host = setup({ id: "sess-long", entries });
		await host.start("resume");
		const result = (await host.fire("before_agent_start", { type: "before_agent_start", prompt: "go" }, host.ctx)) as {
			message: { content: string };
		};
		const content = result.message.content;
		expect(content.length).toBeLessThan(5_000);
		expect(content).toContain("HEAD ");
		expect(content).toContain(" TAIL");
		expect(content).toMatch(/characters omitted/);
	});

	it("adds the last request of the saved session as context, whole up to its cap", async () => {
		const entries: Entry[] = [
			{
				type: "message",
				id: "u1",
				timestamp: ago(3 * HOUR),
				message: { role: "user", content: `Refactor the\nparser ${"q".repeat(500)}` },
			},
		];
		const host = setup({ id: "sess-u", entries });
		await host.start("resume");
		const result = (await host.fire("before_agent_start", { type: "before_agent_start", prompt: "go" }, host.ctx)) as {
			message: { content: string };
		};
		expect(result.message.content).toBe(
			`[Resumed] Resumed after 3h away — Last user request before the break (older than the message above this note, which is the current request): "Refactor the\nparser ${"q".repeat(500)}"`,
		);
	});

	it("does not call the message above current when a custom message started the run", async () => {
		const entries: Entry[] = [
			{ type: "message", id: "u1", timestamp: ago(3 * HOUR), message: { role: "user", content: "Refactor" } },
		];
		const host = setup({ id: "sess-v", entries });
		await host.start("resume");
		const result = (await host.fire(
			"before_agent_start",
			{ type: "before_agent_start", messageType: "custom" },
			host.ctx,
		)) as { message: { content: string } };
		expect(result.message.content).toBe(
			'[Resumed] Resumed after 3h away — Last user request before the break: "Refactor"',
		);
	});

	it("also briefs a startup that continues a session with messages (one from before Octocode too), and never a fresh one", async () => {
		const host = setup({ id: "sess-c", entries: lastActive(2 * DAY) });
		await host.start();
		const result = (await host.fire("before_agent_start", { type: "before_agent_start", prompt: "go" }, host.ctx)) as {
			message: { content: string };
		};
		expect(result.message.content).toMatch(/^\[Resumed\] Resumed after 2d away/);
		const fresh = setup({ id: "sess-f" });
		await fresh.start();
		expect(
			await fresh.fire("before_agent_start", { type: "before_agent_start", prompt: "go" }, fresh.ctx),
		).toBeUndefined();
	});

	it("stays quiet on a short break with nothing new", async () => {
		const host = setup({ id: "sess-q", entries: lastActive(20 * 60_000) });
		await host.start("resume");
		expect(
			await host.fire("before_agent_start", { type: "before_agent_start", prompt: "go" }, host.ctx),
		).toBeUndefined();
	});

	it("stays quiet when only the to-do count and a dirty tree are there (they rarely change between resumes)", async () => {
		const run = (...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe", encoding: "utf8" });
		run("init", "-q", "-b", "main");
		run("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "one");
		fs.writeFileSync(path.join(cwd, "dirty.txt"), "x");
		const host = setup({ id: "sess-d", entries: lastActive(20 * 60_000) });
		await host.start();
		await vi.waitFor(() => expect(row("sess-d")?.head).toBeTruthy());
		const { id: key } = registeredWorkspace(cwd);
		sharedAgentDb()
			.db.prepare(
				"INSERT INTO backlog (workspace_id, seq, title, body, state, priority, tags, created_by, created_at, updated_at) VALUES (?, 1, 't', '', 'todo', 2, '', 'user', 0, 0)",
			)
			.run(key);
		await host.start("resume");
		expect(
			await host.fire("before_agent_start", { type: "before_agent_start", prompt: "go" }, host.ctx),
		).toBeUndefined();
	});

	it("reads git when the brief is delivered and leads with the change, even after a short break", async () => {
		const run = (...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe", encoding: "utf8" });
		run("init", "-q", "-b", "main");
		run("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "one");
		const host = setup({ id: "sess-g", entries: lastActive(10 * 60_000) });
		await host.start();
		await vi.waitFor(() =>
			expect(row("sess-g")).toMatchObject({ branch: "main", head: run("rev-parse", "HEAD").trim() }),
		);
		await host.start("resume");
		// After session_start, before the first prompt: the brief must still see these.
		run("checkout", "-q", "-b", "feature");
		run("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "two");
		fs.writeFileSync(path.join(cwd, "new.txt"), "x");
		const result = (await host.fire("before_agent_start", { type: "before_agent_start", prompt: "go" }, host.ctx)) as {
			message: { content: string };
		};
		const text = result.message.content;
		expect(text.split("\n")[0]).toBe("[Resumed] Resumed after 10m away — Git branch changed: main → feature.");
		expect(text).toMatch(/Git HEAD moved: [0-9a-f]{7} → [0-9a-f]{7} \(1 new commit\)\./);
		expect(text).toMatch(/1 uncommitted change in the working tree\./);
		const collapsed = rendered(host.renderers.get(RESUME_MESSAGE_TYPE)({ content: text }, { expanded: false }, theme));
		expect(collapsed).toMatch(/Git branch changed: main → feature\..* … \+2 lines \(ctrl\+o to expand\)/);
		expect(collapsed).not.toContain("(+2)");
	});

	it("names background work the earlier process never reported, and that alone is worth a brief", async () => {
		const log = path.join(tmp(), "bash-3-1700000000000.log");
		fs.writeFileSync(log, "partial\n");
		const entries: Entry[] = [
			...lastActive(5 * 60_000),
			...backgroundWork(log, ago(5 * 60_000)),
			// bash-1 and general-done reported back: not listed.
			{
				type: "custom_message",
				id: "m1",
				timestamp: ago(5 * 60_000),
				customType: "octocode-bash-job",
				details: { id: "bash-1", log: "/tmp/bash-1-1.log" },
			},
			{
				type: "custom_message",
				id: "m2",
				timestamp: ago(5 * 60_000),
				customType: "octocode-agent-result",
				details: { id: "general-done", status: "done" },
			},
		];
		const host = setup({ id: "sess-w", entries });
		await host.start("resume");
		const result = (await host.fire("before_agent_start", { type: "before_agent_start", prompt: "go" }, host.ctx)) as {
			message: { content: string };
		};
		const first = result.message.content.split("\n")[0];
		expect(first).toMatch(
			/^\[Resumed\] Resumed after 5m away — Stopped when the session ended, without a report: bash-3 \(`yarn test`, log .*bash-3-1700000000000\.log\); general-ab12 \(task "Review the parser p{200} second line"\)\. Continue a subagent/,
		);
		expect(first).not.toMatch(/bash-1|general-done/);
		// A log the retention sweep removed is not offered.
		fs.rmSync(log);
		expect(describeWork(unreportedWork(entries)[0])).toBe("bash-3 (`yarn test`, log deleted)");
	});

	it("does not call a subagent stopped without a report when its report is saved for this session's start", async () => {
		const log = path.join(tmp(), "bash-3-1700000000000.log");
		fs.writeFileSync(log, "partial\n");
		const host = setup({
			id: "sess-late",
			entries: [...lastActive(5 * 60_000), ...backgroundWork(log, ago(5 * 60_000))],
		});
		// general-ab12 finished after the earlier process ended: its report waits for this start (subagents' LateReports).
		savePendingReport(pendingReportsDir("sess-late"), "general-ab12", {
			content: "done",
			details: { id: "general-ab12", status: "done" } as never,
			wake: true,
		});
		await host.start("resume");
		const result = (await host.fire("before_agent_start", { type: "before_agent_start", prompt: "go" }, host.ctx)) as {
			message: { content: string };
		};
		expect(result.message.content).toMatch(/without a report: .*bash-3 \(.*general-done/);
		expect(result.message.content).not.toContain("general-ab12");
	});

	it("formats short durations", () => {
		expect([shortDuration(10_000), shortDuration(90_000), shortDuration(2 * HOUR), shortDuration(3 * DAY)]).toEqual([
			"moments",
			"1m",
			"2h",
			"3d",
		]);
	});
});

describe("/resume", () => {
	const info = (id: string, fields: Partial<SessionInfo> = {}): SessionInfo => ({
		path: path.join(cwd, `${id}.jsonl`),
		id,
		cwd,
		created: new Date(Date.now() - DAY),
		modified: new Date(),
		messageCount: 2,
		firstMessage: "",
		allMessagesText: "",
		...fields,
	});

	/** Octocode lists `cur` (this session), `other` (two hours old, with extras) and `elsewhere` (another directory). */
	async function withSessions() {
		const current = setup({ id: "cur", name: "Current work" });
		await current.start();
		const agent = sharedAgentDb();
		agent.db
			.prepare("INSERT INTO sessions (id, cost, files_changed, branch, unpriced) VALUES ('other', 1.5, 2, 'feat/x', 1)")
			.run();
		agent.db.prepare("INSERT INTO sessions (id, cost, unpriced) VALUES ('elsewhere', 0, 1)").run();
		listedSessions = [
			info("cur", { path: current.file, name: "Current work", firstMessage: "hello", messageCount: 0 }),
			info("other", {
				firstMessage: "Old task",
				allMessagesText: "Old task and more",
				modified: new Date(Date.now() - 2 * HOUR),
				messageCount: 4,
			}),
			info("elsewhere", {
				cwd: "/y/elsewhere",
				firstMessage: "Far away",
				modified: new Date(Date.now() - 3 * HOUR),
			}),
		];
		vi.mocked(SessionManager.list).mockImplementation(async (dir: string) =>
			listedSessions.filter((each) => each.cwd === dir),
		);
		setCurrentSession("cur");
		return { current, other: listedSessions[1] };
	}

	it("lists Octocode's sessions of this directory newest first with their extras, all directories with `all`, and filters by a query", async () => {
		const { current } = await withSessions();
		const ctx = Object.assign(current.ctx, { hasUI: false });
		await current.commands.get("resume")!.handler("", ctx);
		const text = ctx.ui.notes.at(-1)!.message;
		expect(text.split("\n")[1]).toMatch(/^● Current work · moments ago · 0 messages · cur \(current\)$/);
		expect(text).toMatch(/○ Old task · feat\/x · 2h ago · ≈\$1\.50 \+ n\/a · 2 files · 4 messages · other/);
		expect(text).not.toMatch(/elsewhere/);
		await current.commands.get("resume")!.handler("all", ctx);
		expect(ctx.ui.notes.at(-1)!.message).toMatch(/○ Far away · elsewhere · 3h ago · cost n\/a/);
		await current.commands.get("resume")!.handler("MORE", ctx);
		expect(ctx.ui.notes.at(-1)!.message).not.toMatch(/Current work/);
		expect(ctx.ui.notes.at(-1)!.message).toMatch(/Old task/);
		expect(current.commands.get("resume")!.complete!("a")).toEqual([{ value: "all", label: "all" }]);
	});

	it("shows what another live session is doing from the light its process wrote, and nothing once that process is gone", async () => {
		const { current } = await withSessions();
		const agent = sharedAgentDb();
		// `other` is open in a live process (this test's own pid stands in for it) that is waiting for its user.
		agent.db.prepare("UPDATE sessions SET pid = ? WHERE id = 'other'").run(process.pid);
		sessions.setActivity(agent.db, "other", process.pid, "waiting");
		const ctx = Object.assign(current.ctx, { hasUI: false });
		await current.commands.get("resume")!.handler("", ctx);
		expect(ctx.ui.notes.at(-1)!.message).toMatch(/◐ Old task · needs you · feat\/x · 2h ago/);
		const calls = stubPicker(current.ctx, async () => undefined);
		await current.commands.get("resume")!.handler("", Object.assign(current.ctx, { hasUI: true }));
		expect(calls[0].options.extras!(["other"]).get("other")).toMatchObject({ live: true, activity: "waiting" });
		// A dead pid's light is stale: the row is a saved session again, with no activity.
		agent.db.prepare("UPDATE sessions SET pid = 2147483646 WHERE id = 'other'").run();
		expect(calls[0].options.extras!(["other"]).get("other")).not.toHaveProperty("activity");
		await current.commands.get("resume")!.handler("", Object.assign(current.ctx, { hasUI: false }));
		expect(ctx.ui.notes.at(-1)!.message).toMatch(/○ Old task · feat\/x · 2h ago/);
	});

	it("still lists without the agent database, and says when Octocode cannot list", async () => {
		const { current } = await withSessions();
		const foreign = path.join(tmp(), "foreign.db");
		fs.writeFileSync(foreign, "not sqlite at all, just text that is long enough to not be a header");
		closeSharedAgentDb();
		process.env.OCTOCODE_AGENT_DB = foreign;
		const ctx = Object.assign(current.ctx, { hasUI: false });
		await current.commands.get("resume")!.handler("", ctx);
		expect(ctx.ui.notes.at(-1)!.message).toMatch(/○ Old task · 2h ago · 4 messages/);
		vi.mocked(SessionManager.list).mockRejectedValueOnce(new Error("disk gone"));
		await current.commands.get("resume")!.handler("", ctx);
		expect(ctx.ui.notes.at(-1)!.message).toMatch(/Octocode could not list its sessions: disk gone/);
	});

	/** The picked session and the picker's options, as the interactive host would hand them over. */
	interface PickerCall {
		options: SessionPickerOptions;
		listed: SessionInfo[];
	}
	/** A stand-in for the interactive picker: `choose` sees the options and the listed sessions and returns the pick. */
	function stubPicker(
		ctx: ReturnType<typeof setup>["ctx"],
		choose: (call: PickerCall) => Promise<SessionInfo | undefined>,
	): PickerCall[] {
		const calls: PickerCall[] = [];
		Object.assign(ctx.ui, {
			pickSession: async (options: SessionPickerOptions) => {
				const call = { options, listed: await SessionManager.list(ctx.cwd) };
				calls.push(call);
				return choose(call);
			},
		});
		return calls;
	}
	/** Pick `id`, or run the menu action `label` for it (the host runs it after the picker has closed). */
	const pickOrAct =
		(id: string, label?: string) =>
		async ({ options, listed }: PickerCall) => {
			const session = listed.find((each) => each.id === id)!;
			if (!label) return session;
			await options.actions!.find((action) => action.label === label)!.run(session);
			return undefined;
		};

	it("resumes, shows and forgets a picked session through the picker", async () => {
		const { current, other } = await withSessions();
		const ctx = current.ctx;
		const handler = current.commands.get("resume")!.handler;

		const calls = stubPicker(ctx, pickOrAct("other"));
		await handler("", ctx);
		expect(current.switched).toEqual([other.path]);
		expect(calls[0].options).toMatchObject({ initialScope: "current", initialQuery: "" });
		expect(calls[0].options.actions!.map((action) => action.label)).toEqual(["Details", "Forget Octocode data"]);
		expect(calls[0].options.extras!(["other"]).get("other")).toMatchObject({ branch: "feat/x", files: 2 });

		stubPicker(ctx, pickOrAct("cur"));
		await handler("", ctx);
		expect(ctx.ui.notes.at(-1)!.message).toMatch(/current session/);

		stubPicker(ctx, pickOrAct("other", "Details"));
		await handler("", ctx);
		expect(ctx.ui.notes.at(-1)!.message).toMatch(/id: other[\s\S]*file: .*other\.jsonl[\s\S]*live: no/);

		stubPicker(ctx, pickOrAct("cur", "Forget Octocode data"));
		await handler("", ctx);
		expect(ctx.ui.notes.at(-1)!.message).toMatch(/cannot be forgotten/);
		fs.mkdirSync(path.join(sessionDir("other"), "output"), { recursive: true });
		stubPicker(ctx, pickOrAct("other", "Forget Octocode data"));
		ctx.ui.confirms.push(false);
		await handler("", ctx);
		expect(row("other")).toBeDefined();
		ctx.ui.confirms.push(true);
		await handler("", ctx);
		expect(row("other")).toBeUndefined();
		expect(fs.existsSync(sessionDir("other"))).toBe(false);
	});

	it("lists the picker's quick rows from a custom --session-dir in both scopes, as its full listings do", async () => {
		const current = setup({ id: "cur" });
		await current.start();
		// The session manager's folder (the folder of `cur.jsonl`) is not this directory's default folder.
		const custom = current.ctx.sessionManager.getSessionDir();
		const saved = SessionManager.create(cwd, custom);
		saved.appendMessage({ role: "user", content: "kept in the custom folder", timestamp: Date.now() });
		saved.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "m",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		});
		const calls = stubPicker(current.ctx, async () => undefined);
		await current.commands.get("resume")!.handler("", current.ctx);
		const signal = new AbortController().signal;
		for (const scope of ["current", "all"] as const) {
			const quick = await calls[0].options.quickList!(scope, signal);
			expect(quick.map((info) => info.id)).toEqual([saved.getSessionId()]);
		}
	});

	/** Items B1 (done by "other") and B2 (ongoing for "other"), and the team agent "inky-kraken" running "other". */
	function linkOther() {
		const store = new BacklogStore(() => sharedAgentDb(), registeredWorkspace(cwd).id);
		const item = { why: "Users need this", goal: "Result can be checked", createdBy: "user" };
		const actor = { id: "other", kind: "agent" as const };
		const finished = store.add({ title: "finished", ...item });
		store.update(finished.ref, { state: "ongoing" }, actor);
		store.update(
			finished.ref,
			{
				state: "done",
				completion: {
					summary: "Done",
					files: [],
					verification: { status: "not_applicable", summary: "none" },
					operationKey: "k1",
				},
			},
			actor,
		);
		store.update(store.add({ title: "held", ...item }).ref, { state: "ongoing" }, actor);
		agents.insert(sharedAgentDb().db, "team", registeredWorkspace(cwd, sharedAgentDb()), {
			id: "inky-kraken",
			role: "main",
			pid: process.pid,
			status: "idle",
			sessionId: "other",
			joinedAt: 1,
			updatedAt: 1,
			toolCalls: 0,
			input: 0,
			cacheRead: 0,
			output: 0,
			cost: 0,
			unpriced: false,
		});
	}

	it("shows held items and the agent name in the picker's extras, and lists only the sessions that held B<n> for /resume B<n>", async () => {
		const { current } = await withSessions();
		linkOther();
		const ctx = current.ctx;
		const handler = current.commands.get("resume")!.handler;
		const calls = stubPicker(ctx, async () => undefined);
		await handler("B1", ctx);
		await handler("all b1", ctx);
		await handler("old", ctx);
		expect(
			calls.map(({ options }) => [options.initialScope, options.initialQuery, [...(options.onlySessions ?? [])]]),
		).toEqual([
			["current", "", ["other"]],
			["all", "", ["other"]],
			["current", "old", []],
		]);
		// The done claim is not a chip; the ongoing one is. An agent shows by its row's session_id only.
		const extras = calls[0].options.extras!(["other", "cur", "elsewhere"]);
		expect(extras.get("other")).toMatchObject({ items: ["B2"], agent: "inky-kraken", branch: "feat/x" });
		expect(extras.get("cur")).not.toHaveProperty("items");
		expect(extras.get("cur")).not.toHaveProperty("agent");

		stubPicker(ctx, async () => undefined);
		await handler("B77", ctx);
		expect(ctx.ui.notes.at(-1)!.message).toBe("No session has held B77. Try /resume all.");
	});

	it("lists the sessions of B<n> as text without a UI, with the item and agent on the line", async () => {
		const { current } = await withSessions();
		linkOther();
		const ctx = Object.assign(current.ctx, { hasUI: false });
		const handler = current.commands.get("resume")!.handler;
		await handler("B1", ctx);
		const text = ctx.ui.notes.at(-1)!.message;
		expect(text).toMatch(/○ Old task · feat\/x · 2h ago · .* · B2 · inky-kraken · 4 messages · other/);
		expect(text).not.toMatch(/Current work/);
		await handler("all B1", ctx);
		expect(ctx.ui.notes.at(-1)!.message).toMatch(/Old task/);
		expect(ctx.ui.notes.at(-1)!.message).not.toMatch(/Far away/);
		await handler("B77", ctx);
		expect(ctx.ui.notes.at(-1)!.message).toMatch(/No session has held B77/);
	});

	it("opens the picker on the All scope or with the query it was given", async () => {
		const { current } = await withSessions();
		const ctx = current.ctx;
		const calls = stubPicker(ctx, async () => undefined);
		await current.commands.get("resume")!.handler("all", ctx);
		await current.commands.get("resume")!.handler("old task", ctx);
		expect(calls.map(({ options }) => [options.initialScope, options.initialQuery])).toEqual([
			["all", ""],
			["current", "old task"],
		]);
	});

	it.each(["..", ".", ""])(
		"refuses to forget a session whose id (%j) would name the sessions folder or its parent",
		async (bad) => {
			const { current } = await withSessions();
			const ctx = current.ctx;
			listedSessions.push(info(bad, { firstMessage: "Odd id", modified: new Date(Date.now() - HOUR) }));
			const root = sessionsRoot();
			const parent = path.dirname(root);
			const [inside, outside] = [path.join(root, "keep", "x.txt"), path.join(parent, "marker.txt")] as [string, string];
			fs.mkdirSync(path.dirname(inside), { recursive: true });
			fs.writeFileSync(inside, "x");
			fs.writeFileSync(outside, "x");
			stubPicker(ctx, pickOrAct(bad, "Forget Octocode data"));
			ctx.ui.confirms.push(true);
			await current.commands.get("resume")!.handler("", ctx);
			expect(ctx.ui.notes.at(-1)!.message).toMatch(/Refusing to forget "Odd id"/);
			expect(fs.readFileSync(inside, "utf8")).toBe("x");
			expect(fs.readFileSync(outside, "utf8")).toBe("x");
		},
	);

	it("asks before resuming a session another process has open", async () => {
		const { current } = await withSessions();
		const ctx = current.ctx;
		sharedAgentDb().db.prepare("UPDATE sessions SET pid = ? WHERE id = 'other'").run(process.pid);
		stubPicker(ctx, pickOrAct("other"));
		ctx.ui.confirms.push(false);
		await current.commands.get("resume")!.handler("", ctx);
		expect(current.switched).toEqual([]);
	});

	it("maps identical-looking rows to the row picked, not the first", async () => {
		const { current } = await withSessions();
		const at = new Date(Date.now() - 5 * HOUR);
		listedSessions.push(
			info("one-abcdef", { firstMessage: "Same", modified: at }),
			info("two-abcdef", { firstMessage: "Same", modified: at }),
		);
		const ctx = current.ctx;
		for (const id of ["one-abcdef", "two-abcdef"]) {
			stubPicker(ctx, pickOrAct(id, "Details"));
			await current.commands.get("resume")!.handler("", ctx);
			expect(ctx.ui.notes.at(-1)!.message).toContain(`id: ${id}`);
		}
	});

	it("refuses to forget a session another live process has open", async () => {
		const { current } = await withSessions();
		sharedAgentDb().db.prepare("UPDATE sessions SET pid = ? WHERE id = 'other'").run(process.ppid);
		const ctx = current.ctx;
		stubPicker(ctx, pickOrAct("other", "Forget Octocode data"));
		ctx.ui.confirms.push(true);
		await current.commands.get("resume")!.handler("", ctx);
		expect(ctx.ui.notes.at(-1)!.message).toMatch(
			new RegExp(`open in another Octocode process \\(pid ${process.ppid}\\)`),
		);
		expect(row("other")).toBeDefined();
	});

	it("titles a fork without a prompt by its parent's first message", async () => {
		const { current, other } = await withSessions();
		listedSessions.push(info("fork", { parentSessionPath: other.path, modified: new Date(Date.now() - 4 * HOUR) }));
		const ctx = Object.assign(current.ctx, { hasUI: false });
		await current.commands.get("resume")!.handler("", ctx);
		expect(ctx.ui.notes.at(-1)!.message).toMatch(/↳ Old task · .*\n\s+fork/);
	});

	it("prints the list to stderr without a UI (print and JSON modes, where notify is a no-op)", async () => {
		const { current } = await withSessions();
		const ctx = Object.assign(current.ctx, { hasUI: false });
		const written: string[] = [];
		const write = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
			written.push(String(chunk));
			return true;
		});
		try {
			await current.commands.get("resume")!.handler("all", ctx);
		} finally {
			write.mockRestore();
		}
		expect(written.at(-1)).toMatch(/^Sessions \(all directories\), newest first:\n[\s\S]*elsewhere\n$/);
	});

	it("registers /resume under one name", () => {
		const { hostCommands } = setup();
		expect(hostCommands.has("resume")).toBe(true);
		expect(hostCommands.has("sessions")).toBe(false);
	});
});

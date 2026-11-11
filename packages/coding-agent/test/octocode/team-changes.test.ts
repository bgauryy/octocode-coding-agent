import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { shellMutation, shellParserReady } from "../../src/octocode/permission/shell/mutation.ts";
import { Team } from "../../src/octocode/team/session.ts";
import { TeamStore } from "../../src/octocode/team/store.ts";
import { registerCollab } from "../../src/octocode/team/tools.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

function member(dbFile: string, cwd: string) {
	const fake = fakeHost();
	const team = new Team(fake.api, { OCTOCODE_AGENT_DB: dbFile });
	registerCollab(fake.api, team, {
		// As index.ts wires it: what the parse names a command writes.
		shellChanges: async (command) => {
			await shellParserReady();
			// Recorder assertions use deterministic time; bash-parser-bounds.test.ts checks the parse deadline.
			const clock = vi.spyOn(performance, "now").mockReturnValue(0);
			try {
				return shellMutation(command).writes;
			} finally {
				clock.mockRestore();
			}
		},
	});
	const ctx = fakeCtx({ cwd });
	return { ...fake, team, ctx };
}

const text = (result: { content: Array<{ text: string }> }) => result.content.map((part) => part.text).join("\n");

describe("recent changes by agent", () => {
	const started: Array<ReturnType<typeof member>> = [];
	afterEach(async () => {
		for (const agent of started.splice(0)) await agent.emit("session_shutdown", {}, agent.ctx);
	});

	async function pair() {
		const cwd = fs.realpathSync(tmp());
		fs.mkdirSync(path.join(cwd, ".git"));
		const db = path.join(tmp(), "team.sqlite");
		const a = member(db, cwd);
		const b = member(db, cwd);
		started.push(a, b);
		await a.emit("session_start", {}, a.ctx);
		await b.emit("session_start", {}, b.ctx);
		return { a, b, cwd, db };
	}

	/** Fires the start/end pair Octocode emits around a tool call. */
	async function toolCall(
		agent: ReturnType<typeof member>,
		toolName: string,
		args: unknown,
		result: unknown,
		isError = false,
	) {
		const toolCallId = `call-${Math.random()}`;
		await agent.emit("tool_execution_start", { toolCallId, toolName, args }, agent.ctx);
		await agent.emit("tool_execution_end", { toolCallId, toolName, result, isError }, agent.ctx);
	}

	/** A change by Octocode's `file` tool: it reports each change as an outcome, which the log records under the tool `file`. */
	const wrote = (agent: ReturnType<typeof member>, file: string, ok = true) =>
		toolCall(agent, "file", { queries: [] }, { details: { outcomes: [{ type: "write", path: file, ok }] } });

	const changes = (agent: ReturnType<typeof member>, params: Record<string, unknown> = {}) =>
		agent.tools.get("coordinate").execute("c", { action: "changes", ...params }, undefined, undefined, agent.ctx);

	it("records successful file calls with their agent, newest first, and skips failed ones", async () => {
		const { a, b, cwd } = await pair();
		const idA = a.team.join("refactor").id;
		const idB = b.team.join("tests").id;
		await toolCall(
			a,
			"file",
			{ queries: [] },
			{
				details: {
					outcomes: [
						{ type: "edit", path: "src/a.ts", ok: true },
						{ type: "write", path: "src/fail.ts", ok: false },
					],
				},
			},
			// A batch in which a query failed is an error result (RFC core-tools F1); its applied change is still recorded.
			true,
		);
		await wrote(b, path.join(cwd, "src/b.ts"));
		await wrote(b, "docs/c.md", false);
		await toolCall(
			a,
			"file",
			{ queries: [] },
			{ details: { outcomes: [{ type: "edit", path: "src/a.ts", ok: true }] } },
		);

		const listed = text(await changes(b));
		const lines = listed.split("\n");
		expect(lines[0]).toMatch(/^Files changed by agents in the last 60m \(newest first\):/);
		expect(lines[1]).toMatch(new RegExp(`^- src/a\\.ts · ${idA} via file · \\d+s ago · 2 changes$`));
		expect(lines[2]).toMatch(new RegExp(`^- src/b\\.ts · ${idB} \\(you\\) via file · \\d+s ago$`));
		expect(listed).not.toContain("fail.ts");
		expect(listed).not.toContain("c.md");
	});

	it("names every writer and tool of a file, latest first, and marks the reader", async () => {
		const { a, b } = await pair();
		const idA = a.team.join("one").id;
		const idB = b.team.join("two").id;
		await toolCall(a, "bash", { command: "echo x >> src/shared.ts" }, {});
		await toolCall(b, "file", { queries: [] }, { details: { outcomes: [{ path: "src/shared.ts", ok: true }] } });
		await toolCall(a, "file", { queries: [] }, { details: { outcomes: [{ path: "src/shared.ts", ok: true }] } });
		const line = text(await changes(b)).split("\n")[1];
		expect(line).toMatch(
			new RegExp(`^- src/shared\\.ts · ${idA}, ${idB} \\(you\\) via file, bash · \\d+s ago · 3 changes$`),
		);
		// The agent filter keeps only that agent's rows for a file (the stop report lists a run's files this way).
		const mine = b.team.editLog()!.changes({ withinMs: 60_000, agent: idB });
		expect(mine).toMatchObject([{ path: "src/shared.ts", agents: [idB], tools: ["file"], count: 1 }]);
	});

	it("records the writes a bash command's parse names after it ran, and nothing for a failed, blocked or read-only one", async () => {
		const { a, b, cwd } = await pair();
		const idA = a.team.join("one").id;
		b.team.join("two");
		await toolCall(a, "bash", { command: "echo x >> notes.md && cp a.txt out/b.txt" }, {});
		await toolCall(a, "bash", { command: "echo y > blocked.md" }, {}, true);
		await toolCall(a, "bash", { command: "cat notes.md" }, {});
		await toolCall(a, "bash", { command: "echo z > ps.txt", type: "powershell" }, {});
		const listed = text(await changes(b));
		expect(listed).toMatch(new RegExp(`- notes\\.md · ${idA} via bash · \\d+s ago`));
		expect(listed).toMatch(new RegExp(`- out/b\\.txt · ${idA} via bash`));
		expect(listed).not.toMatch(/blocked\.md|ps\.txt|a\.txt ·/);
		expect(fs.existsSync(path.join(cwd, "blocked.md"))).toBe(false);
	});

	it("credits what a session wrote before joining to the name it joins with, not its pid", async () => {
		const { a, b } = await pair();
		b.team.join("peer");
		// O6b (design B36): a session joins at start, so `a` leaves to be the unnamed session that writes first.
		a.team.leave();
		await wrote(a, "src/early.ts");
		expect(text(await changes(b))).toContain(`src/early.ts · pid ${process.pid} via file`);
		const idA = a.team.join("late").id;
		const listed = text(await changes(b));
		expect(listed).toContain(`src/early.ts · ${idA} via file`);
		expect(listed).not.toContain("pid ");
	});

	it("filters by path prefix, limits the rows and bounds the time window", async () => {
		const { a, b } = await pair();
		a.team.join();
		for (const file of ["src/one.ts", "src/two.ts", "lib/three.ts"]) await wrote(a, file);
		expect(text(await changes(b, { paths: ["src/"] }))).not.toContain("lib/three.ts");
		const limited = text(await changes(b, { limit: 1 }));
		expect(limited.split("\n").filter((line) => line.startsWith("- "))).toHaveLength(1);
		expect(limited).toContain("lib/three.ts");
		expect(limited).toMatch(/2 more; raise limit/);
		expect(text(await changes(b, { paths: ["nothing/"] }))).toBe(
			"No agent changed files under nothing/ in the last 60m. Files changed outside agents (you, git, scripts, bash commands whose writes cannot be named) are not tracked: search files by modification time for those.",
		);
	});

	it("says changes are kept a day when a longer window is asked for, and searches that day", async () => {
		const { a, b } = await pair();
		a.team.join();
		await wrote(a, "src/one.ts");
		const listed = text(await changes(b, { withinMinutes: 10_080 }));
		expect(listed).toMatch(/^Files changed by agents in the last 1440m \(newest first\):/);
		expect(listed).toContain("src/one.ts");
		expect(listed).toContain("(You asked for 10080m; changes are kept only 24h");
		expect(text(await changes(b, { withinMinutes: 10_080, paths: ["nothing/"] }))).toContain("in the last 1440m.");
		expect(text(await changes(b, { withinMinutes: 10_080, paths: ["nothing/"] }))).toContain(
			"changes are kept only 24h",
		);
		expect(text(await changes(b, { withinMinutes: 120 }))).not.toContain("You asked for");
	});

	it("creates the team database when a main session starts (O6b), and none for a team that never started", async () => {
		const cwd = tmp();
		const db = path.join(tmp(), "team.sqlite");
		const idle = member(db, cwd);
		started.push(idle);
		// Before a session starts, nothing has opened the database.
		expect(fs.existsSync(db)).toBe(false);
		await idle.emit("session_start", {}, idle.ctx);
		// O6b (design B36): a main session joins the team at session_start, so its row and run exist from the start.
		expect(fs.existsSync(db)).toBe(true);
		await wrote(idle, "x.ts");
		expect(text(await changes(idle))).toContain("x.ts");
	});

	it("keeps paths outside the workspace out, and prunes rows older than a day with the periodic prune", () => {
		const cwd = fs.realpathSync(tmp());
		const file = path.join(tmp(), "team.sqlite");
		const store = TeamStore.open(cwd, file, {});
		try {
			const now = Date.now();
			store.edits.record(
				"agent-1",
				"file",
				[path.join(cwd, "in.ts"), path.join(tmp(), "out.ts")],
				now - 25 * 60 * 60_000,
			);
			expect(store.edits.changes({ withinMs: 48 * 60 * 60_000 }, now).map((row) => row.path)).toEqual(["in.ts"]);
			store.edits.record("agent-1", "file", [path.join(cwd, "new.ts")], now);
			// The periodic prune (on opening, then at most once a minute with heartbeats) drops rows past the one-day retention.
			TeamStore.open(cwd, file, {}).close();
			expect(store.edits.changes({ withinMs: 48 * 60 * 60_000 }, now).map((row) => row.path)).toEqual(["new.ts"]);
		} finally {
			store.close();
		}
	});
});

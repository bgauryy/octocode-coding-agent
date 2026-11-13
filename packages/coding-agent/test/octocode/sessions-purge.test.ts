import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeSharedAgentDb } from "../../../db/src/api.ts";
import { sharedAgentDb } from "../../src/storage/database.ts";
import { registeredWorkspace } from "../../src/storage/workspace-database.ts";
import { registerPurgeCommand } from "../../src/octocode/sessions/purge-command.ts";
import { executePurge, planPurge } from "../../src/octocode/sessions/purge.ts";
import { SessionIndex } from "../../src/octocode/sessions/store.ts";
import { Subcommands } from "../../src/octocode/shared/commands.ts";
import { tmp } from "./helpers.ts";

let saved: { home?: string; db?: string };
let home: string;

beforeEach(() => {
	saved = { home: process.env.OCTOCODE_HOME, db: process.env.OCTOCODE_AGENT_DB };
	home = fs.realpathSync(tmp());
	process.env.OCTOCODE_HOME = home;
	delete process.env.OCTOCODE_AGENT_DB;
});

afterEach(() => {
	closeSharedAgentDb();
	for (const [key, value] of [
		["OCTOCODE_HOME", saved.home],
		["OCTOCODE_AGENT_DB", saved.db],
	] as const) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

const write = (file: string, text = "x") => {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, text);
	return file;
};

/** A registered workspace with transcripts, session data, temp, scratch, a kept `.octocode` topic and a database row per session. */
function workspace(name: string, ids: string[], pid: number | null = null) {
	const root = fs.realpathSync(tmp(`octocode-purge-${name}-`));
	const identity = registeredWorkspace(root, sharedAgentDb());
	const state = path.join(root, ".octocode", "code");
	for (const id of ids) {
		write(path.join(state, "sessions", `${id}.jsonl`), `${JSON.stringify({ type: "session", id, cwd: root })}\n`);
		write(path.join(state, "session-data", id, "output", "o.txt"));
		write(path.join(state, "temp", "sessions", id, "bash", "b.log"));
		sharedAgentDb()
			.db.prepare("INSERT INTO sessions (id, workspace_id, pid) VALUES (?, ?, ?)")
			.run(id, identity.id, pid);
	}
	write(path.join(state, "temp", "agents", "child", "report.md"));
	write(path.join(root, ".octocode", "tmp", "scratch.txt"));
	write(path.join(root, ".octocode", "research", "keep.md"));
	write(path.join(root, "my-notes.txt"));
	write(path.join(state, "settings.json"), "{}");
	return { root, state, id: identity.id };
}

const rowCount = (workspaceId: string): number =>
	(
		sharedAgentDb().db.prepare("SELECT count(*) AS n FROM sessions WHERE workspace_id = ?").get(workspaceId) as {
			n: number;
		}
	).n;

describe("/purge", () => {
	it("workspace removes this workspace's data and keeps the current session, other workspaces, settings and auth", async () => {
		const index = new SessionIndex(sharedAgentDb());
		const here = workspace("here", ["cur", "old-1", "old-2"]);
		const other = workspace("other", ["other-1"]);
		for (const file of ["auth.json", "mcp-auth.json", "settings.json"]) write(path.join(home, file), "{}");
		write(path.join(home, "child-credentials", "c.json"));

		const compaction = sharedAgentDb().mirror.db.prepare(
			"INSERT INTO compaction_summaries(workspace_id, session_id, entry_id, summary) VALUES (?, ?, 'c', 's')",
		);
		compaction.run(here.id, "cur");
		compaction.run(here.id, "old-1");

		const outcome = await executePurge(index, "workspace", { cwd: here.root, current: "cur" });
		expect("result" in outcome && outcome.result.failed).toEqual([]);
		// The current session keeps its compaction summaries (the archive tool's recall); the others' go.
		expect(sharedAgentDb().mirror.db.prepare("SELECT session_id FROM compaction_summaries").all()).toEqual([
			{ session_id: "cur" },
		]);

		expect(fs.existsSync(path.join(here.state, "sessions", "old-1.jsonl"))).toBe(false);
		expect(fs.existsSync(path.join(here.state, "sessions", "old-2.jsonl"))).toBe(false);
		expect(fs.existsSync(path.join(here.state, "session-data", "old-1"))).toBe(false);
		expect(fs.existsSync(path.join(here.state, "temp", "agents"))).toBe(false);
		expect(fs.existsSync(path.join(here.root, ".octocode", "tmp", "scratch.txt"))).toBe(false);
		// The current session and everything outside the purged roots stay.
		expect(fs.existsSync(path.join(here.state, "sessions", "cur.jsonl"))).toBe(true);
		expect(fs.existsSync(path.join(here.state, "session-data", "cur"))).toBe(true);
		expect(fs.existsSync(path.join(here.state, "workspace", "id"))).toBe(true);
		expect(fs.existsSync(path.join(here.state, "settings.json"))).toBe(true);
		expect(fs.existsSync(path.join(here.root, ".octocode", "research", "keep.md"))).toBe(true);
		expect(fs.existsSync(path.join(here.root, "my-notes.txt"))).toBe(true);
		for (const file of ["auth.json", "mcp-auth.json", "settings.json", "child-credentials/c.json"])
			expect(fs.existsSync(path.join(home, file))).toBe(true);
		// Another workspace is untouched, files and rows alike; this one's other rows are gone and the current session is registered again.
		expect(fs.existsSync(path.join(other.state, "sessions", "other-1.jsonl"))).toBe(true);
		expect(fs.existsSync(path.join(other.root, ".octocode", "tmp", "scratch.txt"))).toBe(true);
		expect(rowCount(other.id)).toBe(1);
		expect(index.get("old-1")).toBeUndefined();
		expect(index.get("cur")).toBeDefined();
	});

	it("all removes every workspace, the global root and the old database, and keeps settings and auth", async () => {
		const index = new SessionIndex(sharedAgentDb());
		const a = workspace("a", ["cur", "a-1"]);
		const b = workspace("b", ["b-1"]);
		write(path.join(home, "agent", "sessions", "global-1", "output", "o.txt"));
		write(path.join(home, "agent", "octocode.db"));
		write(path.join(home, "auth.json"), "{}");

		const outcome = await executePurge(index, "all", { cwd: a.root, current: "cur" });
		expect("result" in outcome && outcome.result.failed).toEqual([]);

		expect(fs.existsSync(path.join(b.state, "sessions", "b-1.jsonl"))).toBe(false);
		expect(fs.existsSync(path.join(b.root, ".octocode", "tmp"))).toBe(true);
		expect(fs.readdirSync(path.join(b.root, ".octocode", "tmp"))).toEqual([]);
		expect(fs.existsSync(path.join(b.root, ".octocode", "research", "keep.md"))).toBe(true);
		expect(fs.existsSync(path.join(home, "agent", "sessions", "global-1"))).toBe(false);
		expect(fs.existsSync(path.join(home, "agent", "octocode.db"))).toBe(false);
		expect(fs.existsSync(path.join(a.state, "sessions", "cur.jsonl"))).toBe(true);
		expect(fs.existsSync(path.join(home, "auth.json"))).toBe(true);
		expect(rowCount(b.id)).toBe(0);
	});

	it("is refused while another live process holds a session in scope, naming it, and deletes nothing", async () => {
		const index = new SessionIndex(sharedAgentDb());
		// The parent process is alive and is not this one.
		const here = workspace("live", ["cur", "busy"], process.ppid);
		const outcome = await executePurge(index, "workspace", { cwd: here.root, current: "cur" });
		expect(outcome).toMatchObject({ refused: expect.stringContaining(`pid ${process.ppid}`) });
		expect(fs.existsSync(path.join(here.state, "sessions", "busy.jsonl"))).toBe(true);
		expect((await planPurge(index, "workspace", { cwd: here.root, current: "cur" })).blockers).toHaveLength(1);
	});

	describe("command", () => {
		const setup = (here: ReturnType<typeof workspace>, hasUI: boolean, typed?: string) => {
			const commands = new Subcommands();
			registerPurgeCommand({} as never, commands, {
				index: () => new SessionIndex(sharedAgentDb()),
				current: () => "cur",
			});
			const notify = vi.fn();
			const input = vi.fn(async () => typed);
			const ctx = { cwd: here.root, hasUI, ui: { notify, input } } as never;
			return { run: (args: string) => commands.get("purge")!.handler(args, ctx), notify, input };
		};

		it("refuses without a UI and deletes nothing", async () => {
			const here = workspace("noui", ["cur", "old"]);
			const { run, input } = setup(here, false);
			const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
			await run("workspace");
			stderr.mockRestore();
			expect(input).not.toHaveBeenCalled();
			expect(fs.existsSync(path.join(here.state, "sessions", "old.jsonl"))).toBe(true);
		});

		it("deletes only when the typed word matches the scope", async () => {
			const here = workspace("typed", ["cur", "old"]);
			const wrong = setup(here, true, "yes");
			await wrong.run("workspace");
			expect(fs.existsSync(path.join(here.state, "sessions", "old.jsonl"))).toBe(true);
			expect(wrong.notify).toHaveBeenLastCalledWith(expect.stringContaining("nothing was deleted"), "info");
			// `all` is not accepted for a workspace purge, and a missing scope only prints usage.
			const mismatch = setup(here, true, "all");
			await mismatch.run("workspace");
			expect(fs.existsSync(path.join(here.state, "sessions", "old.jsonl"))).toBe(true);
			const right = setup(here, true, "workspace");
			await right.run("workspace");
			expect(fs.existsSync(path.join(here.state, "sessions", "old.jsonl"))).toBe(false);
			expect(right.notify).toHaveBeenLastCalledWith(expect.stringContaining("Database"), "info");
		});
	});
});

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeIdleWorkspaceFiles, closeSharedAgentDb, sessions, workspaces } from "../../../db/src/api.ts";
import type { Member } from "@octocodeai/octocode-contracts/team";
import { BacklogStore } from "../../src/octocode/backlog/store.ts";
import { processStartTime } from "../../src/octocode/shared/process.ts";
import { sessionRunningPid } from "../../src/octocode/shared/session-liveness.ts";
import { TeamStore } from "../../src/octocode/team/store.ts";
import { deferredSplit, sharedAgentDb } from "../../src/storage/database.ts";
import { workspaceDbDir } from "../../src/storage/state-paths.ts";
import { everyWorkspaceFile, registeredWorkspaceAgent, workspaceDb } from "../../src/storage/workspace-database.ts";

const READY = { goal: "Observable result", why: "Needed", createdBy: "agent" as const };

let root: string;
let machineFile: string;

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "ignore" });

/** A Git repository with one commit at `dir`. */
function repository(dir: string): string {
	fs.mkdirSync(dir, { recursive: true });
	git(dir, "init", "-q");
	git(dir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
	return fs.realpathSync(dir);
}

const board = (dir: string) => {
	const { agent, workspace } = workspaceDb(dir);
	return new BacklogStore(() => agent, workspace.id);
};

const backlogRows = (file: string) => {
	const agent = sharedAgentDb();
	return agent.file === file
		? (agent.db.prepare("SELECT count(*) AS n FROM backlog").get() as { n: number }).n
		: undefined;
};

beforeEach(() => {
	root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "octocode-workspace-files-")));
	machineFile = path.join(root, "state", "agent.db");
	vi.stubEnv("OCTOCODE_AGENT_DB", machineFile);
	vi.stubEnv("OCTOCODE_TEST_WORKSPACE_FILES", "1");
});

afterEach(() => {
	closeSharedAgentDb();
	vi.unstubAllEnvs();
	fs.rmSync(root, { recursive: true, force: true });
});

describe("workspace files", () => {
	it("keeps each repository's rows in its own file, never in the machine file or another's", () => {
		const first = repository(path.join(root, "first"));
		const second = repository(path.join(root, "second"));
		board(first).add({ ...READY, title: "First repository work", state: "todo" });
		const a = workspaceDb(first);
		const b = workspaceDb(second);
		expect(a.agent.file).not.toBe(b.agent.file);
		expect(path.dirname(a.agent.file)).toBe(workspaceDbDir(machineFile));
		expect(
			board(first)
				.list({})
				.items.map((item) => item.title),
		).toEqual(["First repository work"]);
		expect(board(second).list({}).items).toEqual([]);
		expect(backlogRows(machineFile)).toBe(0);
		expect(everyWorkspaceFile(sharedAgentDb()).map((file) => file.file)).toEqual(
			expect.arrayContaining([a.agent.file, b.agent.file]),
		);
	});

	it("gives a linked worktree its main checkout's file and its own board, whichever opens first", () => {
		const main = repository(path.join(root, "main"));
		const linked = path.join(root, "linked");
		git(main, "worktree", "add", "-q", "-b", "side", linked);
		const worktree = workspaceDb(fs.realpathSync(linked));
		const parent = workspaceDb(main);
		expect(worktree.agent.file).toBe(parent.agent.file);
		expect(worktree.workspace.id).not.toBe(parent.workspace.id);
		board(main).add({ ...READY, title: "Main checkout work", state: "todo" });
		expect(board(fs.realpathSync(linked)).list({}).items).toEqual([]);
		const keys = workspaces.list(sharedAgentDb().db).map((row) => row.dbKey);
		expect(new Set(keys).size).toBe(1);
	});

	it("names the main checkout's id as the file of a worktree opened after it", () => {
		const main = repository(path.join(root, "main"));
		const linked = path.join(root, "linked");
		git(main, "worktree", "add", "-q", "-b", "side", linked);
		const parent = workspaceDb(main);
		const worktree = workspaceDb(fs.realpathSync(linked));
		expect(path.basename(worktree.agent.file)).toBe(`${parent.workspace.id}.db`);
	});

	it("closes an idle workspace connection and reopens it on the next access", () => {
		const repo = repository(path.join(root, "repo"));
		board(repo).add({ ...READY, title: "Kept across reopen", state: "todo" });
		const { agent } = workspaceDb(repo);
		expect(closeIdleWorkspaceFiles(60_000)).toEqual([]);
		expect(closeIdleWorkspaceFiles(0, Date.now() + 1)).toEqual([agent.file]);
		expect(agent.db.isOpen).toBe(false);
		expect(sharedAgentDb().db.isOpen).toBe(true);
		expect(
			board(repo)
				.list({})
				.items.map((item) => item.title),
		).toEqual(["Kept across reopen"]);
	});

	it("reads a board holder's liveness from the machine file's session rows", () => {
		const repo = repository(path.join(root, "repo"));
		const { agent } = workspaceDb(repo);
		const machine = sharedAgentDb();
		sessions.start(machine.db, "live-session", process.pid, null, null);
		expect(agent.file).not.toBe(machine.file);
		expect(sessionRunningPid(agent.db, "live-session", true)).toBe(process.pid);
	});

	it("records a joining member's session folder on the machine file's session row", () => {
		const repo = repository(path.join(root, "repo"));
		const { agent } = workspaceDb(repo);
		const store = TeamStore.open(repo, machineFile);
		store.lifecycle = { activationId: "start", sessionId: "joined", cwd: repo, dir: path.join(root, "sessions") };
		const member: Member = {
			id: "amber-otter",
			role: "main",
			pid: process.pid,
			status: "idle",
			joinedAt: 1,
			updatedAt: 1,
			toolCalls: 0,
			input: 0,
			cacheRead: 0,
			output: 0,
			cost: 0,
			unpriced: false,
		};
		expect(store.join(member)).toBe(true);
		const where = (file: { db: typeof agent.db }) =>
			file.db.prepare("SELECT cwd, dir FROM sessions WHERE id = 'joined'").get();
		expect(where(sharedAgentDb())).toEqual({ cwd: repo, dir: path.join(root, "sessions") });
		expect(where(agent)).toBeUndefined();
	});

	it("refuses a workspace no machine file row registers instead of using the machine file", () => {
		expect(() => registeredWorkspaceAgent("never-registered")).toThrow(/never-registered is not registered/);
	});
});

describe("the first open with workspace files", () => {
	/** A machine file written with workspace files off, holding one repository's backlog item and a session of `pid`. */
	function unsplit(pid: number): string {
		vi.stubEnv("OCTOCODE_TEST_WORKSPACE_FILES", "0");
		const repo = repository(path.join(root, "repo"));
		board(repo).add({ ...READY, title: "Made before the split", state: "todo" });
		sessions.start(sharedAgentDb().db, "other", pid, processStartTime(pid) ?? null, null);
		closeSharedAgentDb();
		vi.stubEnv("OCTOCODE_TEST_WORKSPACE_FILES", "1");
		return repo;
	}

	it("puts the split off while another process runs, naming it, keeping the shared layout", () => {
		const repo = unsplit(process.ppid);
		expect(sharedAgentDb().workspaceDir).toBeUndefined();
		expect(deferredSplit()).toMatch(new RegExp(`other \\(pid ${process.ppid}\\)`));
		expect(fs.existsSync(workspaceDbDir(machineFile))).toBe(false);
		expect(
			board(repo)
				.list({})
				.items.map((item) => item.title),
		).toEqual(["Made before the split"]);
		expect(backlogRows(machineFile)).toBe(1);
	});

	it("waits for every other process, then moves the rows", () => {
		const repo = unsplit(process.ppid);
		vi.stubEnv("OCTOCODE_TEST_WORKSPACE_FILES", "0");
		expect(backlogRows(machineFile)).toBe(1);
		// The process ended and the system gave its pid to another: the recorded start time no longer matches.
		sharedAgentDb().db.exec("UPDATE sessions SET pid_started = '1' WHERE id = 'other'");
		closeSharedAgentDb();
		vi.stubEnv("OCTOCODE_TEST_WORKSPACE_FILES", "1");
		expect(backlogRows(machineFile)).toBe(0);
		expect(
			board(repo)
				.list({})
				.items.map((item) => item.title),
		).toEqual(["Made before the split"]);
	});

	it("is refused, loudly, by a host with workspace files off once split", () => {
		const repo = unsplit(999_999);
		expect(
			board(repo)
				.list({})
				.items.map((item) => item.title),
		).toEqual(["Made before the split"]);
		closeSharedAgentDb();
		vi.stubEnv("OCTOCODE_TEST_WORKSPACE_FILES", "0");
		expect(() => sharedAgentDb()).toThrow(/split into workspace files/);
	});
});

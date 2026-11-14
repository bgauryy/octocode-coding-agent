import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { tmp } from "./helpers.ts";

const calls = { count: 0, fail: true };
vi.mock("../../src/utils/git-command.ts", () => ({
	gitSync: () => {
		calls.count++;
		if (calls.fail) throw new Error("git timed out");
		return "";
	},
}));

const { workspaceGit } = await import("../../src/utils/git-repository.ts");

describe("git repository discovery after a failed lookup", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		calls.count = 0;
		calls.fail = true;
	});

	it("waits longer after each failure in a row instead of running git on every call", () => {
		const repo = tmp("octocode-git-backoff-");
		fs.mkdirSync(path.join(repo, ".git"));
		let now = 1_000_000;
		vi.spyOn(Date, "now").mockImplementation(() => now);

		expect(workspaceGit(repo)).toBeUndefined();
		expect(calls.count).toBe(1);
		// A burst of synchronous callers (session appends, permission checks) inside the first second shares the failure.
		for (let i = 0; i < 50; i++) workspaceGit(repo);
		expect(calls.count).toBe(1);

		now += 1_001;
		workspaceGit(repo);
		expect(calls.count).toBe(2);
		// The second failure is remembered for 2 s, the third for 4 s.
		now += 1_500;
		workspaceGit(repo);
		expect(calls.count).toBe(2);
		now += 600;
		workspaceGit(repo);
		expect(calls.count).toBe(3);
		now += 3_900;
		workspaceGit(repo);
		expect(calls.count).toBe(3);
		now += 200;
		workspaceGit(repo);
		expect(calls.count).toBe(4);

		// Never more than a minute, however long the run of failures.
		for (let i = 0; i < 20; i++) {
			now += 60_001;
			workspaceGit(repo);
		}
		expect(calls.count).toBe(24);
	});

	it("looks again at once when the checkout's marker changes", () => {
		const repo = tmp("octocode-git-backoff-");
		fs.mkdirSync(path.join(repo, ".git"));
		const now = 2_000_000;
		vi.spyOn(Date, "now").mockImplementation(() => now);

		expect(workspaceGit(repo)).toBeUndefined();
		expect(calls.count).toBe(1);
		// Replaced by a linked-worktree pointer file: a new inode is a new revision, so the cached failure no longer applies.
		fs.rmSync(path.join(repo, ".git"), { recursive: true });
		fs.writeFileSync(path.join(repo, ".git"), "gitdir: /elsewhere\n");
		calls.fail = false;
		workspaceGit(repo);
		// Git ran again inside the first failure's second (the empty mock output also takes the per-field queries).
		expect(calls.count).toBeGreaterThan(1);
	});
});

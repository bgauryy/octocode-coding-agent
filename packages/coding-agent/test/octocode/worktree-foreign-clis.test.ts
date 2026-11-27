import { realpathSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProcessRow } from "../../src/octocode/processes/table.ts";
import { foreignCliRows, foreignClis } from "../../src/octocode/worktrees/foreign-clis.ts";
import { describeWorktrees } from "../../src/octocode/worktrees/summary.ts";
import { GIT_TEST_ENV, makeRepo, type TestRepo } from "./worktree-fixture.ts";

const row = (pid: number, ppid: number, command: string): ProcessRow => ({
	pid,
	ppid,
	rssKb: 1,
	started: "1",
	command,
});

describe("foreignCliRows", () => {
	it("finds agent CLIs by executable, one row per session, and skips helpers and Octocode's own runs", () => {
		const rows = [
			row(10, 1, "/Users/me/.local/bin/claude --resume"),
			row(20, 1, "node /usr/lib/node_modules/@openai/codex/bin/codex.js"),
			row(21, 20, "/usr/lib/node_modules/@openai/codex/vendor/codex/codex"),
			row(30, 1, "/Users/me/.local/bin/claude --chrome-native-host"),
			row(40, 1, "node octocode"),
			row(41, 40, "claude -p hello"),
			row(50, 1, "claude-agent-acp"),
			row(60, 1, "/Applications/Codex.app/Contents/MacOS/Codex (Renderer)"),
			row(70, 1, "cursor-agent"),
		];
		const found = foreignCliRows(rows, [40]).map(({ pid, name }) => [pid, name]);
		expect(found).toEqual([
			[10, "Claude Code"],
			[20, "Codex"],
			[70, "Cursor agent"],
		]);
	});

	it("lists nothing when the process table cannot be read, and drops a CLI whose folder is unknown", async () => {
		expect(await foreignClis({ table: async () => undefined, cwdOf: async () => new Map() })).toEqual([]);
		const clis = await foreignClis({
			table: async () => [row(10, 1, "claude"), row(11, 1, "codex")],
			cwdOf: async () => new Map([[10, "/repo"]]),
			ownRoots: [],
		});
		expect(clis).toEqual([{ pid: 10, name: "Claude Code", cwd: "/repo" }]);
	});
});

describe("describeWorktrees with other agent CLIs", () => {
	const saved = { ...process.env };
	let repo: TestRepo;
	beforeEach(() => {
		Object.assign(process.env, GIT_TEST_ENV);
		repo = makeRepo();
	});
	afterEach(() => {
		repo.cleanup();
		process.env = { ...saved };
	});

	it("names a CLI working in this repository under its worktree, even with no linked worktree or tmux", async () => {
		const main = realpathSync(repo.root);
		const text = await describeWorktrees(repo.root, {
			env: { ...process.env, TMUX: "" },
			members: () => [],
			foreign: async () => [
				{ pid: 123, name: "Claude Code", cwd: path.join(main, "src") },
				{ pid: 456, name: "Codex", cwd: path.dirname(main) },
			],
		});
		expect(text).toContain("other agent CLIs: Claude Code pid 123");
		expect(text).toContain("get no `message`");
		expect(text).not.toContain("456");
	});

	it("stays silent when the only CLIs run outside this repository", async () => {
		const text = await describeWorktrees(repo.root, {
			env: { ...process.env, TMUX: "" },
			members: () => [],
			foreign: async () => [{ pid: 456, name: "Codex", cwd: "/" }],
		});
		expect(text).toBeUndefined();
	});

	it("passes this process and every team member as Octocode's own process roots", async () => {
		let seen: readonly number[] = [];
		await describeWorktrees(repo.root, {
			env: { ...process.env, TMUX: "" },
			members: () => [{ id: "a", role: "main", pid: 777 } as never],
			foreign: async (own) => {
				seen = own;
				return [];
			},
		});
		expect(seen).toEqual([process.pid, 777]);
	});
});

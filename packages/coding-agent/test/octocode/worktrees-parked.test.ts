import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionCommandContext } from "../../src/core/features/index.ts";
import { closeSharedAgentDb } from "../../src/octocode/agentdb/db.ts";
import { scratchRoot } from "../../src/octocode/subagents/handoff/scratch.ts";
import { allParked, writeParked, type ParkedWorker } from "../../src/octocode/subagents/parked.ts";
import { resolveFolderTrust } from "../../src/octocode/trust/resolve.ts";
import { allowWorktreeGrants } from "../../src/octocode/worktrees/approval.ts";
import { worktreeCommand } from "../../src/octocode/worktrees/command.ts";
import { ensureWorktree } from "../../src/octocode/worktrees/create.ts";
import { GIT_TEST_ENV, makeRepo, type TestRepo } from "./worktree-fixture.ts";
import { tmp } from "./helpers.ts";

let repo: TestRepo;
let notices: Array<{ text: string; level: string }>;
const text = () => notices.map((n) => n.text).join("\n");
const contextAt = (cwd: string) =>
	({
		cwd,
		hasUI: true,
		ui: { notify: (note: string, level = "info") => void notices.push({ text: note, level }) },
	}) as unknown as ExtensionCommandContext;

beforeEach(() => {
	allowWorktreeGrants(true); // these tests are about worktrees, not trust: a headless `--trust` run
	for (const [key, value] of Object.entries(GIT_TEST_ENV)) vi.stubEnv(key, value);
	vi.stubEnv("OCTOCODE_HOME", tmp("octocode-wt-parked-home-"));
	vi.stubEnv("OCTOCODE_AGENT_DB", path.join(tmp("octocode-wt-parked-db-"), "octocode.db"));
	vi.stubEnv("TMUX", "");
	vi.stubEnv("TMUX_PANE", "");
	notices = [];
	repo = makeRepo();
});

afterEach(() => {
	closeSharedAgentDb();
	vi.unstubAllEnvs();
	repo.cleanup();
});

/** A finished child of `session` whose follow-up window is open for `until`, with its saved conversation on disk. */
function park(session: string, id: string, workspace: string, until: number): void {
	const scratch = path.join(scratchRoot(workspace), id);
	mkdirSync(path.join(scratch, "session"), { recursive: true });
	writeFileSync(path.join(scratch, "session", `2026-01-01T00-00-00-000Z_${id}.jsonl`), "{}\n");
	const worker = {
		until,
		generation: 1,
		workspace,
		run: { identity: { id, role: "researcher", goal: "read", parentSession: session, scratch }, route: {} },
	} as unknown as ParkedWorker;
	writeParked(session, [worker]);
}

describe("/worktree remove with parked children", () => {
	it("refuses while a session keeps a finished child reachable there, names it, and --force removes", async () => {
		const info = await ensureWorktree(repo.root, "feat");
		park("session-one", "kid-aaaaaa", info.path, Date.now() + 60_000);
		expect(allParked()).toEqual([
			{ id: "kid-aaaaaa", role: "researcher", session: "session-one", workspace: info.path },
		]);

		const command = worktreeCommand({ env: { ...process.env }, parked: allParked });
		await command.handler("remove feat", contextAt(repo.root));
		expect(notices.at(-1)).toMatchObject({ level: "warning" });
		expect(text()).toContain("kid-aaaaaa (researcher, session session-one)");
		expect(text()).toContain("--force");
		expect(existsSync(info.path)).toBe(true);

		await command.handler("remove feat --force", contextAt(repo.root));
		expect(existsSync(info.path)).toBe(false);
	});

	it("ignores an expired window and a child parked in another worktree", async () => {
		const feat = await ensureWorktree(repo.root, "feat");
		const other = await ensureWorktree(repo.root, "other");
		park("session-old", "kid-bbbbbb", feat.path, Date.now() - 1000);
		park("session-two", "kid-cccccc", other.path, Date.now() + 60_000);
		expect(allParked().map((child) => child.id)).toEqual(["kid-cccccc"]);
		await worktreeCommand({ env: { ...process.env }, parked: allParked }).handler("remove feat", contextAt(repo.root));
		// Only its own scratch folder (untracked work) keeps it: neither child counts as someone in use of the worktree.
		expect(text()).not.toContain("in use");
		expect(text()).not.toContain("kid-");
		expect(text()).toContain("untracked");
		await worktreeCommand({ env: { ...process.env }, parked: allParked }).handler("remove other", contextAt(repo.root));
		expect(text()).toContain('Worktree "other" is in use');
	});

	it("counts a child parked in a subfolder of the worktree", async () => {
		const info = await ensureWorktree(repo.root, "feat");
		const sub = path.join(info.path, "src");
		mkdirSync(sub);
		park("session-three", "kid-dddddd", sub, Date.now() + 60_000);
		await worktreeCommand({ env: { ...process.env }, parked: allParked }).handler("remove feat", contextAt(repo.root));
		expect(text()).toContain("kid-dddddd");
		expect(existsSync(info.path)).toBe(true);
	});
});

describe("/worktree remove revokes the trust grant", () => {
	it("revokes the removed worktree's grant and keeps the others", async () => {
		const feat = await ensureWorktree(repo.root, "feat");
		const keep = await ensureWorktree(repo.root, "keep");
		expect(resolveFolderTrust(feat.path).state).toBe("trusted");
		expect(resolveFolderTrust(keep.path).state).toBe("trusted");

		await worktreeCommand({ env: { ...process.env } }).handler("remove feat", contextAt(repo.root));
		expect(existsSync(feat.path)).toBe(false);
		expect(resolveFolderTrust(keep.path).state).toBe("trusted");
		expect(resolveFolderTrust(realpathSync(repo.root)).state).not.toBe("trusted");
	});
});

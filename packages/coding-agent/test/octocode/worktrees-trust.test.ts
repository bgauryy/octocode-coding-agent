import { existsSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeSharedAgentDb } from "../../../db/src/api.ts";
import { grantFolder } from "../../src/octocode/trust/grants.ts";
import { resolveFolderTrust } from "../../src/octocode/trust/resolve.ts";
import type { CommandContext } from "../../src/core/features/index.ts";
import { allowWorktreeGrants, worktreeTrustTitle } from "../../src/octocode/worktrees/approval.ts";
import { worktreeCommand } from "../../src/octocode/worktrees/command.ts";
import { ensureWorktree } from "../../src/octocode/worktrees/create.ts";
import { removeWorktree } from "../../src/octocode/worktrees/remove.ts";
import { GIT_TEST_ENV, makeRepo, type TestRepo } from "./worktree-fixture.ts";
import { tmp } from "./helpers.ts";

/** Folder trust for a worktree Octocode creates: asked once before `git worktree add`, recorded after, revoked on removal. */
let repo: TestRepo;

beforeEach(() => {
	for (const [key, value] of Object.entries(GIT_TEST_ENV)) vi.stubEnv(key, value);
	vi.stubEnv("OCTOCODE_HOME", tmp("octocode-wt-trust-home-"));
	vi.stubEnv("OCTOCODE_AGENT_DB", path.join(tmp("octocode-wt-trust-db-"), "octocode.db"));
	allowWorktreeGrants(false);
	repo = makeRepo();
});

afterEach(() => {
	allowWorktreeGrants(false);
	closeSharedAgentDb();
	vi.unstubAllEnvs();
	repo.cleanup();
});

const target = () => path.join(repo.root, ".octocode", "agent", "worktrees", "feat");
const trustOf = (folder: string) => resolveFolderTrust(folder);

describe("trust for worktrees Octocode creates", () => {
	it("asks, and a yes creates the worktree and records a worktree grant from the checkout", async () => {
		const asked: string[] = [];
		const info = await ensureWorktree(repo.root, "feat", async (request) => {
			asked.push(worktreeTrustTitle(request));
			expect(existsSync(request.path)).toBe(false);
			return true;
		});
		expect(info.created).toBe(true);
		expect(asked).toHaveLength(1);
		expect(asked[0]).toMatch(/^Trust new worktree .*feat.* \(from .*repo.*\)\? .*repo is not trusted either/u);
		const state = trustOf(target());
		expect(state.state).toBe("trusted");
		if (state.state === "trusted") expect(state.grant.source).toBe("worktree");
	});

	it("a no creates nothing and records nothing", async () => {
		await expect(ensureWorktree(repo.root, "feat", async () => false)).rejects.toThrow(/Worktree not created/u);
		expect(existsSync(target())).toBe(false);
		expect(trustOf(path.dirname(target())).state).not.toBe("trusted");
	});

	it("with nobody to ask it needs --trust, and creates nothing without it", async () => {
		await expect(ensureWorktree(repo.root, "feat")).rejects.toThrow(/Run again with --trust/u);
		expect(existsSync(target())).toBe(false);
		allowWorktreeGrants(true);
		await ensureWorktree(repo.root, "feat");
		expect(trustOf(target()).state).toBe("trusted");
	});

	it("does not ask when a subtree grant already covers the new folder", async () => {
		grantFolder(repo.root, "parent", { source: "command", surface: "cli" });
		const ask = vi.fn(async () => false);
		await ensureWorktree(repo.root, "feat", ask);
		expect(ask).not.toHaveBeenCalled();
		expect(existsSync(target())).toBe(true);
	});

	it("does not ask again, in a session, for a worktree of a checkout trusted as a folder, and records its grant", async () => {
		// A folder grant covers the checkout only, not its subfolders; the worktree holds that checkout's contents at HEAD.
		grantFolder(repo.root, "folder", { source: "command", surface: "cli" });
		const ask = vi.fn(async () => false);
		const info = await ensureWorktree(repo.root, "feat", ask);
		expect(ask).not.toHaveBeenCalled();
		expect(info.created).toBe(true);
		const state = trustOf(target());
		expect(state.state).toBe("trusted");
		if (state.state === "trusted") expect(state.grant.source).toBe("worktree");
		// With nobody to ask (a headless run) recording that grant still takes --trust.
		await expect(ensureWorktree(repo.root, "other")).rejects.toThrow(/Run again with --trust/u);
	});

	it("removing the worktree revokes its grant", async () => {
		await ensureWorktree(repo.root, "feat", async () => true);
		expect(trustOf(target()).state).toBe("trusted");
		const removed = await removeWorktree(repo.root, "feat", { force: true });
		expect(removed.removed).toBe(true);
		// The folder is gone, and so is its grant: a worktree recreated at the same path asks again.
		await expect(ensureWorktree(repo.root, "feat")).rejects.toThrow(/Run again with --trust/u);
	});

	it("reusing an existing worktree asks nothing", async () => {
		await ensureWorktree(repo.root, "feat", async () => true);
		const ask = vi.fn(async () => false);
		const again = await ensureWorktree(repo.root, "feat", ask);
		expect(again.created).toBe(false);
		expect(ask).not.toHaveBeenCalled();
	});
});

describe("/worktree new when the user declines the trust question", () => {
	it("says it was cancelled, as every declined confirmation does, not that something failed", async () => {
		const notices: Array<{ text: string; level: string }> = [];
		const ctx = {
			cwd: repo.root,
			hasUI: true,
			sessionManager: { getSessionId: () => "sess-1" },
			ui: {
				notify: (text: string, level = "info") => void notices.push({ text, level }),
				confirm: async () => false,
			},
		} as unknown as CommandContext;
		await worktreeCommand().handler("new feat", ctx);
		expect(notices).toEqual([{ text: "Cancelled: nothing was created.", level: "info" }]);
		expect(existsSync(target())).toBe(false);
	});
});

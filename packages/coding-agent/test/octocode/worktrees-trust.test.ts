import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeSharedAgentDb } from "../../src/octocode/agentdb/db.ts";
import { projectTrust, projectTrustNow, saveDecision } from "../../src/octocode/shared/trust.ts";
import { fingerprint, projectConfigFiles } from "../../src/octocode/shared/trust/files.ts";
import { ensureWorktree } from "../../src/octocode/worktrees/create.ts";
import { GIT_TEST_ENV, makeRepo, sh, type TestRepo } from "./worktree-fixture.ts";
import { tmp } from "./helpers.ts";

const HOOKS = JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo hi" }] }] } });

let repo: TestRepo;
let other: TestRepo | undefined;

/** A session in `cwd` whose host already trusts the folder, as a core trust entry for the main checkout does for its worktrees. */
const ctx = (cwd: string) => ({ cwd, hasUI: false, isProjectTrusted: () => true });

/** The user ran `/trust` in the main checkout: exactly its gated files are trusted. */
const trustMain = (trusted = true) => saveDecision(repo.root, fingerprint(projectConfigFiles(repo.root)), trusted);

beforeEach(() => {
	for (const [key, value] of Object.entries(GIT_TEST_ENV)) vi.stubEnv(key, value);
	vi.stubEnv("OCTOCODE_HOME", tmp("octocode-wt-trust-home-"));
	vi.stubEnv("OCTOCODE_AGENT_DB", path.join(tmp("octocode-wt-trust-db-"), "octocode.db"));
	vi.stubEnv("OCTOCODE_SUBAGENT", undefined);
	vi.stubEnv("OCTOCODE_TRUST_ROOT", undefined);
	repo = makeRepo({ commit: false });
	repo.write(".codex/hooks.json", HOOKS);
	sh(repo.root, "add", ".");
	sh(repo.root, "commit", "-q", "-m", "first");
});

afterEach(() => {
	closeSharedAgentDb();
	vi.unstubAllEnvs();
	repo.cleanup();
	other?.cleanup();
	other = undefined;
});

describe("trust for worktrees Octocode creates", () => {
	it("asks about a main checkout nobody trusted, so the baseline is a question", async () => {
		const info = await ensureWorktree(repo.root, "feat");
		expect(projectTrustNow(ctx(repo.root))).toBeUndefined();
		expect(projectTrustNow(ctx(info.path))).toBeUndefined();
	});

	it("inherits the trusted main checkout's decision for unchanged files", async () => {
		trustMain();
		const info = await ensureWorktree(repo.root, "feat");
		expect(projectConfigFiles(info.path)).toHaveLength(1);
		expect(projectTrustNow(ctx(info.path))).toBe(true);
		expect(await projectTrust(ctx(info.path))).toBe(true);
		// A subfolder of the worktree is the same project.
		mkdirSync(path.join(info.path, "sub"));
		expect(projectTrustNow(ctx(path.join(info.path, "sub")))).toBe(true);
	});

	it("stops trusting when a gated file changes in the worktree", async () => {
		trustMain();
		const info = await ensureWorktree(repo.root, "feat");
		writeFileSync(path.join(info.path, ".codex", "hooks.json"), HOOKS.replace("echo hi", "echo evil"));
		expect(projectTrustNow(ctx(info.path))).toBeUndefined();
		writeFileSync(path.join(info.path, ".codex", "hooks.json"), HOOKS);
		expect(projectTrustNow(ctx(info.path))).toBe(true);
		mkdirSync(path.join(info.path, ".octocode"), { recursive: true });
		writeFileSync(
			path.join(info.path, ".octocode", "mcp.json"),
			JSON.stringify({ mcpServers: { x: { command: "x" } } }),
		);
		expect(projectTrustNow(ctx(info.path))).toBeUndefined();
	});

	it("follows the main checkout's decision: distrusting it there takes the trust away", async () => {
		trustMain();
		const info = await ensureWorktree(repo.root, "feat");
		expect(projectTrustNow(ctx(info.path))).toBe(true);
		trustMain(false);
		expect(projectTrustNow(ctx(info.path))).toBeUndefined();
		trustMain();
		expect(projectTrustNow(ctx(info.path))).toBe(true);
	});

	it("keeps trusting the exact files the user trusted when the main checkout later changes them", async () => {
		trustMain();
		const info = await ensureWorktree(repo.root, "feat");
		writeFileSync(path.join(repo.root, ".codex", "hooks.json"), HOOKS.replace("echo hi", "echo changed"));
		expect(projectTrustNow(ctx(repo.root))).toBeUndefined();
		expect(projectTrustNow(ctx(info.path))).toBe(true);
	});

	it("never overrides a host that does not trust the folder", async () => {
		trustMain();
		const info = await ensureWorktree(repo.root, "feat");
		expect(projectTrustNow({ cwd: info.path, isProjectTrusted: () => false })).toBe(false);
	});

	it("keeps an explicit distrust recorded for the worktree itself", async () => {
		trustMain();
		const info = await ensureWorktree(repo.root, "feat");
		saveDecision(info.path, fingerprint(projectConfigFiles(info.path)), false);
		expect(projectTrustNow(ctx(info.path))).toBe(false);
	});

	it("still asks about a worktree made with plain git worktree add", async () => {
		trustMain();
		const plain = path.join(repo.root, ".octocode", "worktrees", "manual");
		sh(repo.root, "worktree", "add", "-q", "-b", "manual", plain);
		const sibling = path.join(path.dirname(repo.root), "sibling");
		sh(repo.root, "worktree", "add", "-q", "-b", "sibling", sibling);
		expect(projectTrustNow(ctx(plain))).toBeUndefined();
		expect(projectTrustNow(ctx(sibling))).toBeUndefined();
		// Octocode's own worktree next to them is trusted.
		expect(projectTrustNow(ctx((await ensureWorktree(repo.root, "made")).path))).toBe(true);
	});

	it("cannot be claimed by files in the branch", async () => {
		trustMain();
		const plain = path.join(repo.root, ".octocode", "worktrees", "manual");
		sh(repo.root, "worktree", "add", "-q", "-b", "manual", plain);
		for (const forged of [".octocode/worktree-origin.json", ".octocode/origin", ".git-created-by-octocode"]) {
			mkdirSync(path.dirname(path.join(plain, forged)), { recursive: true });
			writeFileSync(
				path.join(plain, forged),
				JSON.stringify({ main: repo.root, created: true, createdBy: "octocode" }),
			);
		}
		expect(projectTrustNow(ctx(plain))).toBeUndefined();
	});

	it("does not carry a record over to another repository's worktree at the same path", async () => {
		trustMain();
		const info = await ensureWorktree(repo.root, "feat");
		sh(repo.root, "worktree", "remove", "--force", info.path);
		other = makeRepo({ commit: false });
		other.write(".codex/hooks.json", HOOKS);
		sh(other.root, "add", ".");
		sh(other.root, "commit", "-q", "-m", "first");
		mkdirSync(path.dirname(info.path), { recursive: true });
		sh(other.root, "worktree", "add", "-q", "-b", "feat", info.path);
		// Same path, identical files, but another repository: the main checkout's decision does not reach it.
		expect(projectTrustNow(ctx(info.path))).toBeUndefined();
		rmSync(info.path, { recursive: true, force: true });
	});

	it("records nothing and does not break creation when the record cannot be written", async () => {
		trustMain();
		// A folder where the record file belongs: the atomic write fails.
		mkdirSync(path.join(process.env.OCTOCODE_HOME ?? "", "worktree-origins.json"), { recursive: true });
		const info = await ensureWorktree(repo.root, "feat");
		expect(info.created).toBe(true);
		expect(projectTrustNow(ctx(info.path))).toBeUndefined();
	});

	it("leaves the main checkout on its own decision", () => {
		trustMain();
		expect(projectTrustNow(ctx(repo.root))).toBe(true);
		trustMain(false);
		expect(projectTrustNow(ctx(repo.root))).toBe(false);
	});
});

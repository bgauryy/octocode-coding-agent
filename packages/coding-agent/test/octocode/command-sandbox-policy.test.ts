import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { type SandboxContext, sandboxPolicy } from "../../src/octocode/permission/sandbox/policy.ts";
import { PERMISSION_MODES } from "../../src/octocode/permission/mode.ts";
import { tmp } from "./helpers.ts";
import { mainEnv, repoWithWorktree } from "./sandbox-helpers.ts";

const context = (setting: SandboxContext["setting"], mode: SandboxContext["mode"], env = mainEnv()) => ({
	setting,
	mode,
	env,
});

describe("the sandbox policy", () => {
	it("follows sandbox.mode and the permission mode: off never, auto in every mode but bypass, on always", () => {
		const workspace = tmp();
		const sandboxed = (setting: SandboxContext["setting"]) =>
			PERMISSION_MODES.filter((mode) => sandboxPolicy(workspace, context(setting, mode)) !== undefined);
		expect(sandboxed("off")).toEqual([]);
		expect(sandboxed("auto")).toEqual(["manual", "workspace", "full"]);
		expect(sandboxed("on")).toEqual(["manual", "workspace", "full", "bypass"]);
	});

	it("writes the workspace, the temporary folders, the scratch folder and the host lock, the same in every sandboxed mode", () => {
		const workspace = fs.realpathSync(tmp());
		const scratch = path.join(workspace, ".octocode", "agent", "temp", "agents", "a");
		const env = mainEnv({ OCTOCODE_AGENT_SCRATCH: scratch });
		const policy = sandboxPolicy(workspace, context("auto", "manual", env));
		expect(policy?.allowWrite).toEqual(
			expect.arrayContaining([
				workspace,
				fs.realpathSync(os.tmpdir()),
				"/tmp",
				scratch,
				path.join(os.userInfo().homedir, ".octocode", "locks"),
			]),
		);
		for (const mode of ["workspace", "full"] as const)
			expect(sandboxPolicy(workspace, context("auto", mode, env))).toEqual(policy);
		expect(sandboxPolicy(workspace, context("on", "bypass", env))).toEqual(policy);
	});

	it("protects what later sessions load, present or not, and keeps the state folder's scratch writable", () => {
		const workspace = fs.realpathSync(tmp());
		fs.mkdirSync(path.join(workspace, ".octocode", "agent", "newer"), { recursive: true });
		const denied = sandboxPolicy(workspace, context("auto", "full"))?.denyWrite ?? [];
		const at = (...parts: string[]) => path.join(workspace, ...parts);
		expect(denied).toEqual(
			expect.arrayContaining([
				at(".git", "hooks"),
				at(".git", "config"),
				at("**", ".git", "hooks"),
				at(".octocode", "skills"),
				at(".octocode", "settings.json"),
				at(".octocode", "hooks.json"),
				at("AGENTS.md"),
				at(".claude"),
				at(".agents"),
				at(".husky"),
				at(".octocode", "agent", "sessions"),
				at(".octocode", "agent", "MEMORY.md"),
				at(".octocode", "agent", "worktrees", "*", "AGENTS.md"),
				"/tmp/claude",
			]),
		);
		expect(denied).not.toContain(at(".git"));
		expect(denied).not.toContain(at(".octocode", "agent", "temp"));
		expect(denied).not.toContain(at(".octocode", "agent", "newer"));
		expect(denied).not.toContain(at(".octocode", "agent"));
	});

	it("lets a read-only child write only its throwaway folders and Markdown under .octocode/agent/", () => {
		const workspace = fs.realpathSync(tmp());
		const env = mainEnv({ OCTOCODE_SUBAGENT: "1", OCTOCODE_READ_ONLY: "1" });
		const policy = sandboxPolicy(workspace, context("auto", "full", env));
		const at = (...parts: string[]) => path.join(workspace, ...parts);
		expect(policy?.allowWrite).not.toContain(workspace);
		expect(policy?.allowWrite).toEqual(
			expect.arrayContaining([
				at(".octocode", "agent", "tmp"),
				at(".octocode", "agent", "temp"),
				at(".octocode", "agent", "**", "*.md"),
			]),
		);
		expect(policy?.denyWrite).toEqual(
			expect.arrayContaining([
				at(".octocode", "skills"),
				at(".octocode", "agent", "worktrees"),
				at(".octocode", "agent", "MEMORY.md"),
				at(".octocode", "agent", "temp", "sessions"),
			]),
		);
	});

	it("opens to an isolated child its worktree and only the git paths a commit on its branch needs", () => {
		const { main, worktree } = repoWithWorktree();
		const env = mainEnv({ OCTOCODE_SUBAGENT: "1", OCTOCODE_TEAM_WORKSPACE: main });
		const policy = sandboxPolicy(worktree, context("auto", "full", env));
		const common = path.join(main, ".git");
		expect(policy?.allowWrite).toEqual(
			expect.arrayContaining([
				worktree,
				path.join(common, "objects"),
				path.join(common, "worktrees", "child"),
				path.join(common, "refs", "heads", "agent", "child"),
				path.join(common, "refs", "heads", "agent", "child.lock"),
			]),
		);
		expect(policy?.allowWrite).not.toContain(main);
		expect(policy?.allowWrite).not.toContain(common);
	});

	it("opens the shared git folder to a session in a linked worktree, its hooks and config protected", () => {
		const { main, worktree } = repoWithWorktree();
		const policy = sandboxPolicy(worktree, context("auto", "workspace"));
		const common = path.join(main, ".git");
		expect(policy?.allowWrite).toContain(common);
		expect(policy?.denyWrite).toEqual(
			expect.arrayContaining([path.join(common, "hooks"), path.join(common, "config")]),
		);
	});

	it("refuses the home folder, where the whole home would become writable", () => {
		expect(() => sandboxPolicy(os.homedir(), context("auto", "workspace"))).toThrow(/needs a project folder/);
	});
});

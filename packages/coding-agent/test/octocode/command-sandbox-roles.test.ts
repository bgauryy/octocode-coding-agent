import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PermissionMode } from "../../src/octocode/permission/mode.ts";
import { applyCommandSandboxSetting } from "../../src/octocode/permission/sandbox/apply.ts";
import { setCommandSandbox } from "../../src/utils/command-sandbox.ts";
import { getShellEnv, resolveBashShell, spawnShell } from "../../src/utils/shell.ts";
import { mainEnv, repoWithWorktree } from "./sandbox-helpers.ts";
import { tmp } from "./helpers.ts";

const macOnly = process.platform === "darwin" ? describe : describe.skip;

const cleanup: string[] = [];
const savedHome = process.env.HOME;
afterEach(() => {
	setCommandSandbox(undefined);
	process.env.HOME = savedHome;
	for (const dir of cleanup.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * A folder outside every writable root (the system temporary folders are writable to every sandboxed command): where a
 * test's workspace goes when a write to it must be refused.
 */
function outsideDir(): string {
	const dir = fs.mkdtempSync(path.join("/private/var/tmp", "octocode-sandbox-test-"));
	cleanup.push(dir);
	return dir;
}

function sandboxOn(mode: PermissionMode, env: NodeJS.ProcessEnv = mainEnv(), setting = "auto"): void {
	const agentDir = tmp();
	fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ sandbox: { mode: setting } }));
	applyCommandSandboxSetting(() => mode, agentDir, env);
}

async function run(command: string, cwd: string) {
	const child = await spawnShell(resolveBashShell(), command, { cwd, env: getShellEnv() });
	let output = "";
	child.stdout?.on("data", (chunk: Buffer) => (output += chunk));
	child.stderr?.on("data", (chunk: Buffer) => (output += chunk));
	const code = await new Promise<number | null>((resolve) => child.once("close", resolve));
	return { code, output };
}

const writeFile = (target: string) =>
	`node -e "const f=require('fs'),p=require('path');f.mkdirSync(p.dirname(process.argv[1]),{recursive:true});f.writeFileSync(process.argv[1],'1')" '${target}'`;

async function expectDenied(target: string, cwd: string): Promise<void> {
	const result = await run(writeFile(target), cwd);
	expect(result.code, `${target}: ${result.output}`).not.toBe(0);
	expect(result.output).toMatch(/EPERM|Operation not permitted/);
	expect(fs.existsSync(target)).toBe(false);
}

const git = "git -c user.name=t -c user.email=t@t";

macOnly("the sandbox by permission mode and role (sandbox.mode: auto)", () => {
	it("refuses a read-only child's write to a repository file, and allows its throwaway folder", async () => {
		const workspace = fs.realpathSync(outsideDir());
		sandboxOn("full", mainEnv({ OCTOCODE_SUBAGENT: "1", OCTOCODE_READ_ONLY: "1" }));
		await expectDenied(path.join(workspace, "src.ts"), workspace);
		// A workspace has `.octocode/`; the child may create `tmp/` in it, not the folder itself.
		fs.mkdirSync(path.join(workspace, ".octocode"));
		const scratch = path.join(workspace, ".octocode", "tmp", "notes.txt");
		const written = await run(writeFile(scratch), workspace);
		expect(written.code, written.output).toBe(0);
		expect(fs.existsSync(scratch)).toBe(true);
	});

	it("lets an isolated child commit in its worktree but not write the main tree or check out there", async () => {
		const { main, worktree } = repoWithWorktree(outsideDir);
		sandboxOn("full", mainEnv({ OCTOCODE_SUBAGENT: "1", OCTOCODE_TEAM_WORKSPACE: main }));
		const commit = await run(`echo b > b.txt && ${git} add b.txt && ${git} commit -qm two`, worktree);
		expect(commit.code, commit.output).toBe(0);
		expect(execFileSync("git", ["log", "-1", "--format=%s", "agent/child"], { cwd: main, encoding: "utf8" })).toBe(
			"two\n",
		);
		await expectDenied(path.join(main, "x.txt"), worktree);
		const checkout = await run(`${git} -C '${main}' checkout -q -b escaped`, worktree);
		expect(checkout.code).not.toBe(0);
		expect(execFileSync("git", ["branch", "--show-current"], { cwd: main, encoding: "utf8" })).toBe("main\n");
	});

	it("refuses writes to git hooks (even before the folder exists), skills and ~/.zshrc in workspace and full modes", async () => {
		const home = outsideDir();
		process.env.HOME = home;
		for (const mode of ["workspace", "full"] as const) {
			const workspace = fs.realpathSync(outsideDir());
			execFileSync("git", ["init", "-q"], { cwd: workspace });
			fs.rmSync(path.join(workspace, ".git", "hooks"), { recursive: true, force: true });
			sandboxOn(mode);
			await expectDenied(path.join(workspace, ".git", "hooks", "pre-commit"), workspace);
			await expectDenied(path.join(workspace, ".octocode", "skills", "x", "SKILL.md"), workspace);
			await expectDenied(path.join(home, ".zshrc"), workspace);
			expect((await run(writeFile(path.join(workspace, "src.ts")), workspace)).code).toBe(0);
		}
	});

	it("runs commands unsandboxed in bypass mode, unless sandbox.mode is on", async () => {
		const outside = outsideDir();
		sandboxOn("bypass");
		expect((await run(writeFile(path.join(outside, "x")), tmp())).code).toBe(0);
		sandboxOn("bypass", mainEnv(), "on");
		await expectDenied(path.join(outside, "y"), tmp());
	});
});

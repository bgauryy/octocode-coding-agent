import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { SUBAGENT_ENV, TEAM_WORKSPACE_ENV } from "@octocodeai/octocode-common/env";
import { initializeBashSyntax } from "../../src/octocode/permission/bash-syntax.ts";
import { isolatedTreeRefusal } from "../../src/octocode/permission/isolated-tree.ts";
import { createWorktree, finishWorktree } from "../../src/octocode/subagents/worktree.ts";
import { tmp } from "./helpers.ts";

beforeAll(initializeBashSyntax);

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

/**
 * A workspace repository as Yarn's node-modules linker leaves it: a third-party package, a workspace link into
 * `packages/`, a launcher, a tool cache and the install state in the root `node_modules`, and a package's own one.
 */
function installedRepo(ignore: string): string {
	const dir = fs.realpathSync(tmp("octocode-deps-repo-"));
	const put = (file: string, text: string) => {
		fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
		fs.writeFileSync(path.join(dir, file), text);
	};
	git(dir, "init", "-q", "-b", "main");
	git(dir, "config", "user.name", "Test");
	git(dir, "config", "user.email", "test@example.com");
	put(".gitignore", ignore);
	put("packages/lib/index.js", "export const lib = 'main';\n");
	git(dir, "add", "-A");
	git(dir, "commit", "-q", "-m", "init");
	put("node_modules/left-pad/index.js", "module.exports = 1;\n");
	put("node_modules/.yarn-state.yml", "__metadata:\n  version: 1\n");
	put("node_modules/.vite/deps.json", "{}\n");
	fs.mkdirSync(path.join(dir, "node_modules/@scope"));
	fs.symlinkSync("../../packages/lib", path.join(dir, "node_modules/@scope/lib"));
	fs.mkdirSync(path.join(dir, "node_modules/.bin"));
	fs.symlinkSync("../left-pad/index.js", path.join(dir, "node_modules/.bin/left-pad"));
	put("packages/lib/node_modules/only-lib/index.js", "module.exports = 2;\n");
	return dir;
}

describe("isolated worktree dependencies", () => {
	it.each(["node_modules\n", "node_modules/\n"])(
		"links each ignored node_modules folder package by package, workspace links into the worktree (ignore %j)",
		async (ignore) => {
			const dir = installedRepo(ignore);
			const worktree = await createWorktree(dir, "deps-1", tmp());
			const modules = path.join(worktree.path, "node_modules");
			expect(fs.lstatSync(modules).isDirectory()).toBe(true);
			expect(fs.realpathSync(path.join(modules, "left-pad"))).toBe(path.join(dir, "node_modules/left-pad"));
			// The child imports its own copy of a workspace package, so its edits are what its checks run.
			expect(fs.realpathSync(path.join(modules, "@scope/lib"))).toBe(
				fs.realpathSync(path.join(worktree.path, "packages/lib")),
			);
			expect(fs.readFileSync(path.join(modules, ".bin/left-pad"), "utf8")).toBe("module.exports = 1;\n");
			// Install state is a copy and a tool cache is left out, so neither writes the source's files.
			expect(fs.lstatSync(path.join(modules, ".yarn-state.yml")).isFile()).toBe(true);
			expect(fs.existsSync(path.join(modules, ".vite"))).toBe(false);
			expect(fs.existsSync(path.join(worktree.path, "packages/lib/node_modules/only-lib/index.js"))).toBe(true);
			expect(worktree.warning).toBeUndefined();
			expect(git(worktree.path, "status", "--porcelain")).toBe("");
			expect(await finishWorktree(worktree)).toEqual({});
			expect(fs.existsSync(path.join(dir, "node_modules/left-pad/index.js"))).toBe(true);
		},
	);

	it("leaves out a folder the worktree's own ignore rules would commit, and says so", async () => {
		const dir = installedRepo("");
		// Ignored only by the source's uncommitted rules; the worktree starts at HEAD without them.
		fs.writeFileSync(path.join(dir, ".gitignore"), "node_modules\n");
		const worktree = await createWorktree(dir, "deps-2", tmp());
		expect(fs.existsSync(path.join(worktree.path, "node_modules"))).toBe(false);
		expect(worktree.warning).toMatch(/node_modules \(not ignored by Git in the worktree/);
		expect(git(worktree.path, "status", "--porcelain")).toBe("");
	});

	it("keeps the isolation guard: a write through a linked package names the main tree and is refused", async () => {
		const dir = installedRepo("node_modules\n");
		const worktree = await createWorktree(dir, "deps-3", tmp());
		const env = { [SUBAGENT_ENV]: "1", [TEAM_WORKSPACE_ENV]: dir };
		const write = (file: string) => ({
			toolName: "file",
			input: { queries: [{ type: "write", path: file, content: "x", reason: "test" }] },
		});
		const linked = path.join(worktree.path, "node_modules/left-pad/index.js");
		expect(isolatedTreeRefusal(write(linked), worktree.cwd, env)).toMatch(/isolated.*main tree/);
		expect(
			isolatedTreeRefusal({ toolName: "bash", input: { command: `echo x > ${linked}` } }, worktree.cwd, env),
		).toMatch(/isolated.*main tree/);
		// Its own workspace package and the worktree's own node_modules folder stay writable.
		const own = path.join(worktree.path, "node_modules/@scope/lib/index.js");
		expect(isolatedTreeRefusal(write(own), worktree.cwd, env)).toBeUndefined();
		const cache = path.join(worktree.path, "node_modules/.vite/deps.json");
		expect(isolatedTreeRefusal(write(cache), worktree.cwd, env)).toBeUndefined();
	});
});

describe("saving an isolated worktree with symbolic links", () => {
	it.each([
		["an absolute target", (dir: string) => path.join(dir, "packages")],
		["a target past the worktree root", () => "../../outside"],
	])("refuses a link with %s and keeps the worktree", async (_label, target) => {
		const dir = installedRepo("node_modules\n");
		const worktree = await createWorktree(dir, "links-1", tmp());
		fs.mkdirSync(path.join(worktree.path, "src"));
		fs.symlinkSync(target(dir), path.join(worktree.path, "src/data"));
		await expect(finishWorktree(worktree)).rejects.toThrow(
			/symbolic links that point outside the worktree.*src\/data -> /,
		);
		expect(fs.existsSync(worktree.path)).toBe(true);
		expect(git(dir, "for-each-ref", "refs/octocode/")).toBe("");
	});

	it("saves a link that stays inside the worktree", async () => {
		const dir = installedRepo("node_modules\n");
		const worktree = await createWorktree(dir, "links-2", tmp());
		fs.symlinkSync("packages/lib/index.js", path.join(worktree.path, "entry.js"));
		const result = await finishWorktree(worktree);
		expect(result.ref).toBe("refs/octocode/links-2");
		expect(git(dir, "cat-file", "-p", "refs/octocode/links-2:entry.js")).toBe("packages/lib/index.js");
	});
});

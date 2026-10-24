import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { readRepositoryDiff, readUntrackedDiff } from "../../src/octocode/files/repository-diff.ts";
import { tmp } from "./helpers.ts";

function repository() {
	const cwd = tmp("command-diff-");
	const git = (...args: string[]) =>
		execFileSync("git", args, {
			cwd,
			encoding: "utf8",
			env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
		});
	git("init", "-q");
	git("config", "user.email", "test@example.invalid");
	git("config", "user.name", "Test");
	return { cwd, git, write: (name: string, data: string | Buffer) => writeFileSync(path.join(cwd, name), data) };
}

it("shows unborn staged and unstaged changes separately, and reads untracked contents only by selection", async () => {
	const { cwd, git, write } = repository();
	write("file", "staged\n");
	git("add", "file");
	write("file", "working\n");
	write("-odd [path]\nname", "untracked secret");
	write("binary", Buffer.from([0, 1, 2]));
	const index = readFileSync(path.join(cwd, ".git/index"));
	const result = await readRepositoryDiff(cwd);
	expect(result.staged).toContain("+staged");
	expect(result.unstaged).toContain("+working");
	expect(result.untracked).toEqual(expect.arrayContaining(["-odd [path]\nname", "binary"]));
	expect(JSON.stringify(result)).not.toContain("untracked secret");
	expect((await readRepositoryDiff(cwd, "-odd [path]\nname")).selectedUntracked).toBe("-odd [path]\nname");
	expect(await readUntrackedDiff(result.root, "binary")).toContain("Binary");
	expect(await readUntrackedDiff(result.root, "-odd [path]\nname")).toBe("untracked secret");
	expect(readFileSync(path.join(cwd, ".git/index"))).toEqual(index);
});

it("does not run external diff, textconv or conversion filters and shows renames, deletes and binary files", async () => {
	const { cwd, git, write } = repository();
	write("original", "a\n");
	write("delete", "remove\n");
	write("binary", Buffer.from([0, 1]));
	write("filtered", "base\n");
	write(".gitattributes", "* diff=trap\nfiltered filter=trap\n");
	git("add", ".");
	git("commit", "-qm", "base");
	const marker = path.join(cwd, "executed");
	git("mv", "original", "renamed");
	git("rm", "delete");
	git("config", "diff.external", `touch '${marker}'`);
	git("config", "diff.trap.textconv", `touch '${marker}'`);
	git("config", "filter.trap.clean", `touch '${marker}'; cat`);
	git("config", "filter.trap.process", `touch '${marker}'`);
	git("config", "filter.trap.required", "true");
	write("binary", Buffer.from([0, 2]));
	write("filtered", "changed\n");
	const result = await readRepositoryDiff(cwd);
	expect(result.staged).toContain("rename from original");
	expect(result.staged).toContain("deleted file");
	expect(result.unstaged).toContain("Binary files");
	expect(result.unstaged).toContain("+changed");
	expect(existsSync(marker)).toBe(false);
});

it("rejects paths and symlinks outside the root, treats pathspec syntax literally and bounds output", async () => {
	const { cwd, write } = repository();
	const outside = tmp("command-outside-");
	writeFileSync(path.join(outside, "secret"), "secret");
	symlinkSync(path.join(outside, "secret"), path.join(cwd, "link"));
	await expect(readRepositoryDiff(cwd, "../secret")).rejects.toThrow("inside");
	await expect(readUntrackedDiff(cwd, "link")).rejects.toThrow("outside");
	write(":(glob)*", "literal");
	write("large", "x".repeat(140_000));
	expect((await readRepositoryDiff(cwd, ":(glob)*")).untracked).toEqual([":(glob)*"]);
	expect((await readUntrackedDiff(cwd, "large")).length).toBeLessThan(129_000);
	expect(await readUntrackedDiff(cwd, "large")).toContain("truncated");
	const controller = new AbortController();
	controller.abort();
	await expect(readRepositoryDiff(cwd, undefined, controller.signal)).rejects.toThrow();
	await expect(readRepositoryDiff(outside)).rejects.toThrow("unavailable");
});

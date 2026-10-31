import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { git, GitError, gitQuiet, gitSync } from "../../src/octocode/shared/git.ts";
import { tmp } from "./helpers.ts";

function repo(): string {
	const dir = tmp();
	execFileSync("git", ["init", "-q"], { cwd: dir });
	fs.writeFileSync(path.join(dir, "a.txt"), "x".repeat(5000));
	return dir;
}

describe("shared git helper", () => {
	it("returns trimmed stdout, or raw stdout on request", async () => {
		const dir = repo();
		expect(await git(dir, ["rev-parse", "--is-inside-work-tree"])).toBe("true");
		expect(await git(dir, ["rev-parse", "--is-inside-work-tree"], { raw: true })).toBe("true\n");
		expect(gitSync(dir, ["rev-parse", "--is-inside-work-tree"], { timeoutMs: 5000 })).toBe("true\n");
	});

	it("rejects with a GitError that carries git's stderr and the exit code", async () => {
		const dir = repo();
		const error = await git(dir, ["rev-parse", "--verify", "-q", "HEAD"]).catch((reason: unknown) => reason);
		expect(error).toBeInstanceOf(GitError);
		const failure = error as GitError;
		expect(failure.exitCode).toBe(1);
		expect(failure.timedOut).toBe(false);
		expect(failure.overflow).toBe(false);
		expect(await gitQuiet(dir, ["rev-parse", "--verify", "-q", "HEAD"])).toBeUndefined();
		expect(() => gitSync(dir, ["rev-parse", "--verify", "-q", "HEAD"], { timeoutMs: 5000 })).toThrow();
	});

	it("reports a non-repository through the stderr message", async () => {
		const error = await git(tmp(), ["status"]).catch((reason: unknown) => reason);
		expect((error as GitError).message).toMatch(/not a git repository/i);
	});

	it("reports output past maxBuffer as overflow, with the part that fit", async () => {
		const dir = repo();
		const error = (await git(dir, ["ls-files", "--others", "-z"], { maxBuffer: 3 }).catch(
			(reason: unknown) => reason,
		)) as GitError;
		expect(error).toBeInstanceOf(GitError);
		expect(error.overflow).toBe(true);
		expect(error.stdout.length).toBeLessThanOrEqual(3);
	});

	it("passes extra environment and stops on an aborted signal", async () => {
		const dir = repo();
		expect(
			await git(dir, ["var", "GIT_AUTHOR_IDENT"], { env: { GIT_AUTHOR_NAME: "Probe", GIT_AUTHOR_EMAIL: "p@x" } }),
		).toContain("Probe");
		const controller = new AbortController();
		controller.abort();
		await expect(git(dir, ["status"], { signal: controller.signal })).rejects.toBeInstanceOf(GitError);
	});
});

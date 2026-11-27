import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** Git identity and no user configuration, so a test repository behaves the same on every machine. */
export const GIT_TEST_ENV = {
	GIT_AUTHOR_NAME: "t",
	GIT_AUTHOR_EMAIL: "t@example.com",
	GIT_COMMITTER_NAME: "t",
	GIT_COMMITTER_EMAIL: "t@example.com",
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_CONFIG_SYSTEM: "/dev/null",
};

export const sh = (cwd: string, ...args: string[]): string =>
	execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...GIT_TEST_ENV } }).trim();

export interface TestRepo {
	root: string;
	write(relative: string, text: string): void;
	cleanup(): void;
}

/** A temporary repository with one commit that tracks `a.txt` and ignores `.env` and `.octocode/agent/worktrees/`. */
export function makeRepo(options: { commit?: boolean } = {}): TestRepo {
	const base = realpathSync(mkdtempSync(path.join(tmpdir(), "octocode-worktrees-")));
	const root = path.join(base, "repo");
	mkdirSync(root);
	sh(root, "init", "-q", "-b", "main");
	const write = (relative: string, text: string) => {
		mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
		writeFileSync(path.join(root, relative), text);
	};
	write(".gitignore", ".env\n.env.local\n.octocode/agent/worktrees/\n");
	write("a.txt", "a\n");
	if (options.commit !== false) {
		sh(root, "add", ".");
		sh(root, "commit", "-q", "-m", "first");
	}
	return { root, write, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

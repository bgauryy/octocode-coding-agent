import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withFileWriteLock } from "../../../common/src/file-write-lock.ts";
import * as gitCommands from "../../src/utils/git-run.ts";
import { mergeAgent, pendingRefs } from "../../src/octocode/subagents/worktree.ts";
import { mergeRef } from "../../src/octocode/worktrees/merge.ts";
import { tmp } from "./helpers.ts";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
function repo(): string {
	const cwd = tmp("octocode-merge-concurrency-");
	git(cwd, "init", "-q", "-b", "main");
	git(cwd, "config", "user.name", "Test");
	git(cwd, "config", "user.email", "test@example.com");
	fs.writeFileSync(path.join(cwd, "base.txt"), "base\n");
	git(cwd, "add", "base.txt");
	git(cwd, "commit", "-qm", "base");
	const base = git(cwd, "rev-parse", "HEAD");
	for (const name of ["alpha", "beta"]) {
		git(cwd, "checkout", "-qb", name, base);
		fs.writeFileSync(path.join(cwd, `${name}.txt`), `${name}\n`);
		git(cwd, "add", `${name}.txt`);
		git(cwd, "commit", "-qm", name);
		git(cwd, "update-ref", `refs/octocode/${name}`, "HEAD");
	}
	git(cwd, "checkout", "-q", "main");
	return cwd;
}

afterEach(() => vi.restoreAllMocks());

describe("checkout merge serialization", () => {
	it("serializes separate processes and captures each merge's own resulting head", async () => {
		const cwd = repo();
		const moduleUrl = new URL("../../src/octocode/worktrees/merge.ts", import.meta.url).href;
		const resolver = fileURLToPath(new URL("../../scripts/source-resolver.ts", import.meta.url));
		const children = ["alpha", "beta"].map((name) => {
			const script = `import { mergeRef } from ${JSON.stringify(moduleUrl)};
process.stdout.write("ready\\n");
await new Promise(resolve => process.stdin.once("data", resolve));
process.stdin.pause();
process.stdout.write(JSON.stringify(await mergeRef(${JSON.stringify(cwd)}, ${JSON.stringify(`refs/octocode/${name}`)})) + "\\n");`;
			const child = spawn(process.execPath, ["--import", resolver, "--input-type=module", "-e", script], {
				stdio: ["pipe", "pipe", "pipe"],
			});
			let output = "";
			let errors = "";
			const ready = Promise.withResolvers<void>();
			child.stdout.on("data", (chunk: Buffer) => {
				output += chunk.toString();
				if (output.startsWith("ready\n")) ready.resolve();
			});
			child.stderr.on("data", (chunk: Buffer) => {
				errors += chunk.toString();
			});
			const exited = new Promise<number | null>((resolve) => child.once("close", resolve));
			return {
				child,
				ready: Promise.race([
					ready.promise,
					exited.then(() => {
						throw new Error(errors || output);
					}),
				]),
				exited,
				output: () => output,
			};
		});
		try {
			await Promise.all(children.map((child) => child.ready));
			for (const { child } of children) child.stdin.end("merge\n");
			expect(await Promise.all(children.map((child) => child.exited))).toEqual([0, 0]);
			const results = children.map((child) => JSON.parse(child.output().trim().split("\n").at(-1)!));
			expect(results).toEqual([expect.objectContaining({ ok: true }), expect.objectContaining({ ok: true })]);
			expect(new Set(results.map((result) => result.head)).size).toBe(2);
			for (const name of ["alpha", "beta"])
				expect(fs.readFileSync(path.join(cwd, `${name}.txt`), "utf8")).toBe(`${name}\n`);
			expect(git(cwd, "status", "--porcelain")).toBe("");
			expect(fs.existsSync(path.join(cwd, ".git", "MERGE_HEAD"))).toBe(false);
		} finally {
			for (const { child } of children) if (child.exitCode === null) child.kill("SIGTERM");
			await Promise.all(children.map((child) => child.exited));
		}
	});

	it("queues concurrent child merges through a symlink and cleans both refs", async () => {
		const cwd = repo();
		const alias = path.join(tmp(), "checkout");
		fs.symlinkSync(cwd, alias, "dir");
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const original = gitCommands.git;
		const started: string[] = [];
		vi.spyOn(gitCommands, "git").mockImplementation(async (where, args, options) => {
			if (args.includes("merge")) {
				started.push(args.at(-1)!);
				if (started.length === 1) {
					entered.resolve();
					await release.promise;
				}
			}
			return original(where, args, options);
		});
		const first = mergeAgent(cwd, "alpha");
		await entered.promise;
		const second = mergeAgent(alias, "beta");
		try {
			await sleep(100);
			expect(started).toEqual(["refs/octocode/alpha"]);
		} finally {
			release.resolve();
			const results = await Promise.all([first, second]);
			expect(results).toEqual([expect.objectContaining({ ok: true }), expect.objectContaining({ ok: true })]);
		}
		expect(fs.readFileSync(path.join(cwd, "alpha.txt"), "utf8")).toBe("alpha\n");
		expect(fs.readFileSync(path.join(cwd, "beta.txt"), "utf8")).toBe("beta\n");
		expect(await pendingRefs(cwd)).toEqual([]);
		expect(git(cwd, "status", "--porcelain")).toBe("");
		expect(fs.existsSync(path.join(cwd, ".git", "MERGE_HEAD"))).toBe(false);
		expect(fs.readdirSync(path.join(cwd, ".git")).filter((name) => name.startsWith(".octocode-"))).toEqual([]);
	});

	it("cancels a queued merge without changing the checkout or saved result", async () => {
		const cwd = repo();
		const acquired = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const holder = withFileWriteLock(path.join(cwd, ".git", "HEAD"), async () => {
			acquired.resolve();
			await release.promise;
		});
		await acquired.promise;
		const controller = new AbortController();
		const queued = mergeAgent(cwd, "alpha", controller.signal);
		const settled = queued.then(
			(value) => ({ status: "fulfilled" as const, value }),
			(error: unknown) => ({ status: "rejected" as const, error }),
		);
		try {
			await sleep(100);
			controller.abort();
			const outcome = await settled;
			expect(outcome.status).toBe("rejected");
			if (outcome.status === "rejected") expect(String(outcome.error)).toMatch(/abort/i);
			expect(git(cwd, "rev-parse", "HEAD")).toBe(git(cwd, "rev-parse", "main"));
			expect(fs.existsSync(path.join(cwd, "alpha.txt"))).toBe(false);
			expect(await pendingRefs(cwd)).toEqual(["alpha", "beta"]);
		} finally {
			controller.abort();
			release.resolve();
			await holder;
		}
		expect(await mergeAgent(cwd, "alpha")).toMatchObject({ ok: true });
	});

	it("does not block another checkout while this checkout waits", async () => {
		const cwd = repo();
		const other = path.join(tmp(), "linked");
		git(cwd, "worktree", "add", "-q", "-b", "other", other, "main");
		const acquired = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const holder = withFileWriteLock(path.join(cwd, ".git", "HEAD"), async () => {
			acquired.resolve();
			await release.promise;
		});
		await acquired.promise;
		try {
			expect(await mergeRef(other, "refs/octocode/alpha")).toMatchObject({ ok: true });
			expect(fs.existsSync(path.join(cwd, "alpha.txt"))).toBe(false);
			expect(fs.readFileSync(path.join(other, "alpha.txt"), "utf8")).toBe("alpha\n");
		} finally {
			release.resolve();
			await holder;
		}
	});
});

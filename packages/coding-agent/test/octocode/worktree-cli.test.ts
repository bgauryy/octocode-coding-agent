import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseArgs } from "../../src/cli/args.ts";
import { completeCli, shellCompletion } from "../../src/cli/completion.ts";
import { FLAG_SPECS, flagHelpRows } from "../../src/cli/args/flags.ts";
import { startupCwd } from "../../src/cli/worktree-startup.ts";
import { enterWorktree } from "../../src/octocode/worktrees/enter.ts";
import { GIT_TEST_ENV, makeRepo, type TestRepo } from "./worktree-fixture.ts";

const saved = { ...process.env };
const startCwd = process.cwd();
let repo: TestRepo;

beforeEach(() => {
	Object.assign(process.env, GIT_TEST_ENV);
	repo = makeRepo();
});
afterEach(() => {
	process.chdir(startCwd);
	process.env = { ...saved };
	vi.restoreAllMocks();
	repo.cleanup();
});

describe("--worktree flag", () => {
	it("parses `--worktree name` and `--worktree=name`", () => {
		expect(parseArgs(["--worktree", "auth", "hi"])).toMatchObject({ worktree: "auth", messages: ["hi"] });
		expect(parseArgs(["--worktree=auth"]).worktree).toBe("auth");
	});

	it("reports an invalid or missing name as an error and stores nothing", () => {
		const bad = parseArgs(["--worktree", "a/b"]);
		expect(bad.worktree).toBeUndefined();
		expect(bad.diagnostics).toEqual([
			{ type: "error", message: expect.stringContaining("--worktree: Invalid worktree name") },
		]);
		expect(parseArgs(["--worktree"]).diagnostics[0]?.type).toBe("error");
	});

	it("is in --help and shell completion, which read the same table", () => {
		expect(FLAG_SPECS.map((spec) => spec.name)).toContain("--worktree");
		expect(flagHelpRows().join("\n")).toContain("--worktree <name>");
		expect(shellCompletion("bash")).toContain("completion --values");
		expect(completeCli(["--wor"], repo.root).join("\n")).toContain("--worktree");
	});
});

describe("entering a worktree", () => {
	it("creates it and makes it the process directory", async () => {
		process.chdir(repo.root);
		const info = await enterWorktree("auth");
		expect(realpathSync(process.cwd())).toBe(info.path);
		expect(info.path).toBe(path.join(repo.root, ".octocode", "worktrees", "auth"));
	});

	it("startupCwd enters the worktree named by the arguments, reusing it on the next start", async () => {
		process.chdir(repo.root);
		const write = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		const cwd = await startupCwd(["--model", "x", "--worktree", "auth"]);
		expect(realpathSync(cwd)).toBe(path.join(repo.root, ".octocode", "worktrees", "auth"));
		expect(String(write.mock.calls[0]?.[0])).toContain(
			"Created worktree auth (branch worktree-auth) at .octocode/worktrees/auth",
		);

		// From inside the worktree, the same name resolves to the same folder under the main root.
		const again = await startupCwd(["--worktree", "auth"]);
		expect(realpathSync(again)).toBe(realpathSync(cwd));
		expect(String(write.mock.calls[1]?.[0])).toContain("Using existing worktree auth");
	});

	it("leaves the directory alone without the flag, and for --help or --version", async () => {
		process.chdir(repo.root);
		expect(realpathSync(await startupCwd(["hello"]))).toBe(repo.root);
		expect(realpathSync(await startupCwd(["--worktree", "auth", "--help"]))).toBe(repo.root);
		expect(realpathSync(await startupCwd(["--version", "--worktree", "auth"]))).toBe(repo.root);
		expect(parseArgs(["--worktree", "auth", "--help"]).help).toBe(true);
	});

	it("exits with status 1 before any session starts outside a repository", async () => {
		const { mkdtempSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		process.chdir(mkdtempSync(path.join(tmpdir(), "octocode-nr-")));
		const before = process.cwd();
		const write = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
			throw new Error(`exit ${code}`);
		}) as never);
		await expect(startupCwd(["--worktree", "auth"])).rejects.toThrow("exit 1");
		expect(String(write.mock.calls[0]?.[0])).toContain("not inside a git repository");
		expect(process.cwd()).toBe(before);
	});

	it("refuses --worktree with a flag that opens a saved session, before creating anything", async () => {
		process.chdir(repo.root);
		const write = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
			throw new Error(`exit ${code}`);
		}) as never);
		await expect(startupCwd(["--worktree", "auth", "--continue"])).rejects.toThrow("exit 1");
		await expect(startupCwd(["--session", "abc", "--worktree", "auth"])).rejects.toThrow("exit 1");
		expect(String(write.mock.calls[0]?.[0])).toContain("cannot be combined with --continue");
		expect(String(write.mock.calls[1]?.[0])).toContain("cannot be combined with --session");
		expect(existsSync(path.join(repo.root, ".octocode"))).toBe(false);
	});

	it("creates nothing for an invalid name: the parser's error ends startup", async () => {
		process.chdir(repo.root);
		expect(realpathSync(await startupCwd(["--worktree", "bad name"]))).toBe(repo.root);
		expect(existsSync(path.join(repo.root, ".octocode"))).toBe(false);
		expect(parseArgs(["--worktree", "bad name"]).diagnostics[0]?.type).toBe("error");
	});

	it.each([
		[["install", "npm:x", "--worktree", "auth"], 'the "install" command'],
		[["update", "--worktree", "auth"], 'the "update" command'],
		[["list", "--worktree", "auth"], 'the "list" command'],
		[["config", "--worktree", "auth"], 'the "config" command'],
		[["mcp", "list", "--worktree", "auth"], 'the "mcp" command'],
		[["context", "list", "--worktree", "auth"], 'the "context" command'],
		[["--mode", "acp", "--worktree", "auth"], "--mode acp"],
		[["--worktree", "auth", "--export", "s.jsonl"], "--export"],
		[["--worktree", "auth", "--list-models"], "--list-models"],
	])("refuses --worktree outside a session run (%j), before creating anything", async (args, what) => {
		process.chdir(repo.root);
		const write = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
			throw new Error(`exit ${code}`);
		}) as never);
		await expect(startupCwd(args)).rejects.toThrow("exit 1");
		expect(String(write.mock.calls[0]?.[0])).toContain(`cannot be used with ${what}`);
		expect(existsSync(path.join(repo.root, ".octocode"))).toBe(false);
		expect(realpathSync(process.cwd())).toBe(repo.root);
	});

	it("still shows help for a subcommand given --worktree, without creating anything", async () => {
		process.chdir(repo.root);
		expect(realpathSync(await startupCwd(["install", "--help", "--worktree", "auth"]))).toBe(repo.root);
		expect(existsSync(path.join(repo.root, ".octocode"))).toBe(false);
	});

	it("keeps the worktrees module free of the CLI layer and of process exit", () => {
		const dir = path.join(import.meta.dirname, "../../src/octocode/worktrees");
		for (const file of readdirSync(dir).filter((name) => name.endsWith(".ts"))) {
			const source = readFileSync(path.join(dir, file), "utf8");
			expect(source, file).not.toMatch(/from "[^"]*\/cli\//);
			expect(source, file).not.toContain("process.exit(");
		}
	});
});

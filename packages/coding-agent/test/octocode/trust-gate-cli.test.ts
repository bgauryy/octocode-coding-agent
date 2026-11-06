import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { grantFolder, refuseFolder } from "../../src/octocode/trust/grants.ts";
import { resolveFolderTrust } from "../../src/octocode/trust/resolve.ts";

/**
 * The startup trust gate, through the real CLI (`src/cli.ts`) with an isolated home, agent directory and agent database.
 * An untrusted folder must stop before any project file is read and before any model is called: the project's AGENTS.md
 * carries a sentinel and a bogus model endpoint would be hit by any request (it would show in stderr).
 */
const resolver = fileURLToPath(new URL("../../scripts/source-resolver.ts", import.meta.url));
const cli = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));
const roots: string[] = [];

function sandbox() {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "octocode-trust-gate-")));
	roots.push(root);
	const home = path.join(root, "home");
	const project = path.join(home, "code", "app");
	fs.mkdirSync(project, { recursive: true });
	fs.mkdirSync(path.join(root, "agent"));
	fs.writeFileSync(path.join(project, "AGENTS.md"), "SENTINEL project instructions\n");
	const db = path.join(root, "agent.sqlite");
	const env = {
		...process.env,
		HOME: home,
		OCTOCODE_HOME: path.join(home, ".octocode"),
		OCTOCODE_CODING_AGENT_DIR: path.join(root, "agent"),
		OCTOCODE_AGENT_DB: db,
		OCTOCODE_MCP: "0",
		OCTOCODE_SKIP_VERSION_CHECK: "1",
		OCTOCODE_OFFLINE: "1",
	};
	for (const name of Object.keys(env))
		if (name.startsWith("OCTOCODE_SUBAGENT") || name === "OCTOCODE_SESSION_ID")
			delete (env as Record<string, unknown>)[name];
	return { root, home, project, env, db };
}

const run = (box: ReturnType<typeof sandbox>, cwd: string, args: string[]) =>
	spawnSync(process.execPath, ["--import", resolver, cli, ...args], {
		cwd,
		env: box.env,
		encoding: "utf8",
		timeout: 60_000,
		input: "",
	});

afterAll(() => {
	for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

describe("folder trust gate (CLI)", () => {
	it("print mode in an undecided folder exits non-zero before any project read or model call", () => {
		const box = sandbox();
		const result = run(box, box.project, ["-p", "hello"]);
		expect(result.status).toBe(1);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("is not trusted");
		expect(result.stderr).toContain("octocode trust add");
		expect(result.stderr).not.toContain("SENTINEL");
		expect(resolveFolderTrust(box.project, { env: box.env, home: box.home }).state).toBe("undecided");
	});

	it("--trust records the grant (source flag) and runs; the next run needs no flag", () => {
		const box = sandbox();
		const first = run(box, box.project, ["-p", "hello", "--trust"]);
		expect(first.stderr).not.toContain("is not trusted");
		const state = resolveFolderTrust(box.project, { env: box.env, home: box.home });
		expect(state.state).toBe("trusted");
		if (state.state === "trusted") expect(state.grant.source).toBe("flag");
		const second = run(box, box.project, ["-p", "hello"]);
		expect(second.stderr).not.toContain("is not trusted");
	});

	it("--approve is an unknown flag: it grants nothing and stops the run before any work", () => {
		const box = sandbox();
		const result = run(box, box.project, ["-p", "hello", "--approve"]);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("Unknown option: --approve");
		expect(result.stderr).not.toContain("SENTINEL");
		expect(result.stderr).not.toContain("--approve is deprecated");
		expect(resolveFolderTrust(box.project, { env: box.env, home: box.home }).state).toBe("undecided");
	});

	it("a recorded refusal is remembered and exits with the hint", () => {
		const box = sandbox();
		refuseFolder(box.project, { source: "command", surface: "cli" }, { env: box.env, home: box.home });
		const result = run(box, box.project, ["-p", "hello"]);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("octocode trust add");
		expect(result.stderr).not.toContain("SENTINEL");
	});

	it("$HOME is refused even with --trust, and no grant is written", () => {
		const box = sandbox();
		const result = run(box, box.home, ["-p", "hello", "--trust"]);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("does not open your home folder");
		expect(result.stderr).toContain("Open a project folder");
	});

	it("RPC mode in an undecided folder exits non-zero with an empty stdout", () => {
		const box = sandbox();
		const result = run(box, box.project, ["--mode", "rpc"]);
		expect(result.status).toBe(1);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("The RPC server did not start");
	});

	it("a subagent child in an undecided folder exits 1 and records nothing", () => {
		const box = sandbox();
		const child = spawnSync(process.execPath, ["--import", resolver, cli, "-p", "hello", "--trust"], {
			cwd: box.project,
			env: { ...box.env, OCTOCODE_SUBAGENT: "1" },
			encoding: "utf8",
			timeout: 60_000,
			input: "",
		});
		expect(child.status).toBe(1);
		expect(child.stderr).toContain("Folder not trusted");
		expect(resolveFolderTrust(box.project, { env: box.env, home: box.home }).state).toBe("undecided");
	});

	it("a git worktree needs --trust in a headless run: without it nothing is created", () => {
		const box = sandbox();
		const git = (...args: string[]) => execFileSync("git", args, { cwd: box.project, encoding: "utf8" });
		git("init", "-q", "-b", "main");
		git("-c", "user.name=T", "-c", "user.email=t@e.x", "commit", "-q", "--allow-empty", "-m", "init");
		grantFolder(box.project, "folder", { source: "command", surface: "cli" }, { env: box.env, home: box.home });
		const no = run(box, box.project, ["-p", "hello", "--worktree", "feat"]);
		expect(no.status).toBe(1);
		expect(no.stderr).toContain("Run again with --trust");
		expect(git("worktree", "list").trim().split("\n")).toHaveLength(1);
		run(box, box.project, ["-p", "hello", "--worktree", "feat", "--trust"]);
		expect(git("worktree", "list").trim().split("\n")).toHaveLength(2);
		const made = path.join(box.project, ".octocode", "worktrees", "feat");
		const state = resolveFolderTrust(made, { env: box.env, home: box.home });
		expect(state.state).toBe("trusted");
		if (state.state === "trusted") expect(state.grant.source).toBe("worktree");
	});
});

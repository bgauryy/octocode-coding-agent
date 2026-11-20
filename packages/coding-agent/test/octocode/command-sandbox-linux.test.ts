import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getShellEnv, resolveBashShell, spawnShell } from "../../src/utils/shell.ts";
import { setCommandSandbox } from "../../src/utils/command-sandbox.ts";
import {
	bubblewrapProblem,
	linuxStart,
	missingPrograms,
	PROBE_ARGS,
	ripgrepCommand,
	unsupportedPlatform,
} from "../../src/octocode/permission/sandbox/linux.ts";
import { ANY_DEPTH_LIMIT, literalPaths, literalPolicy } from "../../src/octocode/permission/sandbox/linux-paths.ts";
import { sandboxPolicy } from "../../src/octocode/permission/sandbox/policy.ts";
import { SrtCommandSandbox } from "../../src/octocode/permission/sandbox/srt.ts";
import { tmp } from "./helpers.ts";
import { mainEnv } from "./sandbox-helpers.ts";

// The Linux backend's logic that needs no Linux kernel: run on every platform. Its bubblewrap runs are in
// command-sandbox-linux-host.test.ts, which only a Linux host with bubblewrap runs.

function tree(files: string[]): string {
	const root = fs.realpathSync(tmp());
	for (const file of files) {
		const full = path.join(root, file);
		if (file.endsWith("/")) fs.mkdirSync(full, { recursive: true });
		else {
			fs.mkdirSync(path.dirname(full), { recursive: true });
			fs.writeFileSync(full, "");
		}
	}
	return root;
}

const relative = (root: string, files: string[]) => files.map((file) => path.relative(root, file)).sort();

/** An executable script named `name` in a new folder, standing in for a program on PATH. */
function program(name: string, body: string): string {
	const dir = tmp();
	const file = path.join(dir, name);
	fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
	return dir;
}

describe("Linux: wildcard rules made literal for bubblewrap", () => {
	it("names every repository's hooks a `**` deny reaches, not entering node_modules or .git, to the depth limit", () => {
		const root = tree([
			".git/hooks/",
			"a/.git/hooks/",
			"a/b/c/.git/hooks/",
			"a/b/c/d/.git/hooks/",
			"node_modules/x/.git/hooks/",
			"plain/",
		]);
		expect(ANY_DEPTH_LIMIT).toBe(3);
		expect(relative(root, literalPaths(path.join(root, "**", ".git", "hooks"), "deny"))).toEqual([
			".git/hooks",
			"a/.git/hooks",
			"a/b/c/.git/hooks",
		]);
	});

	it("keeps a deny after a `*` match before it exists, and skips matches that are files where a folder is needed", () => {
		const root = tree([".octocode/worktrees/one/", ".octocode/worktrees/two/AGENTS.md", ".octocode/worktrees/note"]);
		const pattern = path.join(root, ".octocode", "worktrees", "*", "AGENTS.md");
		expect(relative(root, literalPaths(pattern, "deny"))).toEqual([
			".octocode/worktrees/one/AGENTS.md",
			".octocode/worktrees/two/AGENTS.md",
		]);
	});

	it("matches `*` within one name only and refuses other wildcards rather than guess", () => {
		const root = tree([".octocode/notes.md", ".octocode/notes.txt", ".octocode/x.md.bak"]);
		expect(relative(root, literalPaths(path.join(root, ".octocode", "*.md"), "deny"))).toEqual([".octocode/notes.md"]);
		expect(() => literalPaths(path.join(root, "file?.md"), "deny")).toThrow(/`\*` and `\*\*`/);
		expect(literalPaths("/no/wildcards", "deny")).toEqual(["/no/wildcards"]);
	});

	it("drops wildcard writes inside a denied folder and keeps every deny the policy had", () => {
		const root = tree([
			".octocode/topic/notes.md",
			".octocode/skills/x/SKILL.md",
			".octocode/topic/tmp/",
			".git/hooks/",
		]);
		const octocode = path.join(root, ".octocode");
		const policy = literalPolicy({
			allowWrite: ["/tmp", path.join(octocode, "**", "*.md"), path.join(octocode, "*", "tmp")],
			denyWrite: [path.join(octocode, "skills"), path.join(root, "**", ".git", "hooks"), "/missing/literal"],
			denyRead: [path.join(root, "**", ".env")],
		});
		expect(policy.allowWrite).toEqual([
			"/tmp",
			path.join(octocode, "topic", "notes.md"),
			path.join(octocode, "topic", "tmp"),
		]);
		expect(policy.denyWrite).toEqual([
			path.join(octocode, "skills"),
			path.join(root, ".git", "hooks"),
			"/missing/literal",
		]);
		// Read denials go to the library as given: it expands those itself.
		expect(policy.denyRead).toEqual([path.join(root, "**", ".env")]);
	});

	it("leaves no wildcard in a session's policy and still protects its repository's hooks", () => {
		const root = tree([".git/hooks/", "sub/.git/hooks/", ".octocode/worktrees/child/"]);
		const policy = sandboxPolicy(root, { setting: "on", mode: "workspace", env: mainEnv() });
		if (!policy) throw new Error("sandbox.mode on must make a policy");
		const literal = literalPolicy(policy);
		expect([...literal.allowWrite, ...literal.denyWrite].filter((entry) => entry.includes("*"))).toEqual([]);
		expect(literal.denyWrite).toEqual(
			expect.arrayContaining([
				path.join(root, ".git", "hooks"),
				path.join(root, "sub", ".git", "hooks"),
				path.join(root, ".octocode", "worktrees", "child", ".git", "hooks"),
			]),
		);
		expect(literal.denyWrite.length).toBeGreaterThanOrEqual(policy.denyWrite.filter((e) => !e.includes("*")).length);
	});
});

describe("Linux: what the sandbox needs to start", () => {
	afterEach(() => vi.unstubAllEnvs());

	it("supports macOS and Linux and names any other platform", () => {
		expect(unsupportedPlatform("darwin")).toBeUndefined();
		expect(unsupportedPlatform("linux")).toBeUndefined();
		expect(unsupportedPlatform("win32")).toMatch(/macOS and Linux only \(this is win32\)/);
	});

	it("uses Octocode's own ripgrep, else the one on PATH", () => {
		const bin = program("rg", "exit 0");
		const onPath = program("rg", "exit 0");
		expect(ripgrepCommand(bin, { PATH: onPath })).toBe(path.join(bin, "rg"));
		expect(ripgrepCommand(tmp(), { PATH: onPath })).toBe(path.join(onPath, "rg"));
		expect(ripgrepCommand(tmp(), { PATH: tmp() })).toBe("rg");
	});

	it("says what to install for each missing program", () => {
		const text = missingPrograms(["bubblewrap (bwrap) not installed", "ripgrep (rg) not found"]);
		expect(text).toContain("bubblewrap (bwrap) not installed; ripgrep (rg) not found");
		expect(text).toContain("sudo apt install bubblewrap socat");
		expect(text).toContain("install ripgrep");
	});

	it("runs bubblewrap once with the namespaces commands need", () => {
		const runs: [string, string[]][] = [];
		const problem = bubblewrapProblem("/usr/bin/bwrap", (file, args) => {
			runs.push([file, args]);
			return { status: 0, stderr: "" };
		});
		expect(problem).toBeUndefined();
		expect(runs).toEqual([["/usr/bin/bwrap", PROBE_ARGS]]);
		expect(PROBE_ARGS).toEqual(expect.arrayContaining(["--unshare-net", "--unshare-pid", "--die-with-parent"]));
	});

	it("explains a kernel that refuses user namespaces, and any other failed trial run", () => {
		const userns = bubblewrapProblem("/usr/bin/bwrap", () => ({
			status: 1,
			stderr: "bwrap: setting up uid map: Permission denied\n",
		}));
		expect(userns).toMatch(/uid map: Permission denied.*unprivileged user namespaces are off/);
		const other = bubblewrapProblem("/usr/bin/bwrap", () => ({ status: 3, stderr: "" }));
		expect(other).toBe("bubblewrap cannot create a sandbox here (exit status 3)");
		const crashed = bubblewrapProblem("/usr/bin/bwrap", () => ({
			status: null,
			stderr: "",
			error: new Error("spawnSync ETIMEDOUT"),
		}));
		expect(crashed).toContain("ETIMEDOUT");
		expect(bubblewrapProblem(undefined)).toMatch(/not installed; install the bubblewrap and socat packages/);
	});

	it("refuses to start when the library misses a program or the trial run fails, and starts with the ripgrep it found", () => {
		vi.stubEnv("PATH", program("bwrap", "exit 0"));
		const checked: { command: string }[] = [];
		const started = linuxStart((ripgrep) => (checked.push(ripgrep), { errors: [] }));
		expect(started.ripgrep).toEqual(checked[0]);
		expect(() => linuxStart(() => ({ errors: ["socat not installed"] }))).toThrow(
			/cannot start: socat not installed; install the bubblewrap and socat packages/,
		);
		vi.stubEnv("PATH", program("bwrap", "echo 'bwrap: No permissions to create new namespace' >&2; exit 1"));
		expect(() => linuxStart(() => ({ errors: [] }))).toThrow(/cannot start: bubblewrap cannot create a sandbox here/);
	});
});

describe("Linux: a sandbox that cannot start refuses the command", () => {
	const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
	afterEach(() => {
		Object.defineProperty(process, "platform", platform);
		setCommandSandbox(undefined);
		vi.unstubAllEnvs();
	});

	it("without bubblewrap: names what to install and does not run the command", async () => {
		const cwd = fs.realpathSync(tmp());
		const marker = path.join(cwd, "ran");
		// No bubblewrap or socat on PATH; the shell itself is found by its absolute path.
		vi.stubEnv("PATH", tmp());
		setCommandSandbox(new SrtCommandSandbox(() => ({ allowWrite: [cwd], denyWrite: [], denyRead: [] })));
		Object.defineProperty(process, "platform", { ...platform, value: "linux" });
		await expect(spawnShell(resolveBashShell(), `touch '${marker}'`, { cwd, env: getShellEnv() })).rejects.toThrow(
			/cannot start: .*bubblewrap.*sudo apt install bubblewrap socat.*The command was not run/,
		);
		expect(fs.existsSync(marker)).toBe(false);
	});
});

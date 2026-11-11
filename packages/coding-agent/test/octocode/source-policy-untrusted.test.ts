import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { registerSourcePolicy } from "../../src/octocode/permission/source-policy-loader.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";

/**
 * An untrusted project's Claude settings files never grant: no allow rule, no `acceptEdits`, no extra directory. This
 * holds for `settings.local.json` too, however git sees it (no repository, an empty index, untracked). The user's own
 * `~/.claude/settings.json` keeps granting, restricting rules load from any source, and a trusted project (local file
 * included) loads as before.
 *
 * How an untrusted folder reaches this loader (read from the source, not exercised here):
 * - The loader is registered unconditionally (`octocode/index.ts`). The Claude harness switch (off by default, see
 *   `core/discovery/vendors/claude.ts`) gates skill, hook, memory and MCP discovery only, so it does not keep these
 *   settings out of the policy.
 * - Every mode that opens a session (tui, print, json, rpc, acp, web, subagent) needs a trusted folder: `gateStartup`
 *   (`main/trust-gate.ts`) refuses an untrusted one, and the runtime factory throws when `requireTrust` is set
 *   (`main/runtime-factory.ts`). Only `--help` and `--list-models` run without trust, and they open no session. An
 *   untrusted loader is therefore reachable through an embedder that builds a session with `projectTrusted: false`,
 *   or a trust revoked mid-session (`SettingsManager.setProjectTrusted`); this is defense in depth.
 */
const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
	vi.unstubAllEnvs();
});

type Shape = "no-git" | "empty-index-git";

function setup(shape: Shape, local: (outside: string) => object, user?: object) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "source-policy-untrusted-"));
	roots.push(root);
	const cwd = path.join(root, "work");
	const home = path.join(root, "home");
	const outside = path.join(root, "outside");
	for (const dir of [path.join(cwd, ".claude"), home, outside]) fs.mkdirSync(dir, { recursive: true });
	vi.stubEnv("CLAUDE_CONFIG_DIR", home);
	if (shape === "empty-index-git") execFileSync("git", ["init", "-q"], { cwd });
	fs.writeFileSync(path.join(cwd, ".claude", "settings.local.json"), JSON.stringify(local(outside)));
	if (user) fs.writeFileSync(path.join(home, "settings.json"), JSON.stringify(user));
	return { cwd, home, outside, owner: registerSourcePolicy(fakeHost().api, { home }) };
}

const shell = (command: string) => ({ active: true, toolCallId: "x", toolName: "bash", input: { command } });
const write = (file: string) => ({
	active: true,
	toolCallId: "w",
	toolName: "file",
	input: { queries: [{ type: "write", path: file, content: "x" }] },
});

async function load(f: ReturnType<typeof setup>, trusted: boolean) {
	await f.owner.refresh({ ...fakeCtx({ cwd: f.cwd, hasUI: false }), isProjectTrusted: () => trusted });
}

const grants = (outside: string) => ({
	permissions: {
		allow: ["Bash(*)"],
		defaultMode: "acceptEdits",
		additionalDirectories: [outside],
		deny: ["Bash(rm *)"],
	},
});

it.each(["no-git", "empty-index-git"] as const)(
	"an untrusted %s folder's settings.local.json grants nothing but its deny rule still loads",
	async (shape) => {
		const f = setup(shape, grants);
		await load(f, false);
		expect(f.owner.evaluate(shell("node -p 1"), f.cwd).decision).toBe("none");
		// acceptEdits would allow this workspace edit; the added directory would allow the one outside it.
		expect(f.owner.evaluate(write(path.join(f.cwd, "notes.txt")), f.cwd).decision).toBe("none");
		expect(f.owner.evaluate(write(path.join(f.outside, "notes.txt")), f.cwd).decision).toBe("none");
		expect(f.owner.evaluate(shell("rm -rf x"), f.cwd).decision).toBe("deny");
	},
);

it("the user's own settings keep granting while an untrusted project's local file does not", async () => {
	const f = setup("no-git", grants, { permissions: { allow: ["Bash(node -p 1)"] } });
	await load(f, false);
	expect(f.owner.evaluate(shell("node -p 1"), f.cwd).decision).toBe("allow");
	expect(f.owner.evaluate(shell("node -p 2"), f.cwd).decision).toBe("none");
});

it.each(["no-git", "empty-index-git"] as const)(
	"the same %s folder trusted loads the local allow rule, acceptEdits and extra directory",
	async (shape) => {
		const f = setup(shape, grants);
		await load(f, true);
		expect(f.owner.evaluate(shell("node -p 1"), f.cwd).decision).toBe("allow");
		expect(f.owner.evaluate(write(path.join(f.cwd, "notes.txt")), f.cwd).decision).toBe("allow");
		expect(f.owner.evaluate(write(path.join(f.outside, "notes.txt")), f.cwd).decision).toBe("allow");
		expect(f.owner.evaluate(shell("rm -rf x"), f.cwd).decision).toBe("deny");
	},
);

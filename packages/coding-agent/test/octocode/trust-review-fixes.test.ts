import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";
import { sharedAgentDb, trust } from "../../src/octocode/agentdb/api.ts";
import { enforceFolderTrust } from "../../src/main/trust-gate.ts";
import { runTrustCommand } from "../../src/cli/trust-command.ts";
import { FolderGrantRefusedError, grantFolder, refuseFolder } from "../../src/octocode/trust/grants.ts";
import { folderEntry } from "../../src/octocode/trust/identity.ts";
import { resolveFolderTrust } from "../../src/octocode/trust/resolve.ts";

/**
 * The B409 trust review fixes, each through the entry point it concerns, with an isolated home and agent database.
 */
const resolver = fileURLToPath(new URL("../../scripts/source-resolver.ts", import.meta.url));
const cli = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));
const roots: string[] = [];

function sandbox() {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "octocode-trust-review-")));
	roots.push(root);
	// A machine with several users: /root/Users/me is home, /root/Users/Shared is another folder under /root/Users.
	const home = path.join(root, "Users", "me");
	const project = path.join(home, "code", "app");
	const shared = path.join(root, "Users", "Shared", "x");
	const other = path.join(root, "elsewhere", "proj");
	for (const dir of [project, shared, other, path.join(root, "agent")]) fs.mkdirSync(dir, { recursive: true });
	const db = path.join(root, "agent.sqlite");
	const env: NodeJS.ProcessEnv = {
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
		if (name.startsWith("OCTOCODE_SUBAGENT") || name === "OCTOCODE_SESSION_ID") delete env[name];
	return { root, home, project, shared, other, env, db, opts: { env, home } };
}

afterAll(() => {
	for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

describe("a grant above the home folder (finding 2)", () => {
	it("refuses a subtree grant on an ancestor of home, offers none, and ignores an existing row", async () => {
		const box = sandbox();
		const users = path.dirname(box.home);
		// /root/Users/Shared/x: its grandparent /root/Users contains home.
		expect(() => grantFolder(box.shared, "grandparent", { source: "command", surface: "cli" }, box.opts)).toThrow(
			FolderGrantRefusedError,
		);
		try {
			grantFolder(box.shared, "grandparent", { source: "command", surface: "cli" }, box.opts);
		} catch (error) {
			expect((error as FolderGrantRefusedError).reason).toBe("contains-home");
		}
		// The prompt does not offer it either.
		const offered: string[] = [];
		await enforceFolderTrust({
			cwd: box.shared,
			surface: "tui",
			options: box.opts,
			prompt: async (input) => {
				offered.push(input.parent ?? "-", input.grandparent ?? "-");
				return "not-now";
			},
		});
		expect(offered).toEqual([path.dirname(box.shared), "-"]);
		// A folder-scope decision on that ancestor covers only itself and stays allowed.
		expect(grantFolder(users, "folder", { source: "command", surface: "cli" }, box.opts).scope).toBe("folder");
		// An old subtree row on it is ignored with the notice, and does not trust home's projects.
		const db = sharedAgentDb(box.env);
		trust.decide(
			db.db,
			{
				...folderEntry(users),
				path: users,
				decision: "trusted",
				scope: "subtree",
				source: "import",
				surface: "migration",
				decidedBy: "me",
			},
			Date.now(),
		);
		const state = resolveFolderTrust(box.project, box.opts);
		expect(state.state).toBe("undecided");
		expect(state.ignoredGrants.map((row) => row.reason)).toEqual(["contains-home"]);
	});
});

describe("a re-grant after the stored birth time stopped matching (finding 3)", () => {
	it("records a new decision with the fresh identity instead of returning the old row", () => {
		const box = sandbox();
		const db = sharedAgentDb(box.env);
		const entry = folderEntry(box.other);
		const stale = trust.decide(
			db.db,
			{
				...entry,
				birth: "12345",
				decision: "trusted",
				scope: "folder",
				source: "prompt",
				surface: "tui",
				decidedBy: "me",
			},
			Date.now(),
		);
		expect(resolveFolderTrust(box.other, box.opts).state).toBe("undecided");
		const fresh = grantFolder(box.other, "folder", { source: "command", surface: "cli" }, box.opts);
		expect(fresh.id).not.toBe(stale.id);
		expect(resolveFolderTrust(box.other, box.opts).state).toBe("trusted");
	});
});

describe("trust recorded from inside a session's shell (finding 4)", () => {
	it("`trust add --yes` and `--trust` refuse when OCTOCODE_SESSION_ID is set, and work in the user's terminal", async () => {
		const box = sandbox();
		const inside = { ...box.opts, env: { ...box.env, OCTOCODE_SESSION_ID: "s1" } };
		const errors: string[] = [];
		const io = (options: { env: NodeJS.ProcessEnv; home: string }) => ({
			cwd: box.other,
			options,
			out: () => {},
			err: (text: string) => errors.push(text),
		});
		expect(await runTrustCommand(["add", "--yes"], io(inside))).toBe(1);
		expect(errors.join("\n")).toMatch(/inside an Octocode session's shell[^]*your own terminal/);
		expect(resolveFolderTrust(box.other, box.opts).state).toBe("undecided");
		const gated = await enforceFolderTrust({ cwd: box.other, surface: "print", trustFlag: true, options: inside });
		expect(gated.ok).toBe(false);
		expect(resolveFolderTrust(box.other, box.opts).state).toBe("undecided");
		// The real CLI: --trust from a process that has the variable records nothing.
		const cliRun = spawnSync(process.execPath, ["--import", resolver, cli, "-p", "hi", "--trust"], {
			cwd: box.other,
			env: inside.env,
			encoding: "utf8",
			timeout: 60_000,
			input: "",
		});
		expect(cliRun.status).toBe(1);
		expect(cliRun.stderr).toContain("your own terminal");
		expect(resolveFolderTrust(box.other, box.opts).state).toBe("undecided");
		// The user's own terminal has no such variable.
		expect(await runTrustCommand(["add", "--yes"], io(box.opts))).toBe(0);
		expect(resolveFolderTrust(box.other, box.opts).state).toBe("trusted");
		// Removing is the same decision in the other direction.
		expect(await runTrustCommand(["remove", "--yes", box.other], io(inside))).toBe(1);
		expect(resolveFolderTrust(box.other, box.opts).state).toBe("trusted");
	});
});

describe("--trust over a remembered refusal (finding 8)", () => {
	it("records the grant and says it replaced the refusal", async () => {
		const box = sandbox();
		refuseFolder(box.other, { source: "command", surface: "cli" }, box.opts);
		const result = await enforceFolderTrust({ cwd: box.other, surface: "print", trustFlag: true, options: box.opts });
		expect(result.ok).toBe(true);
		expect(result.ok && result.notice).toMatch(/marked "do not trust"[^]*replaced that decision with a grant/);
		expect(resolveFolderTrust(box.other, box.opts).state).toBe("trusted");
	});
});

describe("the interactive gate (enforceFolderTrust, surface tui)", () => {
	it("Not now records nothing, Do not trust is remembered, Trust records the chosen scope", async () => {
		const box = sandbox();
		const ask = (choice: "folder" | "parent" | "grandparent" | "refuse" | "not-now") =>
			enforceFolderTrust({ cwd: box.project, surface: "tui", options: box.opts, prompt: async () => choice });
		const notNow = await ask("not-now");
		expect(notNow).toMatchObject({ ok: false, exitCode: 0 });
		expect(resolveFolderTrust(box.project, box.opts).state).toBe("undecided");
		const refused = await ask("refuse");
		expect(refused).toMatchObject({ ok: false, exitCode: 0 });
		expect(resolveFolderTrust(box.project, box.opts).state).toBe("refused");
		// Remembered: the next open does not ask.
		let asked = false;
		const again = await enforceFolderTrust({
			cwd: box.project,
			surface: "tui",
			options: box.opts,
			prompt: async () => ((asked = true), "folder"),
		});
		expect(again).toMatchObject({ ok: false, exitCode: 0 });
		expect(asked).toBe(false);
		// --trust yields over the refusal; a later parent grant covers siblings.
		expect(
			(await enforceFolderTrust({ cwd: box.project, surface: "tui", trustFlag: true, options: box.opts })).ok,
		).toBe(true);
		const sibling = path.join(box.home, "code", "other");
		fs.mkdirSync(sibling);
		expect(
			await enforceFolderTrust({ cwd: sibling, surface: "tui", options: box.opts, prompt: async () => "parent" }),
		).toMatchObject({ ok: true });
		const second = path.join(box.home, "code", "third");
		fs.mkdirSync(second);
		expect(resolveFolderTrust(second, box.opts).state).toBe("trusted");
	});
});

describe("a session switch into an untrusted folder (finding 1)", () => {
	it("RPC switch_session returns an error and the running session survives", async () => {
		const box = sandbox();
		grantFolder(box.project, "folder", { source: "command", surface: "cli" }, box.opts);
		const sessionDir = path.join(box.root, "sessions");
		const foreign = SessionManager.create(box.other, sessionDir);
		foreign.materialize();
		const file = foreign.getSessionFile()!;
		expect(fs.existsSync(file)).toBe(true);
		const child = spawn(process.execPath, ["--import", resolver, cli, "--mode", "rpc", "--session-dir", sessionDir], {
			cwd: box.project,
			env: box.env,
		});
		let out = "";
		let err = "";
		child.stdout.on("data", (chunk) => (out += chunk));
		child.stderr.on("data", (chunk) => (err += chunk));
		const exited = new Promise<number | null>((resolve) => child.on("close", resolve));
		const send = (command: object) => child.stdin.write(`${JSON.stringify(command)}\n`);
		const responses = () =>
			out
				.split("\n")
				.filter((line) => line.startsWith("{"))
				.map(
					(line) =>
						JSON.parse(line) as { id?: string; success?: boolean; error?: string; data?: { sessionId?: string } },
				);
		const waitFor = async (id: string) => {
			for (let wait = 0; wait < 600; wait += 1) {
				const found = responses().find((response) => response.id === id);
				if (found) return found;
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
			throw new Error(`no response for ${id}; stderr: ${err}`);
		};
		try {
			send({ id: "before", type: "get_state" });
			const before = await waitFor("before");
			send({ id: "switch", type: "switch_session", sessionPath: file });
			const switched = await waitFor("switch");
			expect(switched.success).toBe(false);
			expect(switched.error).toMatch(/not trusted/);
			send({ id: "after", type: "get_state" });
			const after = await waitFor("after");
			expect(after.success).toBe(true);
			expect(after.data?.sessionId).toBe(before.data?.sessionId);
		} finally {
			child.stdin.end();
			child.kill();
			await exited;
		}
		// Nothing of the foreign folder was started, and no crash was recorded.
		expect(err).not.toMatch(/crash/i);
	}, 90_000);
});

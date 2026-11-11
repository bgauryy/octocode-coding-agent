import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { connectAcp } from "../../src/octocode/external/acp-host.ts";
import { runnerRows } from "../../src/octocode/external/connected.ts";
import { agentEnv } from "../../src/octocode/external/runner-env.ts";
import { launchOf, runnerTurn, type RunnerTurnDeps } from "../../src/octocode/external/runner-session.ts";
import { cachedRunners, checkRunners, isConnected } from "../../src/octocode/external/runner-status.ts";
import { adapterArgs, olderThan, runnerSpec, versionOf } from "../../src/octocode/external/runners.ts";
import { fakeCtx } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

const fixture = fileURLToPath(new URL("./fixtures/external-acp-agent.mjs", import.meta.url));
const authPeer = fileURLToPath(new URL("../../../acp/test/client/capability-peer.mjs", import.meta.url));
const read = (id: string) => runnerSpec(id)!.status!.read;
const cancelled = () => async () => ({ outcome: { outcome: "cancelled" as const } });

afterEach(() => vi.unstubAllEnvs());

describe("runner status commands", () => {
	it("reads Claude Code's JSON: signed in by claude.ai is plan-billed, an API key metered; nothing else is kept", () => {
		const plan = read("claude-code")(
			JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", email: "me@example.com" }),
			0,
		);
		expect(plan).toEqual({ signedIn: true, method: "claude.ai", billing: "plan" });
		expect(read("claude-code")('{"loggedIn":true,"authMethod":"api_key","apiProvider":"firstParty"}', 0)).toEqual({
			signedIn: true,
			method: "api_key",
			billing: "metered",
		});
		expect(read("claude-code")('{"loggedIn":false,"authMethod":"none"}', 1)).toEqual({ signedIn: false });
		expect(read("claude-code")("not json", 1)).toBeUndefined();
	});

	it("reads Codex's line by its kind only, never the key prefix it prints", () => {
		expect(read("codex")("Logged in using ChatGPT\n", 0)).toEqual({
			signedIn: true,
			method: "ChatGPT",
			billing: "plan",
		});
		const key = read("codex")("Logged in using an API key - sk-proj-***ABCD\n", 0);
		expect(key).toEqual({ signedIn: true, method: "API key", billing: "metered" });
		expect(JSON.stringify(key)).not.toContain("sk-");
		expect(read("codex")("Not logged in\n", 1)).toEqual({ signedIn: false });
	});

	it("reads OpenCode's credential list without its values", () => {
		expect(read("opencode")('[{"provider":"opencode","type":"api","key":"secret"}]', 0)).toEqual({
			signedIn: true,
			method: "opencode auth",
		});
		expect(read("opencode")("[]", 0)).toEqual({ signedIn: false });
	});

	it("compares versions and guards a metered Claude Code login with --hide-claude-auth", () => {
		expect(versionOf("2.1.322 (Claude Code)")).toBe("2.1.322");
		expect(versionOf("codex-cli 0.166.0")).toBe("0.166.0");
		expect(olderThan("2.1.99", "2.1.322")).toBe(true);
		expect(olderThan("2.2.0", "2.1.322")).toBe(false);
		const claude = runnerSpec("claude-code")!;
		expect(adapterArgs(claude, "plan")).toEqual([]);
		expect(adapterArgs(claude, "metered")).toEqual(["--hide-claude-auth"]);
		expect(adapterArgs(runnerSpec("gemini")!, "metered")).toEqual(["--acp"]);
	});
});

describe("the runner environment", () => {
	it("drops provider keys, every ANTHROPIC_ variable and Octocode's own, keeps a runner's configuration", () => {
		const env = agentEnv("claude-code", {
			PATH: "/bin",
			HOME: "/home/me",
			ANTHROPIC_API_KEY: "sk-ant-api03-x",
			ANTHROPIC_BASE_URL: "https://proxy",
			OPENAI_API_KEY: "sk-x",
			CODEX_API_KEY: "x",
			OPENROUTER_API_KEY: "x",
			OCTOCODE_SUBAGENT: "1",
			OCTOCODE_HOME: "/home/me/.octocode",
			CLAUDE_CONFIG_DIR: "/home/me/.claude-work",
			CLAUDE_CODE_OAUTH_TOKEN: "user-set",
		});
		expect(env).toEqual({
			PATH: "/bin",
			HOME: "/home/me",
			OCTOCODE_HOME: "/home/me/.octocode",
			CLAUDE_CONFIG_DIR: "/home/me/.claude-work",
			CLAUDE_CODE_OAUTH_TOKEN: "user-set",
		});
	});
});

/** A stand-in vendor CLI and adapter: `claude` answers --version and auth status from a file, and counts its runs. */
function fakeClaude() {
	const home = tmp("octocode-runner-home-");
	const bin = path.join(home, "bin");
	fs.mkdirSync(bin);
	fs.mkdirSync(path.join(home, ".claude"));
	const runs = path.join(home, "runs.log");
	const script = [
		"#!/bin/sh",
		`echo "$*" >> "${runs}"`,
		'if [ "$1" = "--version" ]; then echo "2.1.400 (Claude Code)"; exit 0; fi',
		`if [ -f "${home}/.claude/.credentials.json" ]; then echo '{"loggedIn": true, "authMethod": "claude.ai", "apiProvider": "firstParty", "email": "me@example.com"}'; exit 0; fi`,
		`echo '{"loggedIn": false, "authMethod": "none"}'; exit 1`,
	].join("\n");
	fs.writeFileSync(path.join(bin, "claude"), script, { mode: 0o755 });
	fs.writeFileSync(path.join(bin, "claude-agent-acp"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
	const env = { PATH: bin, HOME: home };
	const agentDir = path.join(home, "agent");
	fs.mkdirSync(agentDir);
	const count = () => (fs.existsSync(runs) ? fs.readFileSync(runs, "utf8").trim().split("\n").length : 0);
	return { home, env, agentDir, count };
}

describe("checking runners", () => {
	it("runs the CLI's own commands once, reuses the answer until its sign-in files change, and stores no account detail", async () => {
		const claude = fakeClaude();
		const first = await checkRunners({ env: claude.env, agentDir: claude.agentDir });
		const state = first.find((entry) => entry.id === "claude-code")!;
		expect(state).toMatchObject({ cli: true, adapter: true, version: "2.1.400", auth: { signedIn: false } });
		expect(isConnected(state)).toBe(false);
		expect(first.find((entry) => entry.id === "codex")).toMatchObject({ cli: false });
		expect(claude.count()).toBe(2);
		await checkRunners({ env: claude.env, agentDir: claude.agentDir });
		expect(claude.count()).toBe(2);
		// Signing in writes its credentials: the cached answer is stale, and the next check runs the commands again.
		fs.writeFileSync(path.join(claude.home, ".claude", ".credentials.json"), "{}");
		expect(cachedRunners(claude.env, claude.agentDir).map((entry) => entry.id)).not.toContain("claude-code");
		const second = await checkRunners({ env: claude.env, agentDir: claude.agentDir });
		expect(claude.count()).toBe(4);
		const signedIn = second.find((entry) => entry.id === "claude-code")!;
		expect(signedIn.auth).toEqual({ signedIn: true, method: "claude.ai", billing: "plan" });
		expect(
			cachedRunners(claude.env, claude.agentDir)
				.filter(isConnected)
				.map((entry) => entry.id),
		).toEqual(["claude-code"]);
		// Ordinary CLI use rewrites its state file and touches its folder: the runner stays connected, nothing re-runs.
		const later = new Date(Date.now() + 60_000);
		fs.writeFileSync(path.join(claude.home, ".claude.json"), "{}");
		fs.utimesSync(path.join(claude.home, ".claude"), later, later);
		expect(
			cachedRunners(claude.env, claude.agentDir)
				.filter(isConnected)
				.map((entry) => entry.id),
		).toEqual(["claude-code"]);
		const saved = fs.readFileSync(path.join(claude.agentDir, "external-runners.json"), "utf8");
		expect(saved).not.toContain("example.com");
		expect(fs.statSync(path.join(claude.agentDir, "external-runners.json")).mode & 0o777).toBe(0o600);
		expect(runnerRows(second.filter(isConnected)).join("\n")).toMatch(
			/^Connected runners:[^\n]*\n {2}\S+ claude-code · Claude Code 2\.1\.400 · claude\.ai · plan$/,
		);
	});

	it("refuses a runner that is not connected, naming /providers", () => {
		expect(() => launchOf("claude-code", [])).toThrow(/not connected.*\/providers/);
	});
});

describe("a runner's turn over ACP", () => {
	const deps = (args: string[], command = process.execPath): RunnerTurnDeps => ({
		launch: () => ({ command, args, billing: "plan" }),
		connect: connectAcp,
		permission: cancelled,
	});

	it("streams tool calls to the row, returns the report with its usage and cost, and starts without provider keys", async () => {
		vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-api03-fixture");
		vi.stubEnv("OPENAI_API_KEY", "sk-fixture");
		const cwd = tmp("octocode-runner-turn-");
		const journal = path.join(cwd, "journal.jsonl");
		const activity: string[] = [];
		let pid: number | undefined;
		const reply = await runnerTurn(
			{
				runner: "claude-code",
				cwd,
				text: "Read src/app.ts",
				signal: new AbortController().signal,
				onActivity: (line) => activity.push(line),
				onStart: (started) => (pid = started),
				ctx: fakeCtx({ cwd }),
			},
			deps([fixture, "report", journal]),
		);
		expect(reply).toEqual({
			text: "done: the runner read src/app.ts\nNoticed: none",
			stopReason: "end_turn",
			usage: { inputTokens: 1000, outputTokens: 200, cachedReadTokens: 50, totalTokens: 1250 },
			cost: 0.42,
			billing: "plan",
		});
		expect(activity).toEqual(["→ Read src/app.ts"]);
		const started = JSON.parse(fs.readFileSync(journal, "utf8").split("\n")[0]);
		expect(started.pid).toBe(pid);
		expect(started.env).not.toContain("ANTHROPIC_API_KEY");
		expect(started.env).not.toContain("OPENAI_API_KEY");
	});

	it("says a runner that answers auth_required is signed out, and sends no prompt", async () => {
		const cwd = tmp("octocode-runner-auth-");
		const journal = path.join(cwd, "journal.jsonl");
		const methods = [{ id: "claude-login", name: "Log in with Claude", type: "terminal", args: [], env: {} }];
		await expect(
			runnerTurn(
				{
					runner: "claude-code",
					cwd,
					text: "work",
					signal: new AbortController().signal,
					onActivity: () => undefined,
					ctx: fakeCtx({ cwd }),
				},
				deps([authPeer, journal, JSON.stringify({ authMethods: methods })]),
			),
		).rejects.toThrow(/claude-code is signed out: sign in with \/providers/);
		const events = fs
			.readFileSync(journal, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line).event);
		expect(events).toEqual(["new"]);
	});
});

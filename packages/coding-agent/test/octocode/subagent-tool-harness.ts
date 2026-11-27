import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll } from "vitest";
import { grantFolder } from "../../src/octocode/trust/grants.ts";
import { Subcommands } from "../../src/octocode/shared/commands.ts";
import { MAX_SUBAGENTS_ENV, type SwarmLimits } from "../../src/octocode/subagents/claim.ts";
import type { AgentProfile } from "../../src/octocode/subagents/profiles.ts";
import { registerAgentTool } from "../../src/octocode/subagents/tool.ts";
import { Team } from "../../src/octocode/team/session.ts";
import { fakeCachePolicy, fakeCtx, fakeHost, fakePermission, meteredBilling } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

const FIXTURE = path.join(path.dirname(new URL(import.meta.url).pathname), "subagent-fake-host.cjs");
export const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

export function repo(): string {
	const dir = fs.realpathSync(tmp("octocode-agent-repo-"));
	git(dir, "init", "-q", "-b", "main");
	git(dir, "config", "user.name", "Test");
	git(dir, "config", "user.email", "test@example.com");
	fs.writeFileSync(path.join(dir, "a.txt"), "one\n");
	git(dir, "add", "-A");
	git(dir, "commit", "-q", "-m", "init");
	return dir;
}

/**
 * Each test file also mocks `src/config.ts` itself (`vi.mock` applies per file and cannot live in a helper): its
 * `getCliInvocation` returns `{ command: process.execPath, prefix: [process.argv[1]] }`, so a child runs the stand-in.
 *
 * Registers the file's hooks: a clean team identity and `octocode` pointing at the scripted stand-in child. Call once at
 * the top of a test file. `trustTemp` trusts the temp folder in this file's own (empty) database, the way
 * tests/setup-env.ts does through a throwaway child, for files whose children run in plain temp folders; files that test
 * trust must leave it off.
 */
export function useScriptedChild({ trustTemp = false } = {}): void {
	const savedArgv = process.argv[1];
	const savedEnv = { ...process.env };
	beforeAll(() => {
		const root = tmp("octocode-agent-tool-");
		process.env.OCTOCODE_HOME = path.join(root, "home");
		process.env.OCTOCODE_AGENT_DB = path.join(root, "team", "team.sqlite");
		// Tests may run inside an Octocode subagent: start from a clean team identity.
		for (const key of [
			MAX_SUBAGENTS_ENV,
			"OCTOCODE_SUBAGENT",
			"OCTOCODE_AGENT_ID",
			"OCTOCODE_PARENT_ID",
			"OCTOCODE_AGENT_GOAL",
			"OCTOCODE_AGENT_SCRATCH",
			"OCTOCODE_TEAM_WORKSPACE",
		])
			delete process.env[key];
		// runSubagent re-runs the current `octocode` script: point it at the scripted stand-in.
		const bin = path.join(root, "bin");
		fs.mkdirSync(bin);
		fs.copyFileSync(FIXTURE, path.join(bin, "octocode"));
		process.argv[1] = path.join(bin, "octocode");
		if (trustTemp)
			grantFolder(fs.mkdtempSync(path.join(os.tmpdir(), "octocode-test-anchor-")), "parent", {
				source: "command",
				surface: "cli",
			});
	});

	afterAll(() => {
		process.argv[1] = savedArgv!;
		process.env = savedEnv;
	});
}

export const profiles = new Map<string, AgentProfile>([
	[
		"researcher",
		{
			name: "researcher",
			description: "reads",
			prompt: "Research only.",
			tools: "read,bash",
			excludeTools: "browser",
			model: "faux/model",
		},
	],
	[
		"browser",
		{
			name: "browser",
			description: "browser",
			prompt: "Drive the browser.",
			tools: "mcp__browser__*,web",
			headless: true,
		},
	],
]);

/** Why profile files were refused when the profiles loaded, by file name (as `index.ts` collects them from `onSkip`). */
export const refused = new Map<string, string>();

export function setup(cwd = tmp("octocode-agent-cwd-"), hasUI = true, limits?: SwarmLimits) {
	const f = fakeHost();
	const team = new Team(f.api);
	const control = registerAgentTool(f.api, {
		profiles: () => profiles,
		team,
		permission: fakePermission(),
		refused: () => refused,
		limits,
	});
	// As index.ts wires it: the `/agents` command.
	const commands = new Subcommands();
	commands.add("agents", control.command);
	commands.register(f.api);
	const ctx = fakeCtx({ cwd, hasUI });
	// An isolated child needs a new worktree: the parent asks "Trust new worktree?" and the user says yes.
	Object.assign(ctx.ui, { confirm: async () => true });
	// The parent's models: `faux/model` is the session's, `faux/other` and `alt/shared` are also available.
	// They reason, so a route keeps the thinking level it names.
	const models = [
		{ provider: "faux", id: "model", reasoning: true },
		{ provider: "faux", id: "other", reasoning: true },
		{ provider: "alt", id: "shared", reasoning: true },
		// Authenticated only by this session's --api-key: a child cannot receive that key.
		{ provider: "session-only", id: "keyed" },
	];
	Object.assign(ctx, {
		model: models[0],
		modelRegistry: {
			...meteredBilling,
			getAvailable: () => models,
			find: (provider: string, id: string) => models.find((m) => m.provider === provider && m.id === id),
			getCachePolicy: fakeCachePolicy,
			getProviderAuthStatus: (provider: string) => ({
				configured: true,
				source: provider === "session-only" ? "runtime" : "stored",
			}),
		},
	});
	team.start(ctx);
	const agent = f.tools.get("agent");
	const run = (params: Record<string, unknown>, signal?: AbortSignal, onUpdate?: (update: unknown) => void) =>
		agent.execute("call-1", { goal: "check things", ...params }, signal, onUpdate, ctx);
	return { ...f, team, ctx, agent, run, cwd, control };
}

export const reportJson = (text: string) =>
	JSON.parse(
		text.slice(text.indexOf("{"), text.indexOf("}\n") >= 0 ? text.indexOf("}\n") + 1 : text.lastIndexOf("}") + 1),
	);
/** The fake child's report as JSON: read from the saved whole report when the inline preview was cut at its byte cap. */
export const reportOf = (text: string) => {
	const pointer = /Full (?:partial )?report: (.+?) \(read only the parts you need\)/.exec(text)?.[1];
	if (!pointer) return reportJson(text);
	const file = pointer.startsWith("~") ? path.join(os.homedir(), pointer.slice(1)) : path.resolve(pointer);
	return reportJson(fs.readFileSync(file, "utf8"));
};

/** The text of a sent message under its source header (the header is pinned in events/source.test.ts). */
export const unsourced = (content: unknown) => String(content).replace(/^\[src [^\n]*\n/, "");

import { captureSkillResourceSnapshot } from "../../src/core/skill-resource-snapshot.ts";
import { loadSkills } from "../../src/core/skills.ts";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type * as NativeConfig from "../../src/config.ts";
import { reportContract } from "../../src/octocode/instructions/report.ts";
import { archiveSearch, existingLibrary, writeSegment } from "../../src/octocode/shared/archive.ts";
import { Subcommands } from "../../src/octocode/shared/commands.ts";
import { fencedParts } from "../../src/octocode/shared/fence.ts";
import { processAlive, processStartTime } from "../../src/octocode/shared/process.ts";
import { type AgentRuns, claimRun, MAX_SUBAGENTS_ENV, Slots } from "../../src/octocode/subagents/claim.ts";
import { ReportQueue } from "../../src/octocode/subagents/handoff.ts";
import { runSubagent } from "../../src/octocode/subagents/process.ts";
import type { AgentProfile } from "../../src/octocode/subagents/profiles.ts";
import { childStagger } from "../../src/octocode/subagents/stagger.ts";
import { registerAgentTool } from "../../src/octocode/subagents/tool.ts";
import { createWorktree, worktreesDir } from "../../src/octocode/subagents/worktree.ts";
import { Team } from "../../src/octocode/team/session.ts";
import { TeamStore } from "../../src/octocode/team/store.ts";
import { registerCollab } from "../../src/octocode/team/tools.ts";
import { fakeCachePolicy, fakeCtx, fakePermission, fakeHost, rendered, theme } from "./fake-host.ts";
import { tmp } from "./helpers.ts";
import { ReadReports } from "../../src/octocode/subagents/handoff/scratch.ts";
import { exitReason, USER_STOP } from "../../src/octocode/subagents/process/outcome.ts";
import { openBacklog } from "../../src/octocode/backlog/context.ts";

const FIXTURE = path.join(path.dirname(new URL(import.meta.url).pathname), "subagent-fake-host.cjs");
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const savedArgv = process.argv[1];
const savedEnv = { ...process.env };

function repo(): string {
	const dir = fs.realpathSync(tmp("octocode-agent-repo-"));
	git(dir, "init", "-q", "-b", "main");
	git(dir, "config", "user.name", "Test");
	git(dir, "config", "user.email", "test@example.com");
	fs.writeFileSync(path.join(dir, "a.txt"), "one\n");
	git(dir, "add", "-A");
	git(dir, "commit", "-q", "-m", "init");
	return dir;
}

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
});

afterAll(() => {
	process.argv[1] = savedArgv!;
	process.env = savedEnv;
});

const profiles = new Map<string, AgentProfile>([
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
const refused = new Map<string, string>();

function setup(cwd = tmp("octocode-agent-cwd-"), hasUI = true) {
	const f = fakeHost();
	const team = new Team(f.api);
	const control = registerAgentTool(
		f.api,
		() => profiles,
		team,
		fakePermission(),
		() => refused,
	);
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

const reportOf = (text: string) =>
	JSON.parse(
		text.slice(text.indexOf("{"), text.indexOf("}\n") >= 0 ? text.indexOf("}\n") + 1 : text.lastIndexOf("}") + 1),
	);

describe("subagent scratch sweep", () => {
	it("keeps old folders whose owning Octocode process is alive (another session's background subagent) and removes the rest", async () => {
		const s = setup();
		const root = path.join(s.cwd, ".octa", "code", "temp", "agents");
		// Past the default OCTOCODE_CLEANUP_DAYS (30).
		const old = (Date.now() - 31 * 24 * 3_600_000) / 1000;
		const folder = (name: string, owner?: number) => {
			const dir = path.join(root, name);
			fs.mkdirSync(dir, { recursive: true });
			if (owner !== undefined) fs.writeFileSync(path.join(dir, ".owner"), String(owner));
			fs.utimesSync(dir, old, old);
			return dir;
		};
		const otherSession = folder("worker-live", process.ppid);
		// A recorded start time guards against pid reuse: the pid runs, but it is not the process that made the folder.
		const started = processStartTime(process.pid);
		const reused = folder("worker-reused", process.pid);
		fs.writeFileSync(path.join(reused, ".owner"), `${process.pid} Thu Jan  1 00:00:00 1970`);
		const sameProcess = folder("worker-same", process.pid);
		fs.writeFileSync(path.join(sameProcess, ".owner"), started ? `${process.pid} ${started}` : String(process.pid));
		const dead = folder("worker-dead", 9_999_999);
		const unowned = folder("worker-unowned");
		const fresh = path.join(root, "worker-fresh");
		fs.mkdirSync(fresh);
		await s.fire("session_start", { type: "session_start" }, s.ctx);
		await vi.waitFor(() =>
			expect([dead, unowned, ...(started === undefined ? [] : [reused])].some((dir) => fs.existsSync(dir))).toBe(false),
		);
		expect(fs.existsSync(otherSession)).toBe(true);
		expect(fs.existsSync(sameProcess)).toBe(true);
		expect(fs.existsSync(reused)).toBe(started === undefined);
		expect(fs.existsSync(fresh)).toBe(true);
		expect(fs.existsSync(dead)).toBe(false);
		expect(fs.existsSync(unowned)).toBe(false);
		await s.fire("session_shutdown", { type: "session_shutdown" }, s.ctx);
	});
});

describe("agent tool with a scripted child", () => {
	let s: ReturnType<typeof setup>;
	beforeEach(() => {
		s = setup();
	});
	it("validates the final full JSON answer and persists its contract for foreground and background runs", async () => {
		const resultSchema = {
			type: "object",
			properties: { verdict: { type: "string", enum: ["pass", "fail"] } },
			required: ["verdict"],
			additionalProperties: false,
		};
		const valid = await s.run({ task: "structured valid", resultSchema });
		expect(valid.isError).toBeUndefined();
		expect(valid.details.structured).toMatchObject({ status: "valid", data: { verdict: "pass" } });
		expect(valid.details.outcome).toBe("done");
		const snapshot = path.join(valid.details.session.dir, "result-schema-v1.json");
		expect(JSON.parse(fs.readFileSync(snapshot, "utf8"))).toMatchObject({
			version: 1,
			schemaHash: valid.details.structured.schemaHash,
			schema: resultSchema,
		});
		const invalid = await s.run({ task: "structured invalid", resultSchema });
		expect(invalid.isError).toBe(true);
		expect(invalid.details.outcome).toBe("done");
		expect(invalid.details.structured).toMatchObject({ status: "invalid", error: { code: "schema" } });
		expect(invalid.details.structured).not.toHaveProperty("data");
		const aborted = await s.run({ task: "structured abort", resultSchema });
		expect(aborted.isError).toBe(true);
		expect(aborted.details.structured).toMatchObject({ status: "unavailable" });
		await s.run({ task: "structured valid", resultSchema, background: true });
		await s.control.settle();
		const report = s.sent.findLast((entry) => entry.message.customType === "octocode-agent-result");
		expect(report?.message.details.structured).toMatchObject({ status: "valid", data: { verdict: "pass" } });
	});
	it("rejects an unsupported result schema before claiming a subagent", async () => {
		await expect(
			s.run({ task: "structured valid", resultSchema: { type: "object", $ref: "https://example.org/schema" } }),
		).rejects.toThrow("Unsupported result schema keyword");
		expect(s.control.background()).toBe(0);
		expect(s.sent).toHaveLength(0);
	});
	it("inherits the parent's skill files without rediscovery and rejects unknown selections before spawning", async () => {
		const file = path.join(tmp(), "SKILL.md");
		fs.writeFileSync(file, "---\nname: release\ndescription: Release notes\n---\nUse the house format.");
		s.api.getCommands = () => [
			{
				name: "release",
				source: "skill",
				sourceInfo: {
					path: file,
					source: "test",
					scope: "temporary",
					origin: "top-level",
				},
			},
		];
		s.api.getSkillResourceSnapshot = (names) =>
			captureSkillResourceSnapshot(
				loadSkills({ cwd: s.ctx.cwd, agentDir: tmp(), skillPaths: [file], includeDefaults: false }),
				names,
				s.api.getCommands(),
			);
		const inherited = reportOf((await s.run({ task: "report back" })).content[0].text);
		expect(inherited.args).toContain("--no-skills");
		expect(inherited.args).not.toContain("--skill");
		expect(inherited.skillResources.resources).toEqual([
			expect.objectContaining({
				visible: true,
				canonicalPath: fs.realpathSync(file),
				skill: expect.objectContaining({ name: "release" }),
			}),
		]);
		expect(fs.existsSync(inherited.skillSnapshotFile)).toBe(false);
		const empty = reportOf((await s.run({ task: "report back", skills: [] })).content[0].text);
		expect(empty.args).toContain("--no-skills");
		expect(empty.args).not.toContain("--skill");
		expect(empty.skillResources.resources).toEqual([]);
		expect(fs.existsSync(empty.skillSnapshotFile)).toBe(false);
		await expect(s.run({ task: "report back", skills: ["missing"] })).rejects.toThrow(/Unknown or ambiguous/);
	});

	it("runs a foreground subagent, streams progress and returns its final answer", async () => {
		const updates: Array<{
			content: Array<{ type: string }>;
			details: { toolCalls: number; activity: string[]; shot?: string };
		}> = [];
		const result = await s.run({ task: "report back\nsecond line", profile: "researcher" }, undefined, (update) =>
			updates.push(update as never),
		);
		const text = result.content[0].text as string;
		const facts = reportOf(text);
		expect(facts.subagent).toBe("1");
		expect(facts.id).toMatch(/^[a-z]+-[a-z]+$/);
		expect(facts).toMatchObject({ role: "researcher", goal: "check things" });
		expect(facts.parent).toBe(s.team.id);
		expect(facts.cwd).toBe(fs.realpathSync(s.cwd));
		// Each subagent gets a handoff folder in the workspace, which ignores itself in git.
		expect(facts.scratch).toBe(path.join(fs.realpathSync(s.cwd), ".octa", "code", "temp", "agents", facts.id));
		// Its saved conversation keeps the handoff folder available for an explicit resume.
		expect(fs.existsSync(result.details.session.file)).toBe(true);
		expect(path.dirname(result.details.session.file)).toBe(path.join(facts.scratch, "session"));
		expect(fs.readFileSync(path.join(s.cwd, ".octa", "code", ".gitignore"), "utf8")).toBe("*\n");
		expect(facts.args).toEqual(
			expect.arrayContaining([
				"--mode",
				"rpc",
				"--session-dir",
				path.join(facts.scratch, "session"),
				"--session-id",
				result.details.session.id,
				"--model",
				"faux/model:medium",
				"--tools",
				"read,bash,file,agent,steps,archive,skill,mcp,mcp__*",
				"--exclude-tools",
				"browser,mcp__browser__*",
			]),
		);
		expect(text).toContain("(Last screenshot: ");
		expect(result.details).toMatchObject({
			profile: "researcher",
			toolCalls: 1,
			input: 100,
			cacheRead: 0,
			output: 20,
			cost: 0.01,
			unpriced: false,
			model: "faux/model:medium",
			firstTurnTokens: 100,
		});
		// The child's own facts ride in its task (after the task text), not in its system prompt.
		expect(facts.task).toBe(
			`report back\nsecond line\n\n## You\nYour name is \`${facts.id}\` (researcher). Your goal: check things. You work for \`${s.team.id}\`. Your scratch folder is \`${facts.scratch}\`. You run in the foreground: your parent reads your messages only with your report, so put a decision or approval you need in a \`blocked\` report; do not wait for an answer.\n\n## Report\n${reportContract()}`,
		);
		expect(result.usage.cost.total).toBeCloseTo(0.01);
		expect(fs.existsSync(result.details.shot)).toBe(true);
		expect(updates.some((update) => update.details.activity.includes("→ bash ls -la"))).toBe(true);
		const late = await s.team.send(facts.id, "one more thing");
		// The finished receipt points to the retained folder that owns its saved conversation.
		expect("error" in late && late.error).toContain(
			`${facts.id} has finished and takes no more messages; its report (or failure) already reached you (files it handed back, and its full report when cut, are in ${facts.scratch}). To continue`,
		);
		expect(updates.some((update) => update.content.some((part) => part.type === "image"))).toBe(true);

		const done = rendered(
			s.agent.renderResult(result, { isPartial: false, expanded: false }, theme, {
				isError: false,
				durationMs: 250,
			}),
		);
		expect(done).toMatch(/^ {2}⎿ {2}Done · [a-z]+-[a-z]+ · 1 tool call · \d+(ms|\.\d+s|s)\n/);
		const partial = rendered(
			s.agent.renderResult(
				{ content: [{ type: "text", text: "working" }], details: { ...result.details, seconds: undefined } },
				{ isPartial: true, expanded: false },
				theme,
				{ isError: false },
			),
		);
		expect(partial).toContain("→ bash ls -la");
		expect(partial).toContain("📷");
		expect(partial).toMatch(/^ {2}⎿ {2}[a-z]+-[a-z]+ · 1 tool call · ↑100 ↓20 · ≈\$0\.01 · model:medium\n/);
		const failed = rendered(
			s.agent.renderResult(
				{ content: [{ type: "text", text: "Subagent x failed\ndetail" }] },
				{ isPartial: false, expanded: false },
				theme,
				{ isError: true },
			),
		);
		// The text already says it failed: no `Error:` in front of it.
		expect(failed).toBe("  ⎿  Subagent x failed\n     detail");
		expect(
			rendered(s.agent.renderCall({ task: "look\nmore", profile: "researcher", goal: "map the auth flow" }, theme, {})),
		).toBe("○ Agent(map the auth flow)");
		expect(
			rendered(
				s.agent.renderCall({ task: "bg", background: true }, theme, {
					executionStarted: true,
					isPartial: false,
					isError: false,
				}),
			),
		).toMatch(/^✓ Agent · background/);
		expect(rendered(s.agent.renderCall({}, theme, {}))).toBe("○ Agent");
	});

	it("routes the model: profile preference, parent provider first, fallback to the parent's model, strict explicit", async () => {
		const run = async (params: Record<string, unknown>) => reportOf((await s.run(params)).content[0].text as string);
		const modelArg = (facts: { args: string[] }) => facts.args[facts.args.indexOf("--model") + 1];
		profiles.set("scout", { name: "scout", description: "", prompt: "", model: "shared:high" });
		profiles.set("absent", { name: "absent", description: "", prompt: "", model: "claude-haiku-5-5" });
		try {
			// A bare id is resolved against the available models and keeps its :thinking suffix.
			expect(modelArg(await run({ task: "report", profile: "scout" }))).toBe("alt/shared:high");
			// An unavailable preference runs on the parent's current model, pinned with --model; the render and details say so.
			const fallback = await s.run({ task: "report", profile: "absent" });
			expect(modelArg(reportOf(fallback.content[0].text))).toBe("faux/model:medium");
			expect(fallback.details).toMatchObject({ model: "faux/model:medium", fallback: "claude-haiku-5-5" });
			expect(
				rendered(
					s.agent.renderResult(fallback, { isPartial: false, expanded: true }, theme, {
						isError: false,
						expanded: true,
					}),
				),
			).toContain("model:medium (claude-haiku-5-5 unavailable)");
			// The explicit parameter beats the profile and is strict.
			// The call's model takes the profile's level when it names none.
			expect(modelArg(await run({ task: "report", profile: "scout", model: "other" }))).toBe("faux/other:high");
			await expect(s.run({ task: "report", profile: "scout", model: "faux/mdoel" })).rejects.toThrow(
				/Model "faux\/mdoel" is not available\. .*faux\/model, faux\/other/,
			);
			// A provider known only through --api-key is never routed to a child, by name or by a bare id.
			await expect(s.run({ task: "report", model: "session-only/keyed" })).rejects.toThrow(
				/session-only is authenticated by this session's --api-key/,
			);
			await expect(s.run({ task: "report", model: "keyed" })).rejects.toThrow(/Model "keyed" is not available/);
			// Without a model argument the child runs on this session's model: refused when that is session-only.
			const parentModel = s.ctx.model;
			Object.assign(s.ctx, { model: { provider: "session-only", id: "keyed" } });
			try {
				await expect(s.run({ task: "report" })).rejects.toThrow(
					/session-only is authenticated by this session's --api-key/,
				);
			} finally {
				Object.assign(s.ctx, { model: parentModel });
			}
		} finally {
			profiles.delete("scout");
			profiles.delete("absent");
		}
	});

	it("names the model a failed child ran on, and for a refused credential tells the parent to pass this session's model", async () => {
		profiles.set("scout", { name: "scout", description: "", prompt: "", model: "shared" });
		try {
			const refused = await s.run({ task: "auth error please", profile: "scout" });
			expect(refused).toMatchObject({ isError: true, details: { status: "failed", model: "alt/shared:medium" } });
			const footer = fencedParts(refused.content[0].text)?.footer ?? "";
			expect(footer).toContain("Ran on alt/shared, medium thinking (profile scout: shared).");
			expect(footer).toContain('model: "faux/model"');
			expect(footer).toContain("/login");
			expect(footer).not.toContain("narrower task");
			await s.run({ task: "auth error please", profile: "scout", background: true });
			await vi.waitFor(() => expect(s.sent.length).toBe(1), { timeout: 10_000 });
			const report = String(s.sent[0].message.content);
			// The first run's credential refusal steers routing away from `alt` (B347 P2-5): the report names where it ran instead.
			expect(report).toContain("Ran on faux/model, medium thinking (shared: alt refused its credential).");
			expect(report).toContain("fix the faux credential with /login");
			expect(report).not.toContain("narrower task");
			// On this session's own model, switching to it cannot help: the credential is the fix.
			const own = await s.run({ task: "auth error please" });
			const ownFooter = fencedParts(own.content[0].text)?.footer ?? "";
			expect(ownFooter).toContain("Ran on faux/model, medium thinking (this session's model).");
			expect(ownFooter).toContain("/login");
			expect(ownFooter).not.toContain('model: "faux/model"');
			// Any other failure keeps the usual advice and still names the model.
			const down = await s.run({ task: "error please", model: "other" });
			expect(fencedParts(down.content[0].text)?.footer).toContain(
				"Ran on faux/other, medium thinking (model argument: other).",
			);
		} finally {
			profiles.delete("scout");
		}
	});

	it("reports a failed child, a provider error with its partial answer, and an empty answer", async () => {
		await expect(s.run({ task: "fail now" })).rejects.toThrow(
			/Subagent failed \(startup\): exited with code 3 before its first model turn: boom\nFull stderr: .*stderr\.txt/,
		);
		await expect(s.run({ task: "narrate then crash" })).rejects.toThrow(
			/Subagent exited with code 3: segfault\nLast progress: Let me look at src\/a\.ts/,
		);
		const failed = await s.run({ task: "error please" });
		expect(failed).toMatchObject({ isError: true, details: { status: "failed" }, usage: { input: 100, output: 20 } });
		expect(fencedParts(failed.content[0].text)).toMatchObject({
			body: "provider down\n\nPartial answer:\npartial findings",
			footer: expect.stringContaining(
				"Retry with a narrower task or do the work yourself. The partial answer is unverified.",
			),
		});
		const limited = await s.run({ task: "length please" });
		expect(limited).toMatchObject({
			isError: true,
			details: { status: "failed" },
			usage: { input: 100, output: 20 },
		});
		expect(limited.content[0].text).toContain("Model output limit reached; the report is incomplete");
		expect(limited.content[0].text).toContain("Partial answer:\nunfinished findings");
		const silent = await s.run({ task: "silent run" });
		expect(silent).toMatchObject({ isError: true, details: { status: "failed", outcome: "failed" } });
		expect(fencedParts(silent.content[0].text)?.body).toMatch(/^Subagent ended without a final answer/);
	});

	it("passes the browser mode to each child without changing the shared profile or role instructions", async () => {
		const facts = [];
		for (const headless of [undefined, false, true]) {
			facts.push(
				reportOf(
					(await s.run({ task: "report back", profile: "browser", ...(headless === undefined ? {} : { headless }) }))
						.content[0].text as string,
				),
			);
		}
		for (const [index, child] of facts.entries()) {
			expect(child.browserVisible).toBeUndefined();
			expect(child.task).toContain(`Browser mode: headless=${index !== 1}.`);
			expect(child.rolePrompt).toBe("Drive the browser.");
			expect(child.rolePromptFile).toBe(facts[0].rolePromptFile);
			expect(child.args[child.args.indexOf("--tools") + 1]).toBe(facts[0].args[facts[0].args.indexOf("--tools") + 1]);
		}
		expect(profiles.get("browser")!.headless).toBe(true);
	});

	it("rejects a browser mode on a non-browser profile before starting a child", async () => {
		for (const profile of [undefined, "researcher"])
			await expect(s.run({ task: "report back", profile, headless: false })).rejects.toThrow(
				/headless requires a browser-enabled profile/,
			);
	});

	it("names the parent's archive library in the child's task, once the parent has one, and not before", async () => {
		const savedHome = process.env.OCTOCODE_HOME;
		process.env.OCTOCODE_HOME = tmp();
		try {
			const s = setup();
			const line = (task: string) =>
				task.split("\n").filter((text) => text.startsWith("Earlier history of your parent session"));
			const without = reportOf((await s.run({ task: "report back" })).content[0].text as string);
			expect(line(without.task)).toEqual([]);
			writeSegment(
				{
					session: "parent",
					entry: "c1",
					tokensBefore: 1,
					method: "pi-default",
					tldr: "earlier work",
					topics: [],
					readFiles: [],
					modifiedFiles: [],
					messages: 1,
				},
				"body",
			);
			const library = existingLibrary()!;
			const earlier = `Earlier history of your parent session is archived in ${path.dirname(library)} (read-only; LIBRARY.md indexes it; the repository shows today's state, the archive what was said and found then). ${archiveSearch()}`;
			const withLibrary = reportOf((await s.run({ task: "report back" })).content[0].text as string);
			// One line after the identity, in the task and not in the system prompt: the child's facts stay the same shape.
			expect(line(withLibrary.task)).toEqual([earlier]);
			expect(withLibrary.task.startsWith("report back\n\n## You\nYour name is")).toBe(true);
			expect(withLibrary.task.endsWith(`${earlier}\n\n## Report\n${reportContract()}`)).toBe(true);
			expect(withLibrary.args.join(" ")).not.toContain(library);
			// Every child keeps archive, even when its explicit allowlist only names web.
			profiles.set("restricted", { name: "restricted", description: "web", prompt: "Fetch pages.", tools: "web" });
			const offline = reportOf((await s.run({ task: "report back", profile: "restricted" })).content[0].text as string);
			expect(line(offline.task)).toEqual([earlier]);
		} finally {
			profiles.delete("restricted");
			if (savedHome === undefined) delete process.env.OCTOCODE_HOME;
			else process.env.OCTOCODE_HOME = savedHome;
		}
	});

	it("still runs the child, alone, when the team database is unusable", async () => {
		const s = setup();
		vi.spyOn(s.team, "join").mockImplementation(() => {
			throw new Error("Team database unavailable: locked");
		});
		const result = await s.run({ task: "report back", collaborate: true });
		const text = result.content[0].text as string;
		const facts = reportOf(text);
		expect(facts.parent).toBeUndefined();
		expect(facts.task).not.toContain("## Teammates");
		expect(text).toContain("Started without the team: Team database unavailable: locked");
	});

	it("shows terminal escapes and bidi controls in the child's report, error and stderr as visible escapes", async () => {
		await expect(s.run({ task: "hostile fail" })).rejects.toThrow(
			"before its first model turn: \\u{1b}]0;pwned\\u{7}boom\\u{1b}[31m red\\u{202e}",
		);
		const error = (await s.run({ task: "hostile report" })).content[0].text as string;
		expect(fencedParts(error)).toMatchObject({
			body: "bad\\u{1b}]0;title\\u{7} provider\n\nPartial answer:\n\\u{1b}]8;;https://evil.example\\u{7}click\\u{1b}]8;;\\u{7} \\u{1b}[2Jdone\\u{202e}",
			footer: expect.stringContaining(
				"Retry with a narrower task or do the work yourself. The partial answer is unverified.",
			),
		});
		expect(error).not.toMatch(/[\u001b\u0007\u202e]/u);
	});

	it("hands a task starting with - or @ to the child as its message, never as an argument", async () => {
		for (const task of ["- report the dash", "@src/a.ts report"]) {
			const facts = reportOf((await s.run({ task })).content[0].text as string);
			expect(facts.task.trim().startsWith(task)).toBe(true);
			expect(facts.args).not.toContain(task);
			expect(facts.args).not.toContain("--");
		}
	});

	it("keeps a long report short in context and saves it whole as a doc", async () => {
		const result = await s.run({ task: "long report" });
		const text = result.content[0].text as string;
		const file = path.join(fs.realpathSync(s.cwd), ".octa", "code", "temp", "agents", result.details.id, "report.md");
		const savedReport = fs.readFileSync(file, "utf8");
		const sha256 = createHash("sha256").update(savedReport).digest("hex");
		const version = path.join(path.dirname(file), `report-${sha256}.md`);
		expect(result.details.reportArtifact).toEqual({ sha256, path: version });
		expect(fs.readFileSync(version, "utf8")).toBe(savedReport);
		expect(fencedParts(text)?.body).toMatch(/^summary first\n/);
		expect(text).toContain("[Output trimmed:");
		expect(text).toContain(`Full report: ${version} (read only the parts you need).`);
		expect(Buffer.byteLength(text)).toBeLessThan(9 * 1024);
		expect(fs.readFileSync(file, "utf8")).toMatch(/the end$/);
		// A short report is not written to disk.
		const short = await s.run({ task: "report" });
		expect(fs.existsSync(path.join(s.cwd, ".octa", "code", "temp", "agents", short.details.id, "report.md"))).toBe(
			false,
		);
		expect(short.details.reportArtifact).toEqual({ sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
	});

	it("names why a profile was refused at load when the unknown profile is that one", async () => {
		refused.set(
			"blind",
			'Profile "blind" removes agent with excludeTools. Remove it from the profile\'s excludeTools.',
		);
		try {
			await expect(s.run({ task: "x", profile: "blind" })).rejects.toThrow(
				/Unknown profile "blind"\. Available: researcher, browser\n"blind" was refused when profiles loaded: Profile "blind" removes agent/,
			);
			// A name that was never a profile file gets no reason.
			await expect(s.run({ task: "x", profile: "nope" })).rejects.not.toThrow(/refused/);
		} finally {
			refused.clear();
		}
	});

	it("refuses unknown profiles and makes runs over the limit wait for a slot", async () => {
		await expect(s.run({ task: "x", profile: "nope" })).rejects.toThrow(
			/Unknown profile "nope". Available: researcher, browser/,
		);
		process.env[MAX_SUBAGENTS_ENV] = "1";
		try {
			const controller = new AbortController();
			const first = s.run({ task: "slow one" }, controller.signal);
			// The second waits, and its row says why; a third gives up its wait when its turn is aborted.
			const updates: Array<{ content: Array<{ text: string }>; details: { status: string } }> = [];
			const second = s.run({ task: "report" }, undefined, (update) => updates.push(update as never));
			const gaveUp = new AbortController();
			const third = s.run({ task: "report" }, gaveUp.signal);
			await vi.waitFor(() =>
				expect(updates[0]).toMatchObject({
					content: [{ text: "waiting for a slot (1 running)" }],
					details: { status: "waiting" },
				}),
			);
			const waiting = rendered(
				s.agent.renderResult(updates[0], { isPartial: true, expanded: false }, theme, {
					args: { task: "report" },
					isError: false,
				}),
			);
			expect(waiting).toContain("waiting for a slot (1 running)");
			gaveUp.abort();
			await expect(third).rejects.toThrow("Cancelled while waiting for a subagent slot.");
			controller.abort();
			await expect(first).rejects.toThrow("Subagent cancelled");
			// The slot the cancelled run gave back starts the waiting one.
			await expect(second).resolves.toMatchObject({ details: { status: "done" } });
		} finally {
			delete process.env[MAX_SUBAGENTS_ENV];
		}
		await expect(s.run({ task: "report" })).resolves.toMatchObject({ details: { status: "done" } });
	});

	it("lets a child whose step a team interrupt stopped continue with the message, not end as cancelled", async () => {
		const result = await s.run({ task: "interrupted" });
		expect(result.isError).toBeUndefined();
		expect(result.details).toMatchObject({ status: "done", outcome: "done" });
		expect(result.content[0].text).toContain("switched to the interrupt's request");
		expect(result.content[0].text).not.toContain("cancelled");
	});

	it("gives the slot and the name back when setup throws after the run is claimed", async () => {
		process.env[MAX_SUBAGENTS_ENV] = "1";
		const { events } = s.api;
		const registry = s.ctx.modelRegistry;
		// Within one 2 s window: a leaked slot makes the next run wait forever instead.
		const within = <T>(work: Promise<T>) =>
			Promise.race([
				work,
				new Promise<never>((_, reject) => setTimeout(() => reject(new Error("waited for a leaked slot")), 2_000)),
			]);
		try {
			// After claimRun: reading the session's added MCP servers fails.
			Object.assign(s.api, {
				events: {
					...events,
					emit: () => {
						throw new Error("event bus broke");
					},
				},
			});
			await expect(s.run({ task: "report" })).rejects.toThrow("event bus broke");
			expect(s.control.running()).toEqual([]);
			Object.assign(s.api, { events });
			// Inside claimRun, after the name is taken: the child model's cache policy cannot be read.
			Object.assign(s.ctx, {
				modelRegistry: {
					...registry,
					getCachePolicy: () => {
						throw new Error("settings broke");
					},
				},
			});
			await expect(s.run({ task: "report" })).rejects.toThrow("settings broke");
			expect(s.control.running()).toEqual([]);
			// The name it took is given back too, so it is not listed as running or avoided by later names.
			const runs = { api: s.api, team: s.team, running: new Map(), slots: new Slots() } as unknown as AgentRuns;
			const plan = { profile: undefined, route: { model: "faux/model" } };
			expect(() => claimRun(runs, plan, { goal: "g" }, s.ctx)).toThrow("settings broke");
			expect([...runs.running.keys()]).toEqual([]);
			Object.assign(s.ctx, { modelRegistry: registry });
			await expect(within(s.run({ task: "report" }))).resolves.toMatchObject({ details: { status: "done" } });
		} finally {
			Object.assign(s.api, { events });
			Object.assign(s.ctx, { modelRegistry: registry });
			delete process.env[MAX_SUBAGENTS_ENV];
		}
	});

	it("reports a background child that crashed while starting as failed (startup), with its cause in the details", async () => {
		await s.run({ task: "startup plain", background: true });
		await vi.waitFor(() => expect(s.sent.length).toBeGreaterThan(0), { timeout: 10_000 });
		const report = s.sent.at(-1)!.message;
		expect(report.content).toContain("Subagent failed (startup): exited with code 2 before its first model turn");
		expect(report.details).toMatchObject({
			outcome: "failed",
			startup: { failed: true, cause: "No API key for provider" },
		});
		expect(report.details).not.toHaveProperty("firstTurnTokens");
		s.sent.length = 0;
	});

	it("still tells the parent when building its background report throws twice", async () => {
		const add = vi.spyOn(ReportQueue.prototype, "add");
		add.mockImplementationOnce(() => {
			throw new Error("report path broke");
		});
		add.mockImplementationOnce(() => {
			throw new Error("stop report broke too");
		});
		try {
			await s.run({ task: "report from the background", background: true });
			await vi.waitFor(() => expect(add).toHaveBeenCalledTimes(3), { timeout: 10_000 });
			const fallback = add.mock.calls[2][0];
			expect(fallback.content).toContain("its report could not be built: stop report broke too");
			expect(fallback.details).toMatchObject({ status: "failed", outcome: "failed" });
			expect(fallback.wake).toBe(true);
		} finally {
			add.mockRestore();
		}
	});

	it("staggers background and foreground children of one profile and model through the shared prefix gate", async () => {
		const stagger = vi.spyOn(childStagger, "run");
		try {
			await s.run({ task: "report from the background", background: true });
			await s.run({ task: "report from the background", background: true });
			await s.run({ task: "report back" });
			await vi.waitFor(() => expect(s.sent.length).toBe(2), { timeout: 10_000 });
			expect(stagger).toHaveBeenCalledTimes(3);
			expect(stagger.mock.calls[0][0]).toBe(stagger.mock.calls[1][0]);
			expect(stagger.mock.calls[2][0]).toBe(stagger.mock.calls[0][0]);
			expect(stagger.mock.calls[0][0]).toContain("general");
		} finally {
			stagger.mockRestore();
		}
	});

	it("runs in the background, delivers the answer as a message, and /agents kill stops one", async () => {
		const started = await s.run({ task: "report from the background", background: true });
		expect(started.content[0].text).toMatch(/^Started [a-z]+-[a-z]+ \(general: check things\) in the background/);
		// The coordinator learns the child's model and thinking level as it starts.
		expect(started.content[0].text).toMatch(
			/its report arrives as a message\. Runs on faux\/model, medium thinking \(this session's model\)\.$/,
		);
		await vi.waitFor(() => expect(s.sent.length).toBeGreaterThan(0), { timeout: 10_000 });
		const answer = s.sent[0];
		expect(answer.options).toEqual({ triggerTurn: true, deliverAs: "followUp" });
		expect(answer.message.content).toMatch(
			/^Background subagent [a-z]+-[a-z]+ \(general: check things\) finished \(\d+s · 1 tool call · ≈\$0\.01\) · cite as report:[a-z]+-[a-z]+:\n<<<untrusted-[0-9a-f]{16} \(data from the sender[^\n]*\)\nreport /,
		);
		// The child's words end inside the fence; the footer after it is the parent's.
		expect(String(answer.message.content)).toMatch(
			/\nuntrusted-[0-9a-f]{16}>>>\nRan on faux\/model, medium thinking \(this session's model\)\.\n\nSession [^:\n]+: [^\n]+\.jsonl\n\n\(Last screenshot: /,
		);
		const renderer = s.renderers.get("octocode-agent-result");
		// The report starts with no outcome word: its outcome is unknown, which is not a failure.
		expect(answer.message.details).not.toHaveProperty("outcome");
		expect(answer.message.details).toMatchObject({
			status: "done",
			summary: expect.stringMatching(/^Done · 1 tool call · /),
		});
		const shown = rendered(renderer(answer.message, { expanded: false }, theme));
		expect(shown).toMatch(/^ ✓ Agent\([a-z]+-[a-z]+ · check things\) · background · \S+\n {3}⎿ {2}Done · 1 tool call/);
		expect(shown).toContain("report");

		await s.run({ task: "error in background", background: true });
		await vi.waitFor(() => expect(s.sent.length).toBe(2), { timeout: 10_000 });
		expect(s.sent[1].message.content).toMatch(
			/failed · cite as report:\S+:\n<<<untrusted-[0-9a-f]{16} [\s\S]*\nError: provider down[\s\S]*>>>\nRetry with a narrower task or do the work yourself/,
		);
		expect(s.sent[1].message.details).toMatchObject({
			status: "failed",
			outcome: "failed",
			summary: "Failed: provider down",
		});
		expect(rendered(renderer(s.sent[1].message, { expanded: false }, theme))).toMatch(
			/^ ✗ Agent\([a-z]+-[a-z]+[^\n]*\n {3}⎿ {2}Failed: provider down/,
		);

		const kill = {
			handler: (args: string, ctx: unknown) => s.commands.get("agents").handler(`kill ${args}`, ctx),
			getArgumentCompletions: (prefix: string) => s.commands.get("agents").getArgumentCompletions(`kill ${prefix}`),
		};
		await kill.handler("", s.ctx);
		expect(s.ctx.ui.notes.at(-1)).toEqual({ message: "Usage: /agents kill <id>. None is running.", type: "warning" });
		const slow = await s.run({ task: "slow background", background: true });
		const id = slow.details.id as string;
		expect(await kill.getArgumentCompletions(id.slice(0, 3))).toEqual([
			expect.objectContaining({ value: `kill ${id}`, label: id }),
		]);
		await kill.handler("ghost", s.ctx);
		expect(s.ctx.ui.notes.at(-1)!.message).toBe(`No running subagent "ghost". Running: ${id}`);
		// settle() resolves once every background subagent has reported (index.ts holds a headless run on it).
		let settled = false;
		const waiting = s.control.settle().then(() => {
			settled = true;
			return settled;
		});
		// No fixed sleep: flush pending callbacks; settle cannot resolve before the kill below.
		await new Promise((resolve) => setImmediate(resolve));
		expect(settled).toBe(false);
		await kill.handler(id, s.ctx);
		expect(s.ctx.ui.notes.at(-1)).toEqual({ message: `Stopping ${id}…`, type: "info" });
		await waiting;
		await vi.waitFor(() => expect(s.sent.length).toBe(3), { timeout: 10_000 });
		expect(s.sent[2].message.content).toBe(`Background subagent ${id} (general: check things) cancelled by the user`);
		// A stop the user asked for is an interruption, not a failure; the prompt is one expand away.
		expect(rendered(renderer(s.sent[2].message, { expanded: false }, theme))).toMatch(
			/^ ◼ Agent.*\n {3}⎿ {2}Cancelled by the user\n {6}… prompt \(ctrl\+o to expand\)$/,
		);
		expect(s.sent[2].options).toEqual({ triggerTurn: false, deliverAs: "followUp" });
	});

	it("lets the parent agent stop only the background subagents it started, with coordinate stop", async () => {
		registerCollab(s.api, s.team, { stopAgent: (id, by) => s.control.stop(id, by) });
		const coordinate = s.tools.get("coordinate");
		const stop = (id?: string) =>
			coordinate.execute("c1", { action: "stop", ...(id ? { id } : {}) }, undefined, undefined, s.ctx);
		await expect(stop("ghost")).rejects.toThrow('No background subagent "ghost". None is running.');
		const slow = await s.run({ task: "slow background", background: true });
		const id = slow.details.id as string;
		expect((await stop(id)).content[0].text).toBe(
			`Stopping ${id}: its process tree is killed and its report arrives as a message.`,
		);
		await vi.waitFor(
			() =>
				expect(s.sent.at(-1)?.message.content).toBe(
					`Background subagent ${id} (general: check things) stopped by ${s.team.id}`,
				),
			{ timeout: 10_000 },
		);
		// The parent asked for the stop: the report is queued without waking it for another turn.
		expect(s.sent.at(-1)!.options).toEqual({ triggerTurn: false, deliverAs: "followUp" });
		await expect(stop(id)).rejects.toThrow(/No background subagent/);
		// A subagent has no children to stop: `stop` is not offered to it at all (a stray call is still refused).
		const child = fakeHost();
		registerCollab(child.api, new Team(child.api));
		const childTool = child.tools.get("coordinate");
		expect(childTool.parameters.properties.action.enum).not.toContain("stop");
		expect(childTool.parameters.properties.id).toBeUndefined();
		expect(childTool.description).not.toContain("`stop`");
		await expect(childTool.execute("c2", { action: "stop", id }, undefined, undefined, s.ctx)).rejects.toThrow(
			/Only the agent that started a subagent can stop it/,
		);
	});

	it("stops background runs at session shutdown and waits for them to file their reports", async () => {
		const slow = await s.run({ task: "slow at shutdown", background: true });
		await s.emit("session_shutdown", {}, s.ctx);
		// Shutdown returns only after the stopped child exited and its report was filed.
		expect(s.sent.at(-1)?.message.content).toBe(
			`Background subagent ${slow.details.id} (general: check things) stopped by session shutdown`,
		);
		expect(s.sent.at(-1)!.options.triggerTurn).toBe(false);
	});

	/** The background reports sent to the parent (its team mail, the child's questions, is sent too). */
	const reports = () => s.sent.filter((entry) => entry.message.customType === "octocode-agent-result");

	/** Acts as the gated child's team: joins it, asks its parent twice (one FYI too), and returns the store to answer with. */
	async function askAsChild(id: string) {
		const store = TeamStore.open(s.cwd, process.env.OCTOCODE_AGENT_DB);
		const parentId = s.team.id!;
		store.save({
			id,
			role: "general",
			parentId,
			pid: process.pid,
			status: "working",
			joinedAt: Date.now(),
			updatedAt: Date.now(),
			toolCalls: 0,
			input: 0,
			cacheRead: 0,
			output: 0,
			cost: 0,
			unpriced: false,
		});
		const first = store.send(id, [parentId], "Which database should the migration target?", {
			replyRequired: true,
		}).id!;
		store.send(id, [parentId], "FYI: tests are slow", { replyRequired: false });
		const second = store.send(id, [parentId], "Rename the column too?", { replyRequired: true }).id!;
		return { store, parentId, first, second };
	}

	it("records a child's questions to its parent in the run details, the report footer and /agents", async () => {
		const gate = path.join(tmp(), "gate");
		process.env.OCTOCODE_FAKE_GATE = gate;
		const started = await s.run({ task: "gated background", background: true });
		const id = started.details.id as string;
		const { store, parentId, first, second } = await askAsChild(id);
		try {
			await vi.waitFor(() => expect(store.asks(id, parentId, 0)).toHaveLength(2));
			// The parent answers the first question; the second stays open. /agents shows the live count.
			store.send(parentId, [id], "Postgres", { replyRequired: false, replyTo: first });
			await s.commands.get("agents").handler("", s.ctx);
			expect(s.ctx.ui.notes.at(-1)!.message).toMatch(/\n {2}2 asks \(1 answered in \d+s, 1 unanswered\) to its parent/);
			fs.writeFileSync(gate, "");
			await vi.waitFor(() => expect(reports()).toHaveLength(1), { timeout: 10_000 });
		} finally {
			store.close();
			delete process.env.OCTOCODE_FAKE_GATE;
		}
		const { message } = reports()[0];
		expect(String(message.content)).toMatch(/\nAsks to its parent: 2 asks \(1 answered in \d+s, 1 unanswered\)\./);
		// An unanswered ask keeps the child resumable, and the report says it waits for a reply.
		expect(String(message.content)).toMatch(/is waiting for your reply to its question and stays resumable for 600 s/);
		expect(message.details.asks).toEqual([
			{
				id: first,
				text: "Which database should the migration target?",
				askedAt: expect.any(Number),
				answer: { id: expect.any(Number), at: expect.any(Number), by: parentId },
			},
			{ id: second, text: "Rename the column too?", askedAt: expect.any(Number) },
		]);
		expect(message.details.asks[0].answer.at).toBeGreaterThanOrEqual(message.details.asks[0].askedAt);
	});

	it("returns a foreground run's asks in its details and marks an answer that followed an askUser call", async () => {
		const gate = path.join(tmp(), "gate");
		process.env.OCTOCODE_FAKE_GATE = gate;
		let id: string | undefined;
		const running = s.run({ task: "gated foreground" }, undefined, (update) => {
			id ||= (update as { details: { id: string } }).details.id;
			return id;
		});
		try {
			await vi.waitFor(() => expect(id).toBeTruthy());
			const { store, parentId, first } = await askAsChild(id!);
			try {
				// The parent asks the user, then answers: the answer is marked.
				await s.emit("tool_execution_start", { toolCallId: "ask-1", toolName: "askUser" }, s.ctx);
				await s.emit("tool_execution_end", { toolCallId: "ask-1", toolName: "askUser" }, s.ctx);
				store.send(parentId, [id!], "Postgres, the user said", { replyRequired: false, replyTo: first });
			} finally {
				store.close();
			}
			fs.writeFileSync(gate, "");
			const result = await running;
			expect(
				result.details.asks.map((ask: { id: number; answer?: { afterAskUser?: boolean } }) => [
					ask.id,
					ask.answer?.afterAskUser,
				]),
			).toEqual([
				[first, true],
				[first + 2, undefined],
			]);
			expect(result.content[0].text).toMatch(
				/\nAsks to its parent: 2 asks \(1 answered in \d+s \(1 after askUser\), 1 unanswered\)\./,
			);
		} finally {
			fs.writeFileSync(gate, "");
			delete process.env.OCTOCODE_FAKE_GATE;
		}
	});

	it("omits asks from a run that asked nothing", async () => {
		const result = await s.run({ task: "report quickly" });
		expect(result.details).not.toHaveProperty("asks");
		expect(result.content[0].text).not.toContain("Asks to its parent");
	});

	it("tells parallel collaborating subagents about each other", async () => {
		const first = await s.run({
			task: "slow collaborator",
			goal: "slow collaborator",
			background: true,
			collaborate: true,
		});
		const second = await s.run({ task: "report as collaborator", collaborate: true });
		const facts = reportOf(second.content[0].text);
		expect(facts.task).toContain("## Teammates");
		expect(facts.task).toContain(`\`${first.details.id}\`: general: slow collaborator`);
		await s.commands.get("agents").handler(`kill ${first.details.id}`, s.ctx);
		await vi.waitFor(() => expect(s.sent.at(-1)?.message.content).toContain("cancelled by the user"), {
			timeout: 10_000,
		});
	});
});

describe("isolated subagents and /agents merge", () => {
	it("requires isolation for a working-copy snapshot and leaves a dirty parent untouched", async () => {
		const dir = repo();
		const s = setup(dir);
		await expect(s.run({ task: "report quickly", workingCopy: true })).rejects.toThrow(
			"workingCopy requires isolate: true",
		);
		fs.writeFileSync(path.join(dir, "parent.txt"), "dirty parent\n");
		const result = await s.run({ task: "edit a file", isolate: true, workingCopy: true });
		const id = result.details.id as string;
		expect(result.content[0].text).toContain(`/agents merge ${id}`);
		expect(fs.readFileSync(path.join(dir, "parent.txt"), "utf8")).toBe("dirty parent\n");
		expect(fs.existsSync(path.join(dir, "child.txt"))).toBe(false);
		expect(git(dir, "diff", "--name-only", "HEAD", `refs/octocode/${id}`)).toBe("child.txt");
	}, 30_000);

	it("lands the child's edits on its ref and merges them with /agents merge", async () => {
		const dir = repo();
		const s = setup(dir);
		const merge = { handler: (args: string, ctx: unknown) => s.commands.get("agents").handler(`merge ${args}`, ctx) };
		await merge.handler("", s.ctx);
		expect(s.ctx.ui.notes.at(-1)).toEqual({
			message: "Usage: /agents merge <id>. No isolated results to merge.",
			type: "warning",
		});

		const result = await s.run({ task: "edit a file", isolate: true });
		const id = result.details.id as string;
		expect(result.content[0].text).toContain(`/agents merge ${id}`);
		expect(fs.existsSync(path.join(dir, "child.txt"))).toBe(false);
		await merge.handler("", s.ctx);
		expect(s.ctx.ui.notes.at(-1)!.message).toBe(`Usage: /agents merge <id>. Unmerged: ${id}`);

		await merge.handler(id, s.ctx);
		expect(s.ctx.ui.notes.at(-1)!.type).toBe("info");
		expect(fs.readFileSync(path.join(dir, "child.txt"), "utf8")).toBe("from the child\n");
		await merge.handler("bad id!", s.ctx);
		expect(s.ctx.ui.notes.at(-1)!.type).toBe("error");

		// Background isolated runs report the outcome in their message: child.txt is already merged, so nothing changed.
		await s.run({ task: "edit in background", isolate: true, background: true });
		await vi.waitFor(() => expect(s.sent.at(-1)?.message.content).toMatch(/finished[\s\S]*changed no files/), {
			timeout: 15_000,
		});
		await expect(s.run({ task: "fail isolated", isolate: true })).rejects.toThrow(
			/Subagent failed \(startup\): exited with code 3/,
		);
		await s.emit("session_start", {}, s.ctx);
	}, 60_000);

	describe("leaves no worktree behind on a cancel path", () => {
		/** What the repository's isolated-worktree folder holds: an owner record and a folder per live worktree. */
		const leftovers = (dir: string): string[] => {
			const folder = worktreesDir(dir);
			return fs.existsSync(folder) ? fs.readdirSync(folder) : [];
		};

		it("removes the worktree of a foreground run the user stops mid-run", async () => {
			const dir = repo();
			const s = setup(dir);
			const controller = new AbortController();
			const updates: Array<{ details: { toolCalls: number } }> = [];
			const running = s.run({ task: "slow isolated", isolate: true }, controller.signal, (update) =>
				updates.push(update as never),
			);
			// The child is running its command, so the abort stops a live process rather than the launch.
			await vi.waitFor(() => expect(updates.some((update) => update.details.toolCalls > 0)).toBe(true), {
				timeout: 10_000,
			});
			expect(leftovers(dir).length).toBeGreaterThan(0);
			controller.abort();
			await expect(running).rejects.toThrow(/Subagent cancelled/);
			expect(leftovers(dir)).toEqual([]);
			expect(git(dir, "worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(1);
		}, 30_000);

		it("removes the worktree when the turn is already aborted at launch", async () => {
			const dir = repo();
			const s = setup(dir);
			const controller = new AbortController();
			controller.abort();
			await expect(s.run({ task: "slow isolated", isolate: true }, controller.signal)).rejects.toThrow();
			expect(leftovers(dir)).toEqual([]);
			expect(git(dir, "worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(1);
		}, 30_000);

		it("removes the worktree of a background run that /agents kill stops", async () => {
			const dir = repo();
			const s = setup(dir);
			const started = await s.run({ task: "slow isolated", isolate: true, background: true });
			const id = started.details.id as string;
			await vi.waitFor(() => expect(leftovers(dir).length).toBeGreaterThan(0), { timeout: 10_000 });
			await s.commands.get("agents").handler(`kill ${id}`, s.ctx);
			await vi.waitFor(() => expect(s.sent.at(-1)?.message.content).toContain("cancelled by the user"), {
				timeout: 10_000,
			});
			expect(s.sent.at(-1)?.message.content).toContain(`Isolated run ${id} changed no files.`);
			expect(leftovers(dir)).toEqual([]);
		}, 30_000);
	});
});

describe("isolated subagents share the leading prompt", () => {
	it("passes the main checkout as the prompt root and names the worktree in the task", async () => {
		const dir = repo();
		const s = setup(dir);
		const a = reportOf((await s.run({ task: "report one", isolate: true })).content[0].text);
		const b = reportOf((await s.run({ task: "report two", isolate: true })).content[0].text);
		// The real cwd (tools, permissions) is each worktree; only the prompt text names the main checkout.
		expect(a.cwd).not.toBe(b.cwd);
		// The child's cwd is the resolved path of its worktree (a symlinked temp directory differs in its prefix).
		expect(a.cwd.endsWith(a.worktreeRoot)).toBe(true);
		expect(a.worktreeRoot).not.toBe(dir);
		expect(a.promptRoot).toBe(dir);
		expect(b.promptRoot).toBe(dir);
		expect(a.task).toContain("## Worktree");
		expect(a.task).toContain(`worktree \`${a.worktreeRoot}\``);
		expect(a.task).toContain(`main checkout \`${dir}\``);
		const plain = reportOf((await s.run({ task: "report plain" })).content[0].text);
		expect(plain.promptRoot).toBeUndefined();
		expect(plain.task).not.toContain("## Worktree");
	}, 30_000);
});

describe("trust for isolated subagents", () => {
	it("never hands trust down by environment, and a session nobody can ask creates no worktree", async () => {
		const trusted = repo();
		const s = setup(trusted);
		const facts = reportOf((await s.run({ task: "report", isolate: true })).content[0].text);
		expect(facts).toMatchObject({ workspace: trusted });

		const undecided = repo();
		fs.mkdirSync(path.join(undecided, ".claude"));
		fs.writeFileSync(
			path.join(undecided, ".claude", "settings.json"),
			'{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"node"}]}]}}',
		);
		git(undecided, "add", "-A");
		git(undecided, "commit", "-q", "-m", "hooks");
		const u = setup(undecided);
		const child = reportOf((await u.run({ task: "report", isolate: true })).content[0].text);
		expect(child).toMatchObject({ workspace: undecided });

		// No UI to ask and no `--trust`: the worktree is refused before it is created.
		const headless = setup(repo(), false);
		await expect(headless.run({ task: "report", isolate: true })).rejects.toThrow(/--trust/u);
	}, 30_000);
});

describe("orphaned worktrees at session start", () => {
	it("saves what it can under the actual ref name and warns about a worktree it had to keep", async () => {
		const dir = repo();
		const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
		git(dir, "update-ref", "refs/octocode/orphan-7", "HEAD");
		const dead = spawnSync(process.execPath, ["-e", "0"]).pid;
		const yes = async () => true;
		const [saved, stuck] = [
			await createWorktree(dir, "orphan-7", undefined, false, undefined, yes),
			await createWorktree(dir, "stuck-7", undefined, false, undefined, yes),
		];
		for (const worktree of [saved, stuck]) {
			fs.writeFileSync(path.join(worktree.path, `${worktree.agentId}.txt`), "work\n");
			const meta = `${worktree.path}.json`;
			fs.writeFileSync(meta, JSON.stringify({ ...JSON.parse(fs.readFileSync(meta, "utf8")), owners: [{ pid: dead }] }));
		}
		fs.writeFileSync(path.join(git(stuck.path, "rev-parse", "--absolute-git-dir"), "index.lock"), "");
		const s = setup(dir);
		await s.emit("session_start", {}, s.ctx);
		await vi.waitFor(() => expect(s.ctx.ui.notes.some((note) => note.type === "warning")).toBe(true), {
			timeout: 10_000,
		});
		const note = s.ctx.ui.notes.find((entry) => entry.type === "warning")!.message;
		expect(note).toContain("orphan-7 (changes on refs/octocode/orphan-7-2)");
		expect(note).toContain(`Kept orphaned subagent worktree stuck-7`);
		expect(note).toContain(stuck.path);
		expect(fs.existsSync(path.join(stuck.path, "stuck-7.txt"))).toBe(true);
	}, 30_000);
});

describe("runSubagent", () => {
	it.skipIf(process.platform === "win32")(
		"settles a cancelled run only once its tree is gone, including a detached helper the child left running",
		async () => {
			const controller = new AbortController();
			let helper = 0;
			const run = runSubagent(
				"detached helper",
				[],
				tmp(),
				undefined,
				{ id: "a-helper" },
				controller.signal,
				({ activity }) => {
					const pid = Number(
						/"helper":(\d+)/.exec(activity ?? "")?.[1] ?? /helper[^\d]*(\d+)/.exec(activity ?? "")?.[1],
					);
					if (pid) helper = pid;
				},
			);
			await vi.waitFor(() => expect(helper).toBeGreaterThan(0), { timeout: 10_000 });
			try {
				controller.abort();
				await expect(run).rejects.toThrow("Subagent cancelled");
				expect(processAlive(helper)).toBe(false);
			} finally {
				try {
					process.kill(helper, "SIGKILL");
				} catch {
					/* Already exited. */
				}
			}
		},
		20_000,
	);

	describe.skipIf(process.platform === "win32")("after a natural exit", () => {
		// A stand-in `octocode` that answers, leaves a holder in its own process group (like an MCP or dev server) and exits.
		const withScript = async (body: string, run: (holderFile: string) => Promise<void>) => {
			const dir = tmp();
			const holderFile = path.join(dir, "holder.pid");
			const script = path.join(dir, "octocode");
			fs.writeFileSync(script, `const { spawn } = require('node:child_process');\n${body}`);
			const before = process.argv[1];
			process.argv[1] = script;
			process.env.TEST_HOLDER_FILE = holderFile;
			try {
				await run(holderFile);
			} finally {
				process.argv[1] = before!;
				delete process.env.TEST_HOLDER_FILE;
				try {
					process.kill(Number(fs.readFileSync(holderFile, "utf8")), "SIGKILL");
				} catch {
					/* Gone, or never started. */
				}
			}
		};
		const holder = `
      const holder = spawn(process.execPath, ['-e', 'setInterval(() => undefined, 1000)'], { stdio: 'ignore' });
      holder.unref();
      require('node:fs').writeFileSync(process.env.TEST_HOLDER_FILE, String(holder.pid));
      const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } };
      process.stdout.write(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'DONE' }], usage, stopReason: 'stop' } }) + '\\n');
    `;

		it("stops what the child left in its process group before the run settles", async () => {
			await withScript(holder, async (holderFile) => {
				const outcome = await runSubagent("go", [], tmp(), undefined, { id: "a-holder" }, undefined, () => undefined);
				expect(outcome.text).toBe("DONE");
				// The run has settled: the holder it left behind is already gone, so a worktree removal now races nothing.
				expect(processAlive(Number(fs.readFileSync(holderFile, "utf8")))).toBe(false);
			});
		}, 20_000);
	});

	it("terminates the child when recording its launch fails", async () => {
		let pid = 0;
		await expect(
			runSubagent(
				"slow launch",
				[],
				tmp(),
				undefined,
				{ id: "a-launch-failure" },
				undefined,
				() => undefined,
				(childPid) => {
					pid = childPid;
					throw new Error("cannot record launch");
				},
			),
		).rejects.toThrow("cannot record launch");
		try {
			expect(() => process.kill(pid, 0)).toThrow();
		} finally {
			try {
				process.kill(pid, "SIGKILL");
			} catch {
				/* Already exited. */
			}
		}
	});

	it("rejects oversized unterminated events instead of buffering them without limit", async () => {
		await expect(
			runSubagent("oversized", [], tmp(), undefined, { id: "a-oversized" }, undefined, () => undefined),
		).rejects.toThrow(/JSON event exceeds/);
	});

	it("bounds the returned report while preserving the complete text in scratch", async () => {
		const scratch = tmp();
		const outcome = await runSubagent(
			"long report",
			[],
			tmp(),
			undefined,
			{ id: "a-bounded", scratch },
			undefined,
			() => undefined,
		);
		expect(Buffer.byteLength(outcome.text)).toBeLessThan(9 * 1024);
		expect(outcome.text).toContain("Full report:");
		expect(fs.readFileSync(path.join(scratch, "report.md"), "utf8")).toMatch(/the end$/);
	});

	it("keeps the pointer to the saved partial report in a crash error, however long the narration was", async () => {
		const scratch = tmp();
		const error = await runSubagent(
			"long narrate then crash",
			[],
			tmp(),
			undefined,
			{ id: "a-crash", scratch },
			undefined,
			() => undefined,
		).then(
			() => undefined,
			(e: Error) => e,
		);
		expect(error?.message).toMatch(
			/^Subagent exited with code 3: segfault\nLast progress: progress detail .*\n\[Output trimmed: [^\]]+\]\nFull partial report: .*partial-report\.md/s,
		);
		expect(fs.readFileSync(path.join(scratch, "partial-report.md"), "utf8")).toMatch(/the end$/);
	});

	it("streams the gist of its thinking and keeps thoughts and narration as steps", async () => {
		const seen: Array<{ step?: string; thinking?: string; activity?: string }> = [];
		const outcome = await runSubagent(
			"think aloud",
			[],
			tmp(),
			undefined,
			{ id: "a-think" },
			undefined,
			({ step, thinking, activity }) =>
				seen.push({
					...(step ? { step } : {}),
					...(thinking !== undefined ? { thinking } : {}),
					...(activity ? { activity } : {}),
				}),
		);
		expect(outcome.text).toBe("THE ANSWER");
		expect(seen.filter((update) => Object.keys(update).length > 0)).toEqual([
			{ thinking: "Locating the bug" },
			{ thinking: "The token refresh runs twice." },
			{ step: "✻ Check the lock" },
			{ step: "› Let me read src/auth.ts" },
			{ thinking: "" },
			{ activity: "→ read src/auth.ts" },
			{ thinking: "" },
		]);
	});

	it("rejects at once when already aborted", async () => {
		const controller = new AbortController();
		controller.abort();
		await expect(
			runSubagent("x", [], tmp(), undefined, { id: "a-0000" }, controller.signal, () => undefined),
		).rejects.toThrow("Subagent cancelled");
	});

	it("reports the child pid and parses a final line without a newline", async () => {
		const pids: number[] = [];
		const outcome = await runSubagent(
			"report",
			[],
			tmp(),
			undefined,
			{ id: "a-0001", goal: "t", workspace: "/w" },
			undefined,
			() => undefined,
			(pid) => pids.push(pid),
		);
		expect(pids).toHaveLength(1);
		expect(reportOf(outcome.text).id).toBe("a-0001");
		expect(outcome.usage.input).toBe(100);
	});

	it("propagates the latest outcome to foreground and background results", async () => {
		const s = setup();
		const foreground = await s.run({ task: "changed outcome" });
		expect(foreground.details.outcome).toBe("blocked");
		expect(foreground.details.reportArtifact).toEqual({ sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
		expect(foreground.content[0].text).toMatch(/^Subagent (\S+) reported blocked · cite as report:\1:/);
		await s.run({ task: "changed outcome", background: true });
		await vi.waitFor(() => expect(s.sent).toHaveLength(1), { timeout: 10_000 });
		expect(s.sent[0].message.details.outcome).toBe("blocked");
		expect(s.sent[0].message.details.reportArtifact).toEqual(foreground.details.reportArtifact);
		expect(s.sent[0].message.content).toContain("reported blocked");
	});

	it("keeps the report when a late notice wakes the child after it answered", async () => {
		const outcome = await runSubagent(
			"late notice",
			[],
			tmp(),
			undefined,
			{ id: "a-0003" },
			undefined,
			() => undefined,
		);
		expect(outcome.text).toBe("FULL REPORT\n\n---\n\nThat job was my coverage rerun; findings unchanged.");
		expect(outcome.error).toBeUndefined();
	});

	it("propagates a failed follow-up while preserving the prior report", async () => {
		const outcome = await runSubagent(
			"late failure",
			[],
			tmp(),
			undefined,
			{ id: "a-0004" },
			undefined,
			() => undefined,
		);
		expect(outcome.text).toBe("FULL REPORT\n\n---\n\n(A later follow-up turn failed: overloaded)");
		expect(outcome.error).toBe("overloaded");
	});

	it("never keeps a failed draft as a report section", async () => {
		const outcome = await runSubagent(
			"steered draft",
			[],
			tmp(),
			undefined,
			{ id: "a-0005" },
			undefined,
			() => undefined,
		);
		expect(outcome.text).toBe("FINAL REPORT");
		expect(outcome.error).toBeUndefined();
	});

	it.skipIf(process.platform === "win32")(
		"settles shortly after the child exits even when an escaped grandchild holds its pipes open",
		async () => {
			const started = Date.now();
			const outcome = await runSubagent(
				"orphan holder",
				[],
				tmp(),
				undefined,
				{ id: "a-orphan" },
				undefined,
				() => undefined,
			);
			expect(outcome.text).toBe("ORPHAN REPORT");
			expect(Date.now() - started).toBeLessThan(5_000);
		},
		15_000,
	);

	it("keeps running when the progress callback throws", async () => {
		const outcome = await runSubagent("report", [], tmp(), undefined, { id: "a-0002" }, undefined, () => {
			throw new Error("render gone");
		});
		expect(reportOf(outcome.text).id).toBe("a-0002");
	});
});

describe("subagent watchdog and exits", () => {
	/**
	 * Starts `task`, waits until the child shows it is busy (its first progress), lets `ms` pass on a fake clock for the
	 * watchdog (its interval and `Date`; the child and its pipes stay real), then aborts and returns how the run ended.
	 * A watchdog stop rejects with "Subagent stopped", so the outcome says whether it fired before the abort.
	 */
	const runThenAbort = async (task: string, id: string, ms: number, limits: { idleMs: number; busyMs: number }) => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
		try {
			const controller = new AbortController();
			let busy!: () => void;
			const started = new Promise<void>((resolve) => {
				busy = resolve;
				return undefined;
			});
			const run = runSubagent(task, [], tmp(), undefined, { id }, controller.signal, () => busy(), undefined, limits);
			const outcome = Promise.allSettled([run]);
			await started;
			await vi.advanceTimersByTimeAsync(ms);
			vi.useRealTimers();
			controller.abort();
			return (await outcome)[0];
		} finally {
			vi.useRealTimers();
		}
	};

	it("treats a child settling after its answer as busy: no watchdog stop, and the answer stays", async () => {
		// Four idle limits pass while it settles. The answer was complete before the abort: it is kept, and says the run did not settle.
		expect(
			await runThenAbort("answer then stalled shutdown", "a-shutdown", 1_200, { idleMs: 300, busyMs: 60_000 }),
		).toMatchObject({
			status: "fulfilled",
			value: { text: "COMPLETED REPORT", error: "Subagent cancelled before its run settled" },
		});
	});

	it("kills a child that emits nothing for the idle limit and says what it last did", async () => {
		await expect(
			runSubagent("hang", [], tmp(), undefined, { id: "a-hang" }, undefined, () => undefined, undefined, {
				idleMs: 300,
				busyMs: 60_000,
			}),
		).rejects.toThrow(
			/^Subagent stopped: no output for .*; last activity: started, .* ago\. Its process tree was killed\.$/,
		);
	});

	it("never stops a child for a silent running tool (the tool has its own deadline) nor for its run time", async () => {
		expect(await runThenAbort("slow tool", "a-slow", 1_500, { idleMs: 300, busyMs: 60_000 })).toMatchObject({
			status: "rejected",
			reason: { message: "Subagent cancelled" },
		});
	});

	it("stops a busy child once a call runs past its own deadline (busyMs when it declares none)", async () => {
		// On the watchdog's fake clock, like runThenAbort: the idle limit counts from spawn, so on a real clock a child that
		// takes longer than `idleMs` to start (a loaded machine) is stopped as idle before its tool call is ever seen.
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
		try {
			let busy!: () => void;
			const started = new Promise<void>((resolve) => {
				busy = resolve;
				return undefined;
			});
			const run = runSubagent(
				"slow tool",
				[],
				tmp(),
				undefined,
				{ id: "a-slow-hung" },
				undefined,
				() => busy(),
				undefined,
				{ idleMs: 200, busyMs: 200 },
			);
			const outcome = Promise.allSettled([run]);
			await started;
			await vi.advanceTimersByTimeAsync(1_000); // past the call's deadline (busyMs + idleMs) and a watchdog tick
			vi.useRealTimers();
			const settled = (await outcome)[0];
			expect(settled.status).toBe("rejected");
			expect((settled as PromiseRejectedResult).reason.message).toMatch(
				/^Subagent stopped: → bash sleep 60 ran past its own deadline; last output .* ago\. Its process tree was killed\.$/,
			);
		} finally {
			vi.useRealTimers();
		}
	});

	it.skipIf(process.platform === "win32")(
		"gives a stop the user asked for a short grace: a child ignoring SIGTERM is killed in about a second",
		async () => {
			const controller = new AbortController();
			let ignoring!: () => void;
			const ignores = new Promise<void>((resolve) => {
				ignoring = resolve;
				return undefined;
			});
			const run = runSubagent("stubborn", [], tmp(), undefined, { id: "a-stubborn" }, controller.signal, () =>
				ignoring(),
			);
			// The child reported that it ignores SIGTERM: only now is a stop a test of the grace.
			await ignores;
			const started = Date.now();
			controller.abort(USER_STOP);
			await expect(run).rejects.toThrow("Subagent cancelled");
			expect(Date.now() - started).toBeLessThan(3_000);
		},
		10_000,
	);

	it('names the signal that killed a child instead of "code null"', () => {
		expect(exitReason(null, "SIGTERM")).toBe("was killed by SIGTERM");
		expect(exitReason(3, null)).toBe("exited with code 3");
	});

	it("lets /agents kill stop a foreground run without aborting the turn", async () => {
		const s = setup();
		const running = s.run({ task: "slow foreground" });
		let id = "";
		await vi.waitFor(
			async () => {
				await s.commands.get("agents").handler("kill", s.ctx);
				id = /Running: (\S+)/.exec(s.ctx.ui.notes.at(-1)!.message)?.[1] ?? "";
				expect(id).not.toBe("");
			},
			{ timeout: 5_000 },
		);
		await s.commands.get("agents").handler(`kill ${id}`, s.ctx);
		await expect(running).rejects.toThrow(`Subagent ${id} was stopped by the user.`);
	}, 15_000);
});

describe("background report delivery", () => {
	it("batches reports so only the last of a batch may start a turn", () => {
		const f = fakeHost();
		const queue = new ReportQueue(f.api, 60_000);
		const report = (id: string, wake: boolean) => ({
			content: id,
			details: { id, status: "done" as const, summary: "Done" },
			wake,
		});
		queue.add(report("a", true));
		queue.add(report("b", false));
		queue.add(report("c", false));
		expect(f.sent).toHaveLength(0);
		queue.flush();
		expect(f.sent.map((entry) => [entry.message.content, entry.options.triggerTurn])).toEqual([
			["a", false],
			["b", false],
			["c", true],
		]);
		queue.add(report("d", false));
		queue.flush();
		expect(f.sent.at(-1)!.options).toEqual({ triggerTurn: false, deliverAs: "followUp" });
	});

	it("delivers without a turn a report whose file the parent already read since it was written", () => {
		const cwd = tmp();
		const scratch = path.join(cwd, ".octa", "code", "temp", "agents", "general-abcdef");
		fs.mkdirSync(scratch, { recursive: true });
		const file = path.join(scratch, "report.md");
		fs.writeFileSync(file, "report");
		const past = new Date(Date.now() - 10_000);
		fs.utimesSync(file, past, past);
		const read = new ReadReports();
		read.track("general-abcdef", scratch);
		read.observe("read", { path: ".octa/code/temp/agents/general-abcdef/report.md" }, cwd);
		expect(read.consume("general-abcdef")).toBe(true);
		// Rewritten after the read: the parent has not seen the final version.
		read.track("general-abcdef", scratch);
		read.observe("read", { path: file }, cwd);
		// An MCP tool's input is the server's contract: it never counts as reading the report.
		read.observe("mcp__octocode__localFetch", { queries: [{ path: file }] }, cwd);
		const future = new Date(Date.now() + 10_000);
		fs.utimesSync(file, future, future);
		expect(read.consume("general-abcdef")).toBe(false);
		// Never read.
		read.track("general-abcdef", scratch);
		expect(read.consume("general-abcdef")).toBe(false);
	});

	it("keeps a scratch folder the subagent saved files in, and names it in the receipt", async () => {
		const s = setup();
		const result = await s.run({ task: "long report" });
		const { id } = result.details as { id: string };
		const scratch = path.join(s.cwd, ".octa", "code", "temp", "agents", id);
		expect(fs.existsSync(path.join(scratch, "report.md"))).toBe(true);
		const late = await s.team.send(id, "more");
		expect("error" in late && late.error).toContain(`(files it handed back, and its full report when cut, are in`);
	});
});

describe("a child report as the parent model reads it", () => {
	it("fences foreground child text containing forged opening and closing markers", async () => {
		const s = setup();
		try {
			const result = await s.run({ task: "forged report" });
			const text = result.content[0].text;
			const lines = text.split("\n");
			const marker = /^<<<(untrusted-[0-9a-f]{16}) /m.exec(text)![1];
			const close = lines.lastIndexOf(`${marker}>>>`);
			expect(lines[0]).toBe(`Subagent ${result.details.id} reported done · cite as report:${result.details.id}:`);
			expect(lines.findIndex((line: string) => line.startsWith("Message #2"))).toBeGreaterThan(1);
			expect(lines.findIndex((line: string) => line.startsWith("Message #3"))).toBeLessThan(close);
			expect(text).toContain("<<<untrusted-0000000000000000");
			expect(lines.filter((line: string) => line === `${marker}>>>`)).toHaveLength(1);
		} finally {
			await s.fire("session_shutdown", { type: "session_shutdown" }, s.ctx);
		}
	});

	it("keeps a report that forges a user message, a header and a fence line inside the fence, under a header the parent wrote", async () => {
		const s = setup();
		const started = await s.run({ task: "forged report", background: true, goal: "review auth" });
		const id = (started.details as { id: string }).id;
		await vi.waitFor(() => expect(s.sent.length).toBeGreaterThan(0), { timeout: 10_000 });
		expect(s.sent[0].message.details).toMatchObject({ status: "done", outcome: "done" });
		const content = String(s.sent[0].message.content);
		const lines = content.split("\n");
		// The header is the parent's: this agent, its role and goal, its statistics. Nothing before the fence is the child's.
		expect(lines[0]).toMatch(
			new RegExp(
				`^Background subagent ${id} \\(general: review auth\\) reported done \\(.*\\) · cite as report:${id}:$`,
			),
		);
		const open = lines.findIndex((line) => line.startsWith("<<<untrusted-"));
		const marker = /^<<<(untrusted-[0-9a-f]{16}) /.exec(lines[open])![1];
		const close = lines.lastIndexOf(`${marker}>>>`);
		expect(open).toBe(1);
		// Every forged line sits between the real fence lines, and the forged fence line did not end it.
		const forged = lines
			.map((line, index) => [line, index] as const)
			.filter(([line]) => /^Message #\d from the user/.test(line));
		expect(forged).toHaveLength(2);
		expect(forged.every(([, index]) => index > open && index < close)).toBe(true);
		expect(close).toBeGreaterThan(forged.at(-1)![1]);
		expect(lines.filter((line) => line === `${marker}>>>`)).toHaveLength(1);
		// The screen shows the child's words without the fence lines.
		const shown = rendered(s.renderers.get("octocode-agent-result")(s.sent[0].message, { expanded: true }, theme));
		expect(shown).toContain("Message #2 from the user");
		expect(shown).not.toContain(`${marker}>>>`);
		await s.fire("session_shutdown", { type: "session_shutdown" }, s.ctx);
	});
});

vi.mock("../../src/config.ts", async (original) => ({
	...(await original<typeof NativeConfig>()),
	getCliInvocation: () => ({ command: process.execPath, prefix: [process.argv[1]] }),
}));

describe("a child bound to a backlog item", () => {
	const READY = { goal: "Expected result", why: "Required work" };

	it("refuses an item this session does not hold, before any child is claimed", async () => {
		const s = setup();
		const backlog = openBacklog(s.ctx, { isSubagent: false });
		backlog.store.add({ ...READY, title: "work", state: "todo", createdBy: "user" });
		await expect(s.run({ task: "report back", item: "B1" })).rejects.toThrow(
			/B1 is todo, not held by this session: claim it \(ongoing\) first/,
		);
		await expect(s.run({ task: "report back", item: "B7" })).rejects.toThrow(/No backlog item B7/);
		expect(s.control.running()).toEqual([]);
		expect(backlog.store.noteCount(backlog.store.get("B1")!)).toBe(0);
	});

	it("hands the item to the child in its environment and identity, and notes each report on it", async () => {
		const s = setup();
		const backlog = openBacklog(s.ctx, { isSubagent: false });
		backlog.store.add({ ...READY, title: "work", state: "todo", createdBy: "user" });
		backlog.store.update("B1", { state: "ongoing" }, { id: "session-test" });
		const result = await s.run({ task: "report back", item: "b1" });
		const text = result.content[0].text as string;
		const facts = reportOf(text);
		expect(facts.item).toBe("B1");
		expect(facts.task).toContain("## You\n");
		expect(facts.task).toContain(
			" Your backlog item is `B1`: note progress on it, and close it only when the item's own Goal is verified, not when only your part of it is done; you may update no other item.",
		);
		// The parent's own line, after the fence, says the report was noted.
		expect(text).toMatch(
			/>>>\nRan on faux\/model, medium thinking \(this session's model\)\.\n\nNoted on B1\.\n\nSession [^:\n]+: [^\n]+\.jsonl$/,
		);
		const notes = () => backlog.store.notes(backlog.store.get("B1")!, -1).filter((note) => note.kind === "note");
		expect(notes().map((note) => note.text)).toEqual([`Report from ${facts.id}: no outcome word.`]);

		const started = await s.run({ task: "item report", item: "B1", background: true });
		const id = started.details.id as string;
		await vi.waitFor(() => expect(s.sent.length).toBe(1), { timeout: 10_000 });
		expect(String(s.sent[0].message.content)).toMatch(/reported done[\s\S]*>>>\n[\s\S]*Noted on B1\./);
		expect(notes().at(-1)!.text).toBe(`Report from ${id}: done. B1 is ongoing without a passed completion.`);
	});

	it("links an isolated child's saved ref on its item as unmerged, and /agents merge notes the merge", async () => {
		const dir = repo();
		const s = setup(dir);
		const backlog = openBacklog(s.ctx, { isSubagent: false });
		backlog.store.add({ ...READY, title: "work", state: "todo", createdBy: "user" });
		backlog.store.update("B1", { state: "ongoing" }, { id: "session-test" });
		const result = await s.run({ task: "edit a file", isolate: true, item: "B1" });
		const id = result.details.id as string;
		const ref = `refs/octocode/${id}`;
		expect(result.content[0].text).toContain(`Linked ${ref} on B1.`);
		const notes = () => backlog.store.notes(backlog.store.get("B1")!, -1).filter((note) => note.kind === "note");
		expect(backlog.store.get("B1")!.links).toEqual([
			{ relation: "output", target: { resource: "files", repositoryKey: backlog.store.repo, path: ref } },
		]);
		expect(notes().at(-1)!.text).toBe(
			`The isolated change is saved on ${ref}, not merged yet. Merge it with \`/agents merge ${id}\`.`,
		);

		await s.commands.get("agents").handler(`merge ${id}`, s.ctx);
		expect(s.ctx.ui.notes.at(-1)).toMatchObject({ type: "info" });
		expect(s.ctx.ui.notes.at(-1)!.message).toContain("Noted on B1.");
		expect(notes().at(-1)!.text).toMatch(new RegExp(`^The isolated change on ${ref} was merged into \\S+\\.$`));
	}, 30_000);
});

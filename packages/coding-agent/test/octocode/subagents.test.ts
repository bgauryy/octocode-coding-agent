import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseArgs } from "../../src/cli/args.ts";
import { octocodePrompt } from "../../src/octocode/instructions/policy.ts";
import { ROLE_PROMPT_FILE_ENV, readRolePrompt, writeRolePrompt } from "../../src/octocode/instructions/role.ts";
import { teamTask } from "../../src/octocode/instructions/task.ts";
import { Permission } from "../../src/octocode/permission/ask.ts";
import { Subcommands } from "../../src/octocode/shared/commands.ts";
import { LOCAL_RESEARCH_TOOLS } from "../../../mcp/src/presets/octocode/names.ts";
import { processStartTime } from "../../src/octocode/shared/process.ts";
import { addUsage, emptyUsage } from "../../src/octocode/shared/util.ts";
import { machineSubagents, maxSubagents, Slots, subagentLimitError } from "../../src/octocode/subagents/claim.ts";
import { FAILED_NEXT, failedNext } from "../../src/octocode/subagents/report-text.ts";
import { assistantText } from "../../src/octocode/subagents/events.ts";
import { buildAgentArgs } from "../../src/octocode/subagents/process/session.ts";
import { taskSkillPlan } from "../../src/octocode/subagents/task-skills.ts";
import { subagentProcessEnv } from "../../src/octocode/subagents/process/env.ts";
import { askSpawn, loadProfiles, parseProfile, profileReach } from "../../src/octocode/subagents/profiles.ts";
import { registerAgentTool } from "../../src/octocode/subagents/tool.ts";
import { fakeCtx, fakePermission, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

/** A child's saved session, as `childSession` names it. */
const SESSION = { dir: "/s/session", id: "inky-kraken" };

describe("legacy direct child skill paths", () => {
	it("retains the direct launch path option independently of native resource snapshots", () => {
		const files = ["/parent-only/release/SKILL.md"];
		expect(parseArgs(buildAgentArgs(undefined, undefined, SESSION, files)).skills).toEqual(files);
		expect(parseArgs(buildAgentArgs(undefined, undefined, SESSION, [])).noSkills).toBe(true);
	});
});

describe("subagent permissions", () => {
	it("sets the child mode and grant from the parent, never from the inherited environment", () => {
		const env = subagentProcessEnv(
			undefined,
			{ OCTOCODE_PERMISSION: "full", OCTOCODE_PERMISSION_GRANTS: "file.outside" },
			{ id: "a-1", permission: { mode: "manual", grants: ["shell"] } },
		);
		expect(env).toMatchObject({ OCTOCODE_PERMISSION: "manual", OCTOCODE_PERMISSION_GRANTS: "shell" });
		const none = subagentProcessEnv(
			undefined,
			{ OCTOCODE_PERMISSION: "full", OCTOCODE_PERMISSION_GRANTS: "shell" },
			{ id: "a-1", permission: { mode: "workspace", grants: [] } },
		);
		expect(none.OCTOCODE_PERMISSION).toBe("workspace");
		expect(none).not.toHaveProperty("OCTOCODE_PERMISSION_GRANTS");
	});

	it("grants only the workspace classes a profile's tools reach", () => {
		const profile = (fields: object) => ({ name: "p", description: "", prompt: "", ...fields });
		expect(profileReach(undefined)).toEqual(["file.workspace", "shell"]);
		expect(() => profileReach(profile({ excludeTools: "file" }))).toThrow(/removes file/);
		// Every child can run commands, a read-only allowlist included.
		expect(profileReach(profile({ tools: "read,grep" }))).toEqual(["file.workspace", "shell"]);
		expect(profileReach(profile({ tools: "read,file,bash", excludeTools: "bash" }))).toEqual(["file.workspace"]);
		expect(profileReach(profile({ tools: "read,edit,write,bash", excludeTools: "bash" }))).toEqual(["file.workspace"]);
	});

	it("asks once in manual and passes the grant; a denied spawn throws before anything starts", async () => {
		const fake = fakeHost();
		const permission = new Permission({ api: fake.api, env: { OCTOCODE_PERMISSION: "manual" }, isSubagent: false });
		const ctx = fakeCtx({ cwd: tmp(), ui: { selects: ["Allow once", "Deny"] } });
		permission.start(ctx);
		let title = "";
		const select = ctx.ui.select;
		ctx.ui.select = async (text: string, choices: string[]) => {
			title ||= text;
			return select(text, choices);
		};
		const implementer = { name: "implementer", description: "", prompt: "" };
		expect(await askSpawn(permission, ctx, implementer, "Fix the bug")).toEqual(["file.workspace", "shell"]);
		expect(title).toMatch(/implementer may edit files in the repository and run shell commands[\s\S]*Fix the bug/);
		await expect(askSpawn(permission, ctx, implementer, "Again")).rejects.toThrow(/denied starting a subagent/);
		permission.setMode("workspace", ctx);
		// A mode that allows the spawn passes no grant: the child inherits the mode itself.
		expect(await askSpawn(permission, ctx, implementer, "Fix")).toEqual([]);
	});

	it("does not tell the user a read-only role may edit files, while keeping what it is granted", async () => {
		const fake = fakeHost();
		const permission = new Permission({ api: fake.api, env: { OCTOCODE_PERMISSION: "manual" }, isSubagent: false });
		const ctx = fakeCtx({ cwd: tmp(), ui: { selects: ["Allow once", "Allow once"] } });
		permission.start(ctx);
		const titles: string[] = [];
		const select = ctx.ui.select;
		ctx.ui.select = async (text: string, choices: string[]) => {
			titles.push(text);
			return select(text, choices);
		};
		const researcher = { name: "researcher", description: "", prompt: "", readOnly: true as const };
		expect(await askSpawn(permission, ctx, researcher, "Read the parser")).toEqual(["file.workspace", "shell"]);
		expect(titles[0]).toMatch(/researcher may run shell commands;/);
		expect(titles[0]).not.toContain("edit files");
		const reader = { ...researcher, name: "reader", excludeTools: "bash" };
		await askSpawn(permission, ctx, reader, "Read the parser");
		expect(titles[1]).toMatch(/reader may only read and research;/);
	});
});

describe("profile permissions", () => {
	const text = (permissions: string) =>
		`---\nname: web\ndescription: Browses\nexcludeTools: bash\npermissions: ${permissions}\n---\nBrowse.`;
	const spawnCtx = (selects: string[]) => {
		const ctx = fakeCtx({ cwd: tmp(), ui: { selects } });
		const titles: string[] = [];
		const select = ctx.ui.select;
		ctx.ui.select = async (title: string, choices: string[]) => {
			titles.push(title);
			return select(title, choices);
		};
		return { ctx, titles };
	};

	it("reads only the declarable classes, reports the rest, and hashes the content", () => {
		const profile = parseProfile("x", text("[browser.control, shell, net.private, shell.destructive]"));
		expect(profile.permissions).toEqual(["browser.control", "net.private"]);
		expect(profile.ignoredPermissions).toEqual(["shell", "shell.destructive"]);
		expect(parseProfile("x", text("[browser.control]")).hash).not.toBe(
			parseProfile("x", text("[browser.control, net.private]")).hash,
		);
		expect(parseProfile("x", "---\nname: plain\n---\nBody.").permissions).toBeUndefined();
	});

	it("forces one spawn prompt listing each class in workspace, remembers the answer, and asks again after an edit", async () => {
		const fake = fakeHost();
		const permission = new Permission({ api: fake.api, env: { OCTOCODE_PERMISSION: "workspace" }, isSubagent: false });
		const { ctx, titles } = spawnCtx(["Allow once", "Allow once", "Deny"]);
		permission.start(ctx);
		const profile = parseProfile("x", text("[browser.control, net.private]"));
		expect(await askSpawn(permission, ctx, profile, "look")).toEqual([
			"file.workspace",
			"browser.control",
			"net.private",
		]);
		expect(titles).toHaveLength(1);
		expect(titles[0]).toContain("permission it declares: browser.control");
		expect(titles[0]).toContain("permission it declares: net.private");
		expect(titles[0]).toContain("▸ why it asks: the profile declares browser.control");
		// The same profile content is not asked about again; a changed one is.
		expect(await askSpawn(permission, ctx, profile, "look again")).toEqual(["browser.control", "net.private"]);
		expect(titles).toHaveLength(1);
		const edited = parseProfile("x", text("[browser.control, net.private]").replace("Browse.", "Browse more."));
		expect(await askSpawn(permission, ctx, edited, "look")).toEqual([
			"file.workspace",
			"browser.control",
			"net.private",
		]);
		expect(titles).toHaveLength(2);
		permission.clearGrants();
		await expect(askSpawn(permission, ctx, profile, "look")).rejects.toThrow(/denied starting a subagent/);
	});

	it("runs a declaring profile in full without a prompt, and still records the reason", async () => {
		const fake = fakeHost();
		const permission = new Permission({
			api: fake.api,
			env: { OCTOCODE_PERMISSION: "full" },
			isSubagent: false,
			stderr: () => undefined,
		});
		const { ctx, titles } = spawnCtx([]);
		permission.start(ctx);
		expect(await askSpawn(permission, ctx, parseProfile("x", text("[browser.control]")), "look")).toEqual([
			"browser.control",
		]);
		expect(titles).toEqual([]);
		expect(fake.entries.map((entry) => entry.data)).toEqual([
			expect.objectContaining({ action: "agent.spawn", reasons: ["profile.permissions"], via: "mode" }),
		]);
	});

	it("keeps evaluate for the web profiles by declaring browser.control", () => {
		for (const name of ["browser"]) {
			const profile = parseProfile(
				name,
				fs.readFileSync(path.join(__dirname, "../..", "src/octocode/instructions/roles", `${name}.md`), "utf8"),
			);
			expect(profile.permissions, name).toEqual(["browser.control"]);
			expect(profile.ignoredPermissions, name).toBeUndefined();
		}
	});
});

describe("subagents", () => {
	it("collaborate mode: lists teammates in the task", () => {
		expect(teamTask("Fix A", "main-1", [["researcher-2", "Trace B"]])).toBe(
			"Fix A\n\n## Teammates\nYou collaborate with the other subagents that main-1 started for the same goal. Running now:\n- `researcher-2`: Trace B\nTo pass on a teammate's message, forward it instead of retyping it.",
		);
		expect(teamTask("Fix A", "main-1", [])).toMatch(
			/none yet; `agent` type `coordinate` shows teammates that start later/,
		);
		// The parent names its session for backlog ownership; an inherited value from a grandparent never leaks through.
		expect(
			subagentProcessEnv(undefined, { OCTOCODE_PARENT_SESSION: "old" }, { id: "a-1", parentSession: "s-1" })
				.OCTOCODE_PARENT_SESSION,
		).toBe("s-1");
		expect(subagentProcessEnv(undefined, { OCTOCODE_PARENT_SESSION: "old" }, { id: "a-1" })).not.toHaveProperty(
			"OCTOCODE_PARENT_SESSION",
		);
		// The parent's pid and its start time: a later process that reuses the pid is not taken for the parent.
		const started = processStartTime(process.pid);
		expect(subagentProcessEnv(undefined, { OCTOCODE_PARENT_PID: "1" }, { id: "a-1" }).OCTOCODE_PARENT_PID).toBe(
			started ? `${process.pid} ${started}` : String(process.pid),
		);
		// The user's command hooks stay in the main session unless the profile opts in.
		expect(subagentProcessEnv(undefined, { OCTOCODE_SUBAGENT_HOOKS: "1", PATH: "/bin" })).not.toHaveProperty(
			"OCTOCODE_SUBAGENT_HOOKS",
		);
		expect(subagentProcessEnv(undefined, { PATH: "/bin" }).PATH).toBe("/bin");
		expect(
			subagentProcessEnv({ name: "h", description: "", prompt: "", hooks: true }, {}).OCTOCODE_SUBAGENT_HOOKS,
		).toBe("1");
		expect(parseProfile("x", "---\nhooks: true\n---\nbody").hooks).toBe(true);
		// Switches take YAML booleans only; a quoted string is refused rather than read as a guess.
		expect(() => parseProfile("x", "---\nmcp: false\n---\nbody")).toThrow(
			/every specialist needs Octocode local research/,
		);
		expect(parseProfile("x", "---\nvisibleBrowser: false\n---\nbody")).toMatchObject({ headless: true });
		for (const value of ['"true"', '"false"', "1", "yes"])
			expect(() => parseProfile("x", `---\nheadless: ${value}\n---\nbody`), value).toThrow(
				/headless must be true or false/,
			);
		for (const value of ['"true"', '"false"', "1", "yes"])
			expect(() => parseProfile("x", `---\nmcp: ${value}\n---\nbody`), value).toThrow(/mcp must be true or false/);
		// Parent/child and teammate communication share one policy: a child messages its parent for a decision.
		expect(octocodePrompt({ octocode: false, profiles: [], canDelegate: false })).toMatch(
			/You cannot ask the user\. When you need a decision or approval, ask your parent as your run mode says/,
		);
	});

	it("parses profile frontmatter and builds child Octocode arguments", () => {
		const profile = parseProfile(
			"fallback",
			"---\nname: researcher\ndescription: Reads code\ntools: read,grep\n---\nBe precise.",
		);
		expect(profile).toEqual({
			name: "researcher",
			description: "Reads code",
			prompt: "Be precise.",
			tools: "read,grep,bash,file,agent,steps,archive,skill,mcp,mcp__*",
			hash: expect.stringMatching(/^[0-9a-f]{16}$/),
		});
		const args = buildAgentArgs(profile, "anthropic/claude", SESSION);
		expect(args).toEqual([
			"--mode",
			"rpc",
			"--session-dir",
			SESSION.dir,
			"--session-id",
			SESSION.id,
			"--model",
			"anthropic/claude",
			"--tools",
			"read,grep,bash,file,agent,steps,archive,skill,mcp,mcp__*",
			// A profile that does not name the browser server never starts it.
			"--exclude-tools",
			"mcp__browser__*",
		]);
		expect(args).not.toContain("--append-system-prompt");
	});

	it("hands the profile prompt to Octocode as an owner-only file, so a prompt that names a path is never read as that file", () => {
		const dir = tmp();
		const decoy = path.join(tmp(), "secret.txt");
		fs.writeFileSync(decoy, "not the prompt");
		const promptFile = writeRolePrompt(decoy, dir);
		const env = subagentProcessEnv(undefined, { [ROLE_PROMPT_FILE_ENV]: "/stale" }, undefined, undefined, promptFile);
		expect(readRolePrompt(env)).toBe(decoy);
		expect(subagentProcessEnv(undefined, env)[ROLE_PROMPT_FILE_ENV]).toBeUndefined();
		expect(promptFile).not.toBe(decoy);
		expect(fs.readFileSync(promptFile, "utf8")).toBe(decoy);
		if (process.platform !== "win32") expect(fs.statSync(promptFile).mode & 0o777).toBe(0o600);
		// No prompt, no file.
		expect(buildAgentArgs({ name: "p", description: "", prompt: "" }, undefined, SESSION)).not.toContain(
			"--append-system-prompt",
		);
	});

	it("keeps the task out of the arguments: RPC takes it as a prompt command, so no task text can become a flag or an @file", () => {
		const profile = parseProfile("p", "---\ntools: read\n---\n- Be careful.");
		const parsed = parseArgs(buildAgentArgs(profile, "faux/model", SESSION));
		expect(parsed.mode).toBe("rpc");
		expect(parsed.messages).toEqual([]);
		expect(parsed.fileArgs).toEqual([]);
		expect(parsed.model).toBe("faux/model");
		expect(parsed.removedFlags).toBeUndefined();
		expect(parsed.appendSystemPrompt).toBeUndefined();
		expect(parsed.diagnostics).toEqual([]);
	});

	it("rejects programmatic profiles that disable the required local research", () => {
		expect(() =>
			buildAgentArgs({ name: "plain", description: "", prompt: "", mcp: false }, undefined, SESSION),
		).toThrow(/disables MCP/);
	});

	it("maps excludeTools frontmatter to --exclude-tools", () => {
		const profile = parseProfile("reviewer", "---\nexcludeTools: browser,bash\n---\nReview.");
		expect(profile.excludeTools).toBe("browser,bash");
		const args = buildAgentArgs(profile, undefined, SESSION);
		expect(args).toEqual([
			"--mode",
			"rpc",
			"--session-dir",
			SESSION.dir,
			"--session-id",
			SESSION.id,
			"--tools",
			["bash", "file", "agent", "steps", "archive", "skill", "mcp", ...LOCAL_RESEARCH_TOOLS]
				.map((name) => `+${name}`)
				.join(","),
			"--exclude-tools",
			"browser,bash,mcp__browser__*",
		]);
	});

	it("loads project profiles only for trusted projects", () => {
		const cwd = tmp();
		fs.mkdirSync(path.join(cwd, ".octocode", "agents"), { recursive: true });
		fs.writeFileSync(
			path.join(cwd, ".octocode", "agents", "local.md"),
			"---\ndescription: Project profile\n---\nDo it.",
		);
		expect(loadProfiles(cwd, tmp(), false).has("local")).toBe(false);
		expect(loadProfiles(cwd, tmp(), true).has("local")).toBe(true);
	});

	it("skips a malformed or unreadable profile and still loads the rest, bundled ones included", () => {
		const cwd = tmp();
		const dir = path.join(cwd, ".octocode", "agents");
		fs.mkdirSync(path.join(dir, "folder.md"), { recursive: true });
		fs.writeFileSync(path.join(dir, "broken.md"), "---\nname: [a\n---\nbody");
		fs.writeFileSync(path.join(dir, "good.md"), "---\ndescription: Fine\n---\nDo it.");
		const skipped: string[] = [];
		const profiles = loadProfiles(cwd, tmp(), true, {}, (file) => skipped.push(path.basename(file)));
		expect(profiles.has("good")).toBe(true);
		expect(profiles.has("reviewer")).toBe(true);
		expect(skipped.sort()).toEqual(["broken.md", "folder.md"]);
	});

	it("bundles one browser specialist with shared instructions and a headless default", () => {
		const profiles = loadProfiles(tmp(), tmp(), false, {});
		expect([...profiles.keys()].sort()).toEqual(["browser", "implementer", "lean", "researcher", "reviewer"]);
		const profile = profiles.get("browser")!;
		expect(profile.headless).toBe(true);
		expect(profile.prompt.length).toBeLessThanOrEqual(2_000);
		expect(profile.prompt).toContain("headless");
		expect(profile.prompt).toContain("persistent");
		expect(buildAgentArgs(profile, undefined, SESSION)).not.toContain("--no-mcp");
		// Every Octocode tool stays declared for every bundled role: none excludes tools.
		for (const name of ["researcher", "reviewer", "implementer"])
			expect(profiles.get(name)?.excludeTools, name).toBeUndefined();
	});

	it("gives each bundled role the skills it names, so a child does not carry the whole catalog", () => {
		const profiles = loadProfiles(tmp(), tmp(), false, {});
		expect(profiles.get("researcher")?.skills).toEqual(["octocode-research"]);
		expect(profiles.get("reviewer")?.skills).toEqual(["octocode-research"]);
		expect(profiles.get("browser")?.skills).toEqual(["octocode-chrome-devtools"]);
		expect(profiles.get("implementer")?.skills).toEqual(["octocode-debugging"]);
		// An empty list is a choice (no skills), not an absent key (the whole catalog).
		expect(parseProfile("none", "---\nskills: []\n---\nTask").skills).toEqual([]);
		// A task's own `skills` replaces the role's: taskSkillPlan prefers it.
		expect(taskSkillPlan(profiles.get("implementer"), ["octocode-roast"]).names).toEqual(["octocode-roast"]);
	});

	it("relaxes the local research floor only for an allowlist that names Octocode server tools", () => {
		const names = (tools: string | undefined) => (tools ?? "").split(",");
		const curated = names(parseProfile("c", "---\ntools: mcp__octocode__clasify\n---\nTask").tools);
		expect(curated).toEqual(expect.arrayContaining(["mcp__octocode__localFetch", "mcp__octocode__localSearch"]));
		expect(curated).not.toContain("mcp__octocode__astSearch");
		const other = names(parseProfile("o", "---\ntools: mcp__example__lookup\n---\nTask").tools);
		expect(other).toEqual(expect.arrayContaining(LOCAL_RESEARCH_TOOLS));
	});

	it("lets the browser role leave out the structure, AST and LSP tools but keeps the local reader and search", () => {
		const browser = loadProfiles(tmp(), tmp(), false, {}).get("browser")!;
		const tools = browser.tools ?? "";
		for (const name of ["structureSearch", "astSearch", "lspSearch"]) expect(tools).not.toContain(name);
		for (const name of ["localFetch", "localSearch"])
			expect(tools).toMatch(new RegExp(`mcp__octocode__(${name}|local\\*)`));
	});

	it("carries the browser mode in the task, not the environment", () => {
		const profile = loadProfiles(tmp(), tmp(), false, {}).get("browser")!;
		const inherited = { PATH: "/usr/bin" };
		expect(subagentProcessEnv({ ...profile, headless: false }, inherited)).toMatchObject({
			OCTOCODE_SUBAGENT: "1",
			PATH: "/usr/bin",
		});
		expect(subagentProcessEnv({ ...profile, headless: false }, inherited)).not.toHaveProperty(
			"OCTOCODE_BROWSER_VISIBLE",
		);
		expect(subagentProcessEnv(profile, inherited)).not.toHaveProperty("OCTOCODE_BROWSER_VISIBLE");
		expect(subagentProcessEnv(undefined, inherited)).not.toHaveProperty("OCTOCODE_BROWSER_VISIBLE");
		expect(profile.headless).toBe(true);
	});

	it("caps running subagents at OCTOCODE_MAX_SUBAGENTS, default what the machine suits", () => {
		expect(maxSubagents({}, 6)).toBe(6);
		expect(maxSubagents({})).toBeGreaterThanOrEqual(1);
		expect(maxSubagents({ OCTOCODE_MAX_SUBAGENTS: "5" })).toBe(5);
		// The setting wins, above the machine's default too.
		expect(maxSubagents({ OCTOCODE_MAX_SUBAGENTS: "12" }, 2)).toBe(12);
		for (const bad of ["0", "-1", "2.5", "many", ""])
			expect(maxSubagents({ OCTOCODE_MAX_SUBAGENTS: bad }, 3), bad).toBe(3);
		const refusal = subagentLimitError(["a", "b", "c"], 3);
		expect(refusal).toContain("3 subagents are already running (a, b, c)");
		expect(refusal).toContain("OCTOCODE_MAX_SUBAGENTS");
	});

	it("derives the default from the machine, never above 6", () => {
		const GIB = 1024 ** 3;
		expect(machineSubagents(16, 64 * GIB)).toBe(6);
		expect(machineSubagents(8, 16 * GIB)).toBe(6);
		expect(machineSubagents(4, 16 * GIB)).toBe(4);
		expect(machineSubagents(16, 4 * GIB)).toBe(4);
		expect(machineSubagents(2, 8 * GIB)).toBe(2);
		expect(machineSubagents(1, 8 * GIB)).toBe(1);
		expect(machineSubagents(8, GIB / 2)).toBe(1);
	});

	it("runs six subagents at once on a large machine and makes the seventh wait for a freed slot", async () => {
		const saved = process.env.OCTOCODE_MAX_SUBAGENTS;
		delete process.env.OCTOCODE_MAX_SUBAGENTS;
		try {
			const slots = new Slots(() => maxSubagents(process.env, machineSubagents(16, 64 * 1024 ** 3)));
			for (let i = 0; i < 6; i++) expect(slots.tryTake(), `slot ${i + 1}`).toBe(true);
			let seventh = false;
			const waiting = slots.take(undefined).then(() => {
				seventh = true;
			});
			await Promise.resolve();
			expect(seventh).toBe(false);
			slots.give();
			await waiting;
			expect(seventh).toBe(true);
		} finally {
			if (saved === undefined) delete process.env.OCTOCODE_MAX_SUBAGENTS;
			else process.env.OCTOCODE_MAX_SUBAGENTS = saved;
		}
	});

	it("advises waiting or running fewer at once after a provider rate limit, not a narrower task", () => {
		const route = { model: "a/claude-haiku", parent: "a/claude-opus", via: "profile researcher: small" };
		for (const error of [
			"Error: 429 Quota or rate limit exceeded",
			"Too Many Requests",
			"overloaded_error: Overloaded",
		]) {
			const text = failedNext(route, error, false);
			expect(text, error).not.toContain(FAILED_NEXT);
			expect(text, error).toContain("OCTOCODE_MAX_SUBAGENTS");
			expect(text, error).toMatch(/wait/i);
			expect(text, error).toContain("Ran on a/claude-haiku");
		}
		expect(failedNext(route, "tool crashed", false)).toContain(FAILED_NEXT);
	});

	it("makes a call past the limit wait for a slot, first come first served, and lets it give up", async () => {
		const slots = new Slots(() => 1);
		await slots.take(undefined);
		const waits: number[] = [];
		const order: string[] = [];
		const second = slots.take(undefined, (running) => waits.push(running)).then(() => order.push("second"));
		const cancelled = new AbortController();
		const third = slots.take(cancelled.signal).then(
			() => order.push("third"),
			(error: Error) => order.push(error.message),
		);
		const fourth = slots.take(undefined).then(() => order.push("fourth"));
		expect(waits).toEqual([1]);
		expect(slots.tryTake()).toBe(false);
		cancelled.abort();
		await third;
		slots.give();
		await second;
		slots.give();
		await fourth;
		expect(order).toEqual(["Cancelled while waiting for a subagent slot.", "second", "fourth"]);
		slots.give();
		expect(slots.tryTake()).toBe(true);
	});

	it("does not strand a slot when progress reporting aborts before the waiter subscribes", async () => {
		const slots = new Slots(() => 1);
		await slots.take(undefined);
		const controller = new AbortController();
		const waiting = slots.take(controller.signal, () => controller.abort());
		const result = await Promise.race([
			waiting.then(
				() => "acquired",
				(error: Error) => error.message,
			),
			new Promise<string>((resolve) => setTimeout(() => resolve("still waiting"), 10)),
		]);
		expect(result).toBe("Cancelled while waiting for a subagent slot.");
		slots.give();
		expect(slots.tryTake()).toBe(true);
	});

	it("takes any task length, offers isolate, and registers /agents with kill and merge", async () => {
		const tools: Array<{
			name: string;
			parameters: { properties: Record<string, { maxLength?: number; description?: string }> };
		}> = [];
		const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
		const api = {
			registerTool: (tool: never) => tools.push(tool),
			registerCommand: (name: string, command: never) => commands.set(name, command),
			registerMessageRenderer: () => undefined,
			on: () => undefined,
			sendMessage: () => undefined,
		} as never;
		const control = registerAgentTool(
			api,
			() => new Map(),
			{ id: undefined, view: { members: [], traffic: [] }, members: () => [], setResumer: () => undefined } as never,
			fakePermission(),
		);
		// index.ts adds it as the `/agents` command.
		const subcommands = new Subcommands();
		subcommands.add("agents", control.command);
		subcommands.register(api);
		const agent = tools.find((tool) => tool.name === "agent")!;
		expect(agent.parameters.properties.task?.maxLength).toBeUndefined();
		expect(agent.parameters.properties).toHaveProperty("isolate");
		// The parameter owns the collaborate guidance; the prompt does not repeat it.
		expect(agent.parameters.properties.collaborate?.description).toMatch(
			/Adds teammate context.*does not enable messaging or grant authority/,
		);
		expect(agent.parameters.properties.model?.description).toMatch(
			/provider\/id, bare id, small or medium.*:off\|minimal\|low.*Fit the task: small:low.*Default: the profile's.*no profile: medium; thinking medium/,
		);
		expect([...commands.keys()]).toEqual(["agents"]);
		const notes: string[] = [];
		await commands.get("agents")!.handler("kill nobody-1", { ui: { notify: (text: string) => notes.push(text) } });
		expect(notes[0]).toBe('No subagent "nobody-1". None is running.');
		expect(subagentProcessEnv(undefined, {}, { id: "a-1", workspace: "/repo" }).OCTOCODE_TEAM_WORKSPACE).toBe("/repo");
	});

	it("sums child model usage", () => {
		const total = emptyUsage();
		addUsage(total, {
			input: 10,
			output: 5,
			cacheRead: 1,
			cacheWrite: 2,
			totalTokens: 18,
			cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 },
		});
		addUsage(total, { output: 5, cost: { total: 0.1 } });
		addUsage(total, undefined);
		expect(total).toMatchObject({ input: 10, output: 10, totalTokens: 18 });
		expect(total.cost.total).toBeCloseTo(0.4);
	});

	it("extracts the final assistant text from a JSON event", () => {
		expect(
			assistantText({
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "…" },
					{ type: "text", text: "Answer" },
				],
			}),
		).toBe("Answer");
		expect(assistantText({ role: "user", content: [] })).toBeUndefined();
	});
});

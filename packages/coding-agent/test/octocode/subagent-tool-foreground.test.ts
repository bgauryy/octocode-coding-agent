import { createHash } from "node:crypto";
import type * as NativeConfig from "../../src/config.ts";
import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderPrompt } from "../../src/core/prompt-template.ts";
import { captureSkillResourceSnapshot } from "../../src/core/skill-resource-snapshot.ts";
import { loadSkills } from "../../src/core/skills.ts";
import { existingLibrary, writeSegment } from "../../src/octocode/history/archive.ts";
import { reportContract } from "../../src/octocode/native/prompts/report.ts";
import { fencedParts } from "../../src/octocode/shared/fence.ts";
import { processStartTime } from "../../src/octocode/shared/process.ts";
import { AGENT_GITIGNORE } from "../../src/storage/agent-layout.ts";
import { rendered, theme } from "./fake-host.ts";
import { tmp } from "./helpers.ts";
import { profiles, reportOf, setup, useScriptedChild } from "./subagent-tool-harness.ts";

vi.mock("../../src/config.ts", async (original) => ({
	...(await original<typeof NativeConfig>()),
	getCliInvocation: () => ({ command: process.execPath, prefix: [process.argv[1]] }),
}));

useScriptedChild();

describe("subagent scratch sweep", () => {
	it("keeps old folders whose owning Octocode process is alive (another session's background subagent) and removes the rest", async () => {
		const s = setup();
		const root = path.join(s.cwd, ".octocode", "agent", "temp", "agents");
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
		fs.writeFileSync(path.join(reused, ".owner"), `${process.pid} 1`);
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
		s.api.resources.getCommands = () => [
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
		s.api.resources.getSkillResourceSnapshot = (names) =>
			captureSkillResourceSnapshot(
				loadSkills({ cwd: s.ctx.cwd, agentDir: tmp(), skillPaths: [file], includeDefaults: false }),
				names,
				s.api.resources.getCommands(),
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
		// `skills` only names what to load first: an empty list still declares the parent's whole list.
		expect(empty.skillResources.resources).toEqual(inherited.skillResources.resources);
		expect(fs.existsSync(empty.skillSnapshotFile)).toBe(false);
		await expect(s.run({ task: "report back", skills: ["missing"] })).rejects.toThrow(/Unknown or ambiguous/);
		// The listing shows `name/SKILL.md`; that form selects the same skill.
		const listed = reportOf((await s.run({ task: "report back", skills: ["release/SKILL.md"] })).content[0].text);
		expect(listed.skillResources.resources).toEqual([
			expect.objectContaining({ skill: expect.objectContaining({ name: "release" }) }),
		]);
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
		expect(facts.scratch).toBe(path.join(fs.realpathSync(s.cwd), ".octocode", "agent", "temp", "agents", facts.id));
		// Its saved conversation keeps the handoff folder available for an explicit resume.
		expect(fs.existsSync(result.details.session.file)).toBe(true);
		expect(path.dirname(result.details.session.file)).toBe(path.join(facts.scratch, "session"));
		expect(fs.readFileSync(path.join(s.cwd, ".octocode", "agent", ".gitignore"), "utf8")).toBe(AGENT_GITIGNORE);
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
				"read,bash,file,agent,notify,archive,memory,skill,mcp,mcp__*",
				"--exclude-tools",
				"browser",
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
		expect(facts.task).toContain("report back\nsecond line");
		for (const value of [facts.id, "researcher", "check things", s.team.id, facts.scratch, reportContract()])
			expect(facts.task).toContain(value);
		expect(result.usage.cost.total).toBeCloseTo(0.01);
		expect(fs.existsSync(result.details.shot)).toBe(true);
		expect(updates.some((update) => update.details.activity.includes("→ bash ls -la"))).toBe(true);
		const late = await s.team.send(facts.id, "one more thing");
		// The finished receipt points to the retained folder that owns its saved conversation.
		expect("error" in late && late.error).toContain(
			`${facts.id} has finished and takes no more messages; its report (or failure) reached you or arrives when your turn ends (files it handed back, and its full report when cut, are in ${facts.scratch}). To continue`,
		);
		expect(updates.some((update) => update.content.some((part) => part.type === "image"))).toBe(true);

		const done = rendered(
			s.agent.renderResult(result, { isPartial: false, expanded: false }, theme, {
				isError: false,
				durationMs: 250,
			}),
		);
		// The time shows once, in the header: the outcome does not repeat it.
		expect(done).toMatch(/^ {2}⎿ {2}Done · [a-z]+-[a-z]+ · 1 tool call\n/);
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
		).toMatch(/^◉ Agent · background/);
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
			expect(footer).toContain("/providers");
			expect(footer).not.toContain("narrower task");
			await s.run({ task: "auth error please", profile: "scout", background: true });
			await vi.waitFor(() => expect(s.sent.length).toBe(1));
			const report = String(s.sent[0].message.content);
			// The first run's credential refusal steers routing away from `alt`: the report names where it ran instead.
			expect(report).toContain("Ran on faux/model, medium thinking (shared: alt refused its credential).");
			expect(report).toContain("fix the faux credential with /providers");
			expect(report).not.toContain("narrower task");
			// On this session's own model, switching to it cannot help: the credential is the fix.
			const own = await s.run({ task: "auth error please" });
			const ownFooter = fencedParts(own.content[0].text)?.footer ?? "";
			expect(ownFooter).toContain("Ran on faux/model, medium thinking (this session's model).");
			expect(ownFooter).toContain("/providers");
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
		expect(limited.content[0].text).toContain("Partial answer:\nunfinished findings");
		const silent = await s.run({ task: "silent run" });
		expect(silent).toMatchObject({ isError: true, details: { status: "failed", outcome: "failed" } });
		expect(fencedParts(silent.content[0].text)?.body).toBeTruthy();
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
			expect(child.task).toContain(renderPrompt("subagent/browser-mode.md", { headless: String(index !== 1) }));
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
			const without = reportOf((await s.run({ task: "report back" })).content[0].text as string);
			writeSegment(
				{
					session: "parent",
					entry: "c1",
					tokensBefore: 1,
					method: "octocode-default",
					tldr: "earlier work",
					topics: [],
					readFiles: [],
					modifiedFiles: [],
					messages: 1,
				},
				"body",
			);
			const library = existingLibrary()!;
			const archiveDir = path.dirname(library);
			expect(without.task).not.toContain(archiveDir);
			const withLibrary = reportOf((await s.run({ task: "report back" })).content[0].text as string);
			// The archive path is interpolated once without changing the task or report contract.
			expect(withLibrary.task.split(archiveDir)).toHaveLength(2);
			expect(withLibrary.task.startsWith("report back\n\n")).toBe(true);
			expect(withLibrary.task).toContain(reportContract());
			expect(withLibrary.args.join(" ")).not.toContain(library);
			// Every child keeps archive, even when its explicit allowlist only names web.
			profiles.set("restricted", { name: "restricted", description: "web", prompt: "Fetch pages.", tools: "web" });
			const offline = reportOf((await s.run({ task: "report back", profile: "restricted" })).content[0].text as string);
			expect(offline.task.split(archiveDir)).toHaveLength(2);
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
		const result = await s.run({ task: "report back" });
		const text = result.content[0].text as string;
		const facts = reportOf(text);
		expect(facts.parent).toBeUndefined();
		expect(facts.task).not.toContain("team led by");
		expect(text).toContain("Team database unavailable: locked");
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
		const file = path.join(
			fs.realpathSync(s.cwd),
			".octocode",
			"agent",
			"temp",
			"agents",
			result.details.id,
			"report.md",
		);
		const savedReport = fs.readFileSync(file, "utf8");
		const sha256 = createHash("sha256").update(savedReport).digest("hex");
		const version = path.join(path.dirname(file), `report-${sha256}.md`);
		expect(result.details.reportArtifact).toEqual({ sha256, path: version });
		expect(fs.readFileSync(version, "utf8")).toBe(savedReport);
		expect(fencedParts(text)?.body).toMatch(/^summary first\n/);
		expect(text).toContain(version);
		expect(Buffer.byteLength(text)).toBeLessThan(9 * 1024);
		expect(fs.readFileSync(file, "utf8")).toMatch(/the end$/);
		// A short report is not written to disk.
		const short = await s.run({ task: "report" });
		expect(fs.existsSync(path.join(s.cwd, ".octocode", "agent", "temp", "agents", short.details.id, "report.md"))).toBe(
			false,
		);
		expect(short.details.reportArtifact).toEqual({ sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
	});

	it("names the loop guard in the report of a child it ended", async () => {
		const result = await s.run({ task: "loop halted" });
		expect(result).toMatchObject({ isError: true, details: { status: "failed", outcome: "failed" } });
		expect(fencedParts(result.content[0].text)?.body).toMatch(
			/^Subagent ended without a final answer .*Its last error: Loop guard ended this run/,
		);
	});
});

import { approveFixtureSkillFiles } from "./guard-helpers.ts";
import { openSandboxDb } from "./e2e-helpers/seed-trust.ts";
import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { enableHarnesses } from "./e2e-helpers/harness-toggles.ts";
import { GENERAL_CATALOG } from "../../src/octocode/subagents/general-defaults.ts";
import {
	type Endpoint,
	killEverything,
	outputOfRuns,
	sandbox,
	script,
	startEndpoint,
	type ModelRequest,
	type Step,
} from "./e2e-real-process-harness.ts";

/**
 * What the agent receives in its first model request when harnesses and instruction files are present: project
 * instructions follow AGENTS.override.md > AGENTS.md and never CLAUDE.md; skills come from `.agents` and, only once the
 * Claude Code harness is switched on, from `.claude`; the `Harnesses:` line names the harnesses that are on and found something; a
 * subagent started without a role lists the user's own skills and its bundled catalog, and no `Harnesses:` line. Real processes on the scripted model, a temporary home and project (trusted by `--trust`).
 */
let endpoint: Endpoint;

vi.setConfig({ testTimeout: 180_000 });

beforeAll(async () => {
	endpoint = await startEndpoint();
});
afterAll(async () => {
	await endpoint?.close();
});
afterEach(async (context) => {
	if (context.task.result?.state === "fail") console.error(outputOfRuns());
	await killEverything();
	endpoint.requests.length = 0;
});

function write(file: string, text: string): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, text);
}

const skillFile = (box: ReturnType<typeof sandbox>, dir: string, name: string): string => {
	const file = path.join(box.project, dir, "skills", name, "SKILL.md");
	write(file, `---\nname: ${name}\ndescription: Use for ${name} work in this test.\n---\n# ${name}\n\nBODY-${name}\n`);
	const db = openSandboxDb(box);
	try {
		approveFixtureSkillFiles([{ name, filePath: file, category: "workspace" }], box.project, { db });
	} finally {
		db.close();
	}
	return file;
};

async function firstRequest(box: ReturnType<typeof sandbox>): Promise<ModelRequest> {
	const run = box.start(["-p", script([{ text: "done" }])]);
	const { code } = await run.exited;
	expect(code, run.stderr()).toBe(0);
	const first = endpoint.requests[0];
	expect(first, "the scripted model received no request").toBeDefined();
	endpoint.requests.length = 0;
	return first;
}

const section = (prompt: string, name: string): string =>
	new RegExp(`<${name}>\\n([\\s\\S]*?)\\n</${name}>`).exec(prompt)?.[1] ?? "";

const skillNames = (prompt: string): string[] =>
	[...section(prompt, "skills").matchAll(/<skill name="([^"]+)"/g)].map((match) => match[1]);
/** Native skills marked `metadata.audience: coordinator`: a subagent lacks the tools they need (src/octocode/turn.ts). */
const NATIVE_SKILLS = path.join(import.meta.dirname, "../../src/octocode/native/skills");
const COORDINATOR_ONLY = fs.readdirSync(NATIVE_SKILLS).filter((name) => {
	const file = path.join(NATIVE_SKILLS, name, "SKILL.md");
	return fs.existsSync(file) && /^\s+audience: coordinator$/m.test(fs.readFileSync(file, "utf8"));
});
const harnessesLine = (prompt: string): string => /^Harnesses: .*$/m.exec(prompt)?.[0] ?? "";

/** `Label on` / `Label off` as the line states it; undefined when the line leaves the harness out. */
const stateOf = (line: string, label: string): "on" | "off" | undefined => {
	const found = new RegExp(`(?:^Harnesses: |\\u00b7 )${label.replace(/\./g, "\\.")} (on|off)\\b`).exec(line);
	return found?.[1] as "on" | "off" | undefined;
};

describe("harness context in the first model request", () => {
	it("1: project instructions come from AGENTS.override.md, never CLAUDE.md", async () => {
		const box = sandbox(endpoint);
		write(path.join(box.project, "AGENTS.md"), "AGENTS-BASE-MARKER\n");
		write(path.join(box.project, "AGENTS.override.md"), "AGENTS-OVERRIDE-MARKER\n");
		write(path.join(box.project, "CLAUDE.md"), "CLAUDE-MD-MARKER\n");
		const { system } = await firstRequest(box);
		const blocks = [...system.matchAll(/<project_instructions path="([^"]*)">\n([\s\S]*?)\n<\/project_instructions>/g)];
		const text = blocks.map((block) => block[2]).join("\n");
		expect(text, "AGENTS.override.md content must be in <project_instructions>").toContain("AGENTS-OVERRIDE-MARKER");
		expect(
			blocks.some((block) => block[1].endsWith("AGENTS.override.md")),
			"a block names AGENTS.override.md",
		).toBe(true);
		expect(text, "AGENTS.md loses to AGENTS.override.md in the same directory").not.toContain("AGENTS-BASE-MARKER");
		expect(system, "CLAUDE.md is not read").not.toContain("CLAUDE-MD-MARKER");
	});

	it("2: a .agents skill is listed by name (the skill tool loads it); a .claude skill only once harness:claude is on (global toggle); the Harnesses line names a harness once it is on and found something", async () => {
		const box = sandbox(endpoint);
		const agentsSkill = skillFile(box, ".agents", "agents-demo");
		skillFile(box, ".claude", "claude-demo");

		const off = await firstRequest(box);
		const offSkills = section(off.system, "skills");
		expect(offSkills).toContain('<skill name="agents-demo">');
		expect(offSkills, "the skill tool loads skills, so the list carries no SKILL.md path").not.toContain(agentsSkill);
		expect(off.system, "Claude skill is absent while its harness is off").not.toContain("claude-demo");
		expect(off.system, "a skill body loads on demand").not.toContain("BODY-agents-demo");
		const before = harnessesLine(off.system);
		expect(before, "the prompt has a Harnesses: line").not.toBe("");
		expect(stateOf(before, ".agents"), before).toBe("on");
		// Off harnesses (Claude Code holds a skill) and empty ones are left out: nothing in them reaches the session.
		for (const label of ["Claude Code", "Codex", "Cursor"]) expect(stateOf(before, label), before).toBeUndefined();
		expect(before).not.toMatch(/\boff\b|nothing found/);

		enableHarnesses(box, "claude", "cursor");
		const on = await firstRequest(box);
		const onSkills = section(on.system, "skills");
		expect(onSkills).toContain("agents-demo");
		expect(onSkills, "Claude skill listed once harness:claude is on").toContain("claude-demo");
		const after = harnessesLine(on.system);
		expect(stateOf(after, "Claude Code"), after).toBe("on");
		// Cursor is on but its folders are empty; Codex stays off.
		expect(stateOf(after, "Cursor"), after).toBeUndefined();
		expect(stateOf(after, "Codex"), after).toBeUndefined();
		expect(stateOf(after, ".agents"), after).toBe("on");
	});

	it("2b: the base file is used when there is no override, CLAUDE.md is ignored, and a project-level harness:claude toggle in .octocode/settings.json lists the project's .claude skill", async () => {
		const box = sandbox(endpoint);
		write(path.join(box.project, "AGENTS.md"), "AGENTS-BASE-MARKER\n");
		write(path.join(box.project, "CLAUDE.md"), "CLAUDE-MD-MARKER\n");
		skillFile(box, ".claude", "claude-demo");
		write(
			path.join(box.project, ".octocode", "settings.json"),
			JSON.stringify({ toggles: { "harness:claude": true } }),
		);
		const { system } = await firstRequest(box);
		expect(system).toContain("AGENTS-BASE-MARKER");
		expect(system).not.toContain("CLAUDE-MD-MARKER");
		expect(section(system, "skills"), "project toggle reaches the project's own Claude skills").toContain(
			"claude-demo",
		);
		expect(harnessesLine(system), "a harness switched on only by a project key reads as on for this project").toMatch(
			/Claude Code on/,
		);
	});

	it("4: a subagent's first request lists the user's skills and its catalog of the parent's bundled ones, no coordinator-only ones, and no harnesses line", async () => {
		const box = sandbox(endpoint);
		skillFile(box, ".agents", "agents-demo");
		skillFile(box, ".claude", "claude-demo");
		enableHarnesses(box, "codex");
		const child: Step[] = [{ text: "child done" }];
		const steps: Step[] = [
			{ tool: "agent", args: { type: "task", background: false, goal: "report", task: script(child) } },
			{ text: "read its report" },
		];
		const run = box.start(["-p", script(steps)]);
		const { code } = await run.exited;
		expect(code, run.stderr()).toBe(0);
		const childSource = script(child).slice("B64SCRIPT:".length);
		const parent = endpoint.requests.find((request) => !request.script.includes(childSource));
		const kid = endpoint.requests.find((request) => request.script === childSource);
		expect(parent, "parent request").toBeDefined();
		expect(kid, "the subagent sent a model request").toBeDefined();
		expect(COORDINATOR_ONLY, "native skills marked audience: coordinator").toContain("octocode-backlog");
		expect(skillNames(parent!.system)).toEqual(expect.arrayContaining(COORDINATOR_ONLY));
		// A role's catalog narrows only the bundled skills: the project's own `agents-demo` stays listed.
		expect(skillNames(kid!.system)).toEqual(
			skillNames(parent!.system).filter(
				(name) => !COORDINATOR_ONLY.includes(name) && (GENERAL_CATALOG.includes(name) || name === "agents-demo"),
			),
		);
		expect(section(kid!.system, "skills")).toContain("agents-demo");
		expect(kid!.system).not.toContain("claude-demo");
		// Only the main session can run /harness, so only its prompt names the harnesses (src/octocode/turn.ts).
		expect(stateOf(harnessesLine(parent!.system), ".agents")).toBe("on");
		expect(harnessesLine(kid!.system), "a child's prompt has no Harnesses: line").toBe("");
		expect(kid!.system).not.toContain("/harness");
	});
});

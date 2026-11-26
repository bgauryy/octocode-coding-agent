import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getNativeDir } from "../../src/config.ts";
import { buildSystemPromptSections, diffSystemPromptSections } from "../../src/core/system-prompt.ts";
import { SkillCatalog } from "../../src/octocode/skill/catalog.ts";
import { SUBAGENTS_SKILL } from "../../src/octocode/skill/first-use.ts";
import { registerTurnSetup } from "../../src/octocode/turn.ts";
import { fakeHost } from "./fake-host.ts";
import { allSections } from "./helpers.ts";

/**
 * The rules for running children and using their reports (`policy/children.md`) are present from the first request of
 * every main session with the `agent` tool. Starting or messaging an agent must not rewrite the leading system prompt.
 */
type Sections = Record<string, string>;
const options = (selectedTools: string[]) => ({
	systemPromptOptions: { sections: {} as Sections, baseSections: {} as Sections, selectedTools },
});

/** A catalog holding only the subagents skill, loadable by the model or reserved for the user. */
const catalogWith = (disableModelInvocation: boolean) =>
	new SkillCatalog(
		() =>
			({
				version: 1,
				explicitSkills: [],
				resources: [
					{
						skill: { name: SUBAGENTS_SKILL, description: "d", filePath: "/s/SKILL.md", disableModelInvocation },
						canonicalPath: "/s/SKILL.md",
						visible: true,
					},
				],
			}) as never,
	);

function session(isSubagent = false, skillCatalog?: SkillCatalog) {
	const fake = fakeHost();
	const turn = registerTurnSetup(fake.api, { isSubagent, profiles: () => new Map(), skillCatalog });
	let run = options(["bash", "file", "agent"]);
	return {
		turn,
		/** A run starts: the sections `before_agent_start` writes. */
		async start(ctx: unknown = {}, selectedTools = ["bash", "file", "agent"]): Promise<Sections> {
			run = options(selectedTools);
			await fake.emit("before_agent_start", run, ctx);
			return allSections(run);
		},
		/** The model calls a tool. */
		call: (toolName: string, input: unknown) => fake.emit("tool_call", { type: "tool_call", toolName, input }, {}),
		/** The next request of the same run: the run's options, as `turn_prompt` receives them. */
		async next(): Promise<Sections> {
			await fake.emit("turn_prompt", { type: "turn_prompt", systemPromptOptions: run.systemPromptOptions }, {});
			return allSections(run);
		},
	};
}

const assistantCall = (args: Record<string, unknown>) => ({
	type: "message",
	message: { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "agent", arguments: args }] },
});
const resumed = (entries: unknown[]) => ({ sessionManager: { getEntries: () => entries } });

describe("the children section", () => {
	it("is present before the first delegation and stays byte-identical across turns and runs", async () => {
		const s = session();
		const first = await s.start();
		expect(first.children).toBeTruthy();
		await s.call("bash", { command: "ls" });
		await s.call("agent", { type: "coordinate", action: "list", reason: "who is here" });
		expect((await s.next()).children).toBe(first.children);
		expect((await s.start()).children).toBe(first.children);
	});

	it.each([
		["a child task", { type: "task", goal: "g", task: "t" }],
		["a batch of tasks", { type: "task", tasks: [{ goal: "g", task: "t" }] }],
		["a message to an agent", { type: "message", to: "peer", message: "m" }],
		["an outside agent", { type: "external", externalAction: "prompt", promptText: "p" }],
		["a legacy envelope", { type: "task", input: { goal: "g", task: "t" } }],
		["a call without a type", { goal: "g" }],
	])("does not change the prompt after %s", async (_name, input) => {
		const s = session();
		const first = await s.start();
		await s.call("agent", input);
		const next = await s.next();
		expect(next).toEqual(first);
		expect((await s.start()).children).toBe(first.children);
		const patch = diffSystemPromptSections(
			buildSystemPromptSections({ cwd: "/w", sections: first }),
			buildSystemPromptSections({ cwd: "/w", sections: next }),
		);
		expect(patch).toBeUndefined();
	});

	it("does not depend on earlier session entries", async () => {
		const s = session();
		const empty = await s.start(resumed([]));
		expect(empty.children).toBeTruthy();
		expect((await s.start(resumed([assistantCall({ type: "task", goal: "g", task: "t" })]))).children).toBe(
			empty.children,
		);
	});

	it("keeps the same bytes after a reset", async () => {
		const s = session();
		const first = await s.start();
		await s.call("agent", { type: "task", goal: "g", task: "t" });
		s.turn.reset();
		expect((await s.start(resumed([]))).children).toBe(first.children);
		s.turn.reset();
		expect((await s.start(resumed([assistantCall({ type: "task", goal: "g", task: "t" })]))).children).toBe(
			first.children,
		);
	});

	it("leaves the report rules to the subagents skill only when the model can load it", async () => {
		const rule = "Answer child questions at once.";
		const loadable = await session(false, catalogWith(false)).start();
		expect(loadable.children).toBeTruthy();
		expect(loadable.children).not.toContain(rule);
		expect(fs.readFileSync(path.join(getNativeDir(), "skills", SUBAGENTS_SKILL, "SKILL.md"), "utf8")).toContain(rule);
		for (const catalog of [catalogWith(true), new SkillCatalog(() => ({ version: 1, explicitSkills: [], resources: [] }) as never), undefined])
			expect((await session(false, catalog).start()).children).toContain(rule);
	});

	it("is never sent where the rules do not apply: a subagent, or a session without the agent tool", async () => {
		const child = session(true);
		expect((await child.start()).children ?? "").toBe("");
		await child.call("agent", { type: "message", to: "parent", message: "m" });
		expect((await child.next()).children ?? "").toBe("");

		const bare = session();
		expect((await bare.start({}, ["bash"])).children ?? "").toBe("");
		await bare.call("agent", { type: "task", goal: "g", task: "t" });
		expect((await bare.next()).children ?? "").toBe("");
	});
});

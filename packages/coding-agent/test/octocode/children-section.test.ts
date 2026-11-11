import { describe, expect, it } from "vitest";
import { instructionSource } from "../../src/core/prompt-template.ts";
import { buildSystemPromptSections, diffSystemPromptSections } from "../../src/core/system-prompt.ts";
import { octocodePrompt, octocodePromptSections } from "../../src/octocode/instructions/policy.ts";
import { registerTurnSetup } from "../../src/octocode/turn.ts";
import { fakeHost } from "./fake-host.ts";
import { allSections } from "./helpers.ts";

/**
 * The rules for running children and using their reports (`policy/children.md`) are sent once, as the `children`
 * section, from the session's first `agent` call that starts a child or messages an agent. These tests show the text
 * reaches the model in every case where it applies: in the request that reads that call's result, in every later
 * request, and in a resumed session whose entries hold such a call.
 */
const HEADING = "## Run children and use reports";
const RULES = [
	"you own the result: never predict a pending result.",
	"A child near its request limit may ask for more",
	"A report is a claim: read its `Noticed` line first",
	"| `blocked` |",
	"| `partial` |",
	"| `failed` |",
	"A fresh reviewer, not the author, checks a risky change.",
];

type Sections = Record<string, string>;
const options = (selectedTools: string[]) => ({
	systemPromptOptions: { sections: {} as Sections, baseSections: {} as Sections, selectedTools },
});

function session(isSubagent = false) {
	const fake = fakeHost();
	const turn = registerTurnSetup(fake.api, { isSubagent, profiles: () => new Map() });
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
	it("holds the whole run-and-report block, which the delegation section no longer repeats", () => {
		const before = octocodePromptSections({ research: undefined, profiles: [], canDelegate: true });
		const after = octocodePromptSections({ research: undefined, profiles: [], canDelegate: true, childStarted: true });
		expect(before.children).toBe("");
		expect(after.children.startsWith(HEADING)).toBe(true);
		for (const rule of RULES) {
			expect(after.children, rule).toContain(rule);
			expect(before.delegation, rule).not.toContain(rule);
		}
		// Only the new section differs, so the patch that sends it rewrites nothing else.
		expect({ ...after, children: "" }).toEqual(before);
		// The complete policy (SDK consumers, prompt inspection) still carries the rules.
		expect(octocodePrompt({ research: undefined, profiles: [], canDelegate: true })).toContain(after.children);
		// Every bullet and table row of the source file is rendered: nothing was lost in the move.
		for (const line of instructionSource("policy/children.md").split("\n")) {
			if (line.includes("{{") || line.trim() === "") continue;
			expect(after.children, line).toContain(line);
		}
	});

	it("is absent until the session delegates, and `coordinate` calls do not send it", async () => {
		const s = session();
		expect((await s.start()).children ?? "").toBe("");
		await s.call("bash", { command: "ls" });
		await s.call("agent", { type: "coordinate", action: "list", reason: "who is here" });
		expect((await s.next()).children ?? "").toBe("");
		expect((await s.start()).children ?? "").toBe("");
	});

	it.each([
		["a child task", { type: "task", goal: "g", task: "t" }],
		["a batch of tasks", { type: "task", tasks: [{ goal: "g", task: "t" }] }],
		["a message to an agent", { type: "message", to: "peer", message: "m" }],
		["an outside agent", { type: "external", externalAction: "prompt", promptText: "p" }],
		["a legacy envelope", { type: "task", input: { goal: "g", task: "t" } }],
		["a call without a type", { goal: "g" }],
	])("reaches the request that reads the result of %s, and every later one", async (_name, input) => {
		const s = session();
		const first = await s.start();
		expect(first.children ?? "").toBe("");
		await s.call("agent", input);
		// Same run, next request: the rules arrive with the tool result.
		const next = await s.next();
		for (const rule of RULES) expect(next.children, rule).toContain(rule);
		expect(next.delegation).toBe(first.delegation);
		// Later requests of the run and later runs keep the same bytes, so nothing is sent twice.
		expect((await s.next()).children).toBe(next.children);
		const later = await s.start();
		expect(later.children).toBe(next.children);
		expect((await s.next()).children).toBe(next.children);
		// As a section patch: the first request's sections stay byte for byte, and one section is added.
		const patch = diffSystemPromptSections(
			buildSystemPromptSections({ cwd: "/w", sections: first }),
			buildSystemPromptSections({ cwd: "/w", sections: later }),
		);
		expect(Object.keys(patch ?? {})).toEqual(["children"]);
	});

	it("is sent by the run that follows when the call was the run's last step", async () => {
		const s = session();
		await s.start();
		await s.call("agent", { type: "task", goal: "g", task: "t" });
		// No further request in that run (aborted): the child's report starts the next run.
		for (const rule of RULES) expect((await s.start()).children, rule).toContain(rule);
	});

	it("is present from the first request of a resumed session that delegated before", async () => {
		for (const args of [
			{ type: "task", goal: "g", task: "t" },
			{ type: "message", to: "peer", message: "m" },
			{ type: "task", input: { goal: "g", task: "t" } },
		]) {
			const s = session();
			const sections = await s.start(
				resumed([{ type: "message", message: { role: "user", content: "hi" } }, assistantCall(args)]),
			);
			for (const rule of RULES) expect(sections.children, rule).toContain(rule);
		}
		// A session that only coordinated has nothing to wait on.
		const solo = session();
		const entries = [assistantCall({ type: "coordinate", action: "lock", paths: ["a.ts"] })];
		expect((await solo.start(resumed(entries))).children ?? "").toBe("");
	});

	it("starts over with a new session and reads that session's entries", async () => {
		const s = session();
		await s.start();
		await s.call("agent", { type: "task", goal: "g", task: "t" });
		expect((await s.next()).children).toContain(HEADING);
		s.turn.reset();
		expect((await s.start(resumed([]))).children ?? "").toBe("");
		s.turn.reset();
		expect((await s.start(resumed([assistantCall({ type: "task", goal: "g", task: "t" })]))).children).toContain(
			HEADING,
		);
	});

	it("is never sent where the rules do not apply: a subagent, or a session without the agent tool", async () => {
		const child = session(true);
		await child.start();
		await child.call("agent", { type: "message", to: "parent", message: "m" });
		expect((await child.next()).children ?? "").toBe("");
		expect((await child.start()).children ?? "").toBe("");

		const bare = session();
		await bare.start({}, ["bash"]);
		await bare.call("agent", { type: "task", goal: "g", task: "t" });
		expect((await bare.next()).children ?? "").toBe("");
	});
});

import "../mcp-host.ts";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { captureSkillResourceSnapshot } from "../../src/core/skill-resource-snapshot.ts";
import { loadSkillsFromDir } from "../../src/core/skills.ts";
import { LOADED_SKILLS_DETAILS } from "../../src/octocode/compaction/loaded-skills.ts";
import { registerSkillFirstUse } from "../../src/octocode/skill/first-use.ts";
import { registerSkillTool } from "../../src/octocode/native/tools/skill/tool.ts";
import { withNativePermissionOwners } from "../../src/octocode/permission/native-tools.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

type Part = { type: string; text?: string };
type Result = { content: Part[]; details?: Record<string, unknown> } | undefined;

/** Skills under a temp folder: the two the delivery covers, and one only the user may run. */
function setup(options: { names?: string[]; systemPrompt?: string; sessionId?: string; reserved?: boolean } = {}) {
	const root = fs.realpathSync(tmp("skill-first-use-"));
	for (const name of options.names ?? ["octocode-subagents", "octocode-backlog"]) {
		const dir = path.join(root, name);
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(
			path.join(dir, "SKILL.md"),
			`---\nname: ${name}\ndescription: Use for ${name} work.\n${options.reserved ? "disable-model-invocation: true\n" : ""}---\n# ${name}\n\nRULES_OF_${name}\n`,
		);
	}
	const hidden = path.join(root, "hidden");
	fs.mkdirSync(hidden);
	fs.writeFileSync(
		path.join(hidden, "SKILL.md"),
		"---\nname: octocode-reserved\ndescription: User only.\ndisable-model-invocation: true\n---\nRESERVED\n",
	);
	const snapshot = captureSkillResourceSnapshot(loadSkillsFromDir({ dir: root, source: "test" }));
	const fp = fakeHost();
	(fp.api.resources as { getSkillResourceSnapshot: () => unknown }).getSkillResourceSnapshot = () => snapshot;
	const catalog = registerSkillTool(withNativePermissionOwners(fp.api));
	registerSkillFirstUse(fp.api, catalog);
	const branch: Array<Record<string, unknown>> = [];
	let sessionId = options.sessionId ?? "session-1";
	const ctx = {
		...fakeCtx({ cwd: root }),
		sessionManager: { getBranch: () => branch, getSessionId: () => sessionId },
		getSystemPrompt: () => options.systemPrompt ?? "SYSTEM",
	};
	/** Runs a tool result through the hook and records the outcome on the branch, as the session does. */
	const result = async (toolName: string, input: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
		const event = {
			type: "tool_result",
			toolCallId: "c",
			toolName,
			input,
			isError: false,
			details: undefined,
			...extra,
		};
		const content: Part[] = [{ type: "text", text: "OUTPUT" }];
		const changed = (await fp.fire("tool_result", { ...event, content }, ctx)) as Result;
		branch.push({
			type: "message",
			message: { role: "toolResult", toolName, isError: extra.isError === true, details: changed?.details },
		});
		return changed;
	};
	const texts = (value: Result) => (value?.content ?? []).map((part) => part.text ?? "").join("\n");
	return {
		fp,
		branch,
		ctx,
		result,
		texts,
		newSession: (id: string) => {
			sessionId = id;
			branch.length = 0;
		},
	};
}

const START = { type: "task", task: "do it", goal: "g" };
const ADD = { op: "add", items: [{ title: "t", goal: "g", why: "w" }] };

describe("first-use skill delivery", () => {
	it("appends octocode-subagents to the first child start, after the tool's own output, once", async () => {
		const { result, texts } = setup();
		const first = await result("agent", START);
		expect(first?.content[0]).toEqual({ type: "text", text: "OUTPUT" });
		expect(texts(first)).toContain('<skill name="octocode-subagents"');
		expect(texts(first)).toContain("RULES_OF_octocode-subagents");
		expect(first?.details?.[LOADED_SKILLS_DETAILS]).toEqual([
			{ name: "octocode-subagents", location: expect.stringContaining("octocode-subagents") },
		]);
		expect(await result("agent", START)).toBeUndefined();
		expect(await result("agent", { ...START, resume: "x" })).toBeUndefined();
	});

	it("appends octocode-backlog to the first backlogPlan add or edit, once", async () => {
		const { result, texts } = setup();
		expect(await result("backlogPlan", { op: "list" })).toBeUndefined();
		const first = await result("backlogPlan", { op: "edit", items: [{ id: "B1", priority: 1 }] });
		expect(texts(first)).toContain("RULES_OF_octocode-backlog");
		expect(texts(first)).not.toContain("octocode-subagents");
		expect(await result("backlogPlan", ADD)).toBeUndefined();
	});

	it("delivers each skill on its own first use", async () => {
		const { result, texts } = setup();
		expect(texts(await result("agent", START))).toContain("RULES_OF_octocode-subagents");
		expect(texts(await result("backlogPlan", ADD))).toContain("RULES_OF_octocode-backlog");
	});

	it("does not deliver for other agent types, other tools, failures or nested calls", async () => {
		const { result } = setup();
		expect(await result("agent", { type: "message", to: "parent", message: "hi" })).toBeUndefined();
		expect(await result("agent", { type: "coordinate", action: "list" })).toBeUndefined();
		expect(await result("backlog", { op: "get", id: "B1" })).toBeUndefined();
		expect(await result("agent", START, { isError: true })).toBeUndefined();
		expect(await result("backlogPlan", ADD, { parentToolCallId: "p" })).toBeUndefined();
		// None of those counted as the first use.
		expect(await result("agent", START)).toBeDefined();
	});

	it("does not load a skill the session loaded with the skill tool", async () => {
		const { fp, ctx, branch, result } = setup();
		const loaded = (await fp.tools
			.get("skill")
			.execute("s1", { name: "octocode-subagents", reason: "r" }, undefined, undefined, ctx)) as {
			details: unknown;
		};
		branch.push({ type: "message", message: { role: "toolResult", toolName: "skill", details: loaded.details } });
		expect(await result("agent", START)).toBeUndefined();
		// The other skill is still delivered.
		expect(await result("backlogPlan", ADD)).toBeDefined();
	});

	it("does not load a skill the user expanded with /skill: or a task inlined", async () => {
		const { branch, result } = setup();
		branch.push({
			type: "message",
			message: {
				role: "user",
				content: '<skill name="octocode-backlog" location="/x/SKILL.md">\nBODY\n</skill>',
			},
		});
		expect(await result("backlogPlan", ADD)).toBeUndefined();
	});

	it("does not load a skill the system prompt carries (a role's skills in a subagent)", async () => {
		const { result } = setup({
			systemPrompt: 'role\n<skill name="octocode-subagents" location="/x/SKILL.md">\nBODY\n</skill>',
		});
		expect(await result("agent", START)).toBeUndefined();
	});

	it("counts a skill a compaction carried as loaded", async () => {
		const { branch, result } = setup();
		branch.push({
			type: "compaction",
			details: { [LOADED_SKILLS_DETAILS]: [{ name: "octocode-subagents", location: "/x/SKILL.md" }] },
		});
		expect(await result("agent", START)).toBeUndefined();
	});

	it("delivers again in a new session, not twice in one", async () => {
		const { result, newSession } = setup();
		expect(await result("agent", START)).toBeDefined();
		newSession("session-2");
		expect(await result("agent", START)).toBeDefined();
		expect(await result("agent", START)).toBeUndefined();
	});

	it("stays quiet when the session has no such skill or the user reserved it", async () => {
		const { result } = setup({ names: [] });
		expect(await result("agent", START)).toBeUndefined();
		expect(await result("backlogPlan", ADD)).toBeUndefined();
	});

	it("leaves a skill reserved for the user alone", async () => {
		const { result } = setup({ reserved: true });
		expect(await result("agent", START)).toBeUndefined();
	});

	it("does not deliver one start's skill twice when a batch's results are recorded together", async () => {
		const { fp, ctx } = setup();
		const fire = (id: string) =>
			fp.fire(
				"tool_result",
				{
					type: "tool_result",
					toolCallId: id,
					toolName: "agent",
					input: START,
					isError: false,
					details: undefined,
					content: [{ type: "text", text: "OUTPUT" }],
				},
				ctx,
			);
		expect(await fire("a")).toBeDefined();
		expect(await fire("b")).toBeUndefined();
	});
});

import { beforeAll, describe, expect, it } from "vitest";
import { hookCalls } from "../../src/octocode/hooks/config/calls.ts";
import octocode from "../../src/octocode/index.ts";
import { initializeBashSyntax } from "../../src/octocode/permission/bash-syntax.ts";
import { evaluateSourcePolicy } from "../../src/octocode/permission/source-policy.ts";
import { parseSourcePolicy } from "../../src/octocode/permission/source-policy/rules.ts";
import { fakeCtx, fakeHost, theme } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

beforeAll(initializeBashSyntax);

async function mainSession() {
	const fake = fakeHost();
	await octocode(fake.api);
	return { fake, agent: fake.tools.get("agent")!, ctx: fakeCtx({ cwd: tmp() }) };
}

describe("agent with flat fields in a main session", () => {
	it("declares every type's fields at the top level under public names, and models as its own tool", async () => {
		const { fake, agent } = await mainSession();
		const properties = agent.parameters.properties as Record<string, { description?: string }>;
		expect(properties.type).toMatchObject({ enum: ["coordinate", "message", "task", "external"] });
		for (const field of ["externalAction", "connection", "externalModel", "promptText", "subagent", "joinGoal"])
			expect(properties[field]?.description).toMatch(/^Only for: (external|coordinate)\./);
		for (const gone of ["input", "query", "check", "scope", "id", "text"]) expect(properties).not.toHaveProperty(gone);
		expect(properties.task.description).toMatch(/^Only for: task\./);
		expect(agent.promptSnippet).not.toContain("model");
		const models = fake.tools.get("models")!;
		expect(models.promptSnippet).toMatch(/^[^\n]+$/);
		expect(models.parameters.required).toEqual(["reason"]);
	});

	it("runs coordinate and refuses fields of another type or the old envelope", async () => {
		const { agent, ctx } = await mainSession();
		const listed = await agent.execute(
			"c1",
			{ type: "coordinate", action: "list", reason: "who" },
			undefined,
			undefined,
			ctx,
		);
		expect(listed.details).toMatchObject({ agentType: "coordinate" });
		await expect(
			agent.execute("c2", { type: "coordinate", action: "list", to: "parent" }, undefined, undefined, ctx),
		).rejects.toThrow("agent type coordinate does not take to (only for message)");
		await expect(agent.execute("c3", { type: "external", action: "list" }, undefined, undefined, ctx)).rejects.toThrow(
			"does not take action (only for coordinate)",
		);
		await expect(
			agent.execute("c4", { type: "task", goal: "g", profile: "reviewer" }, undefined, undefined, ctx),
		).rejects.toThrow("Invalid agent task call");
		await expect(
			agent.execute("c5", { type: "coordinate", input: { action: "list" } }, undefined, undefined, ctx),
		).rejects.toThrow("no input envelope");
	});

	it("renders flat calls and old envelope transcripts with the mode's own row", async () => {
		const { agent } = await mainSession();
		const row = (args: Record<string, unknown>) => agent.renderCall(args, theme, { args }).render(120).join("\n");
		expect(row({ type: "coordinate", action: "stop", subagent: "kid-1", reason: "r" })).toMatch(
			/Coordinate.*stop kid-1/,
		);
		expect(row({ type: "coordinate", input: { action: "stop", id: "kid-1" } })).toMatch(/Coordinate.*stop kid-1/);
	});
});

describe("permission and hook policy for flat agent calls", () => {
	const source = { path: "/home/test/.claude/settings.json", anchor: "/home/test/.claude" };
	const decide = (rule: string, input: Record<string, unknown>) =>
		evaluateSourcePolicy(
			parseSourcePolicy({ permissions: { deny: [rule] } }, source),
			{ toolName: "agent", input, toolCallId: "one", active: true },
			"/work",
		).decision;

	it("matches each type's rule name and the task's own arguments", () => {
		const task = { type: "task", goal: "g", task: "t", profile: "reviewer", reason: "r" };
		expect(decide("Agent(reviewer)", task)).toBe("deny");
		expect(decide("Agent(researcher)", task)).toBe("none");
		expect(decide("agent.external", { type: "external", externalAction: "list", reason: "r" })).toBe("deny");
		expect(decide("agent.message", { type: "message", to: "parent", message: "m", reason: "r" })).toBe("deny");
		expect(decide("agent.coordinate", { type: "coordinate", action: "list", reason: "r" })).toBe("deny");
		expect(decide("agent.coordinate", { type: "message", to: "parent", reason: "r" })).toBe("none");
		// An old envelope reads the same.
		expect(decide("Agent(reviewer)", { type: "task", input: { profile: "reviewer" } })).toBe("deny");
	});

	it("gives hooks the public flat call as Claude Code's Task", () => {
		const input = { type: "task", goal: "g", task: "t", reason: "r" };
		expect(hookCalls("agent", input, "/work")).toEqual([
			{ names: ["agent", "Task"], tool_name: "agent", tool_input: input },
		]);
	});
});

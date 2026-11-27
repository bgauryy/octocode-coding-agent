import { Type, type TSchema } from "typebox";
import { Check } from "typebox/value";
import { describe, expect, it, vi } from "vitest";
import { anthropicToolSchema } from "../../../ai/src/api/ai-sdk/anthropic-map.ts";
import { capturePayload as bedrockPayload } from "../../../ai/test/bedrock-convert-fixture.ts";
import { googleToolWire as googleTools } from "../../../ai/test/google-fetch-fixture.ts";
import { getCompat } from "../../../ai/src/api/openai-completions/compat.ts";
import { convertTools as completionTools } from "../../../ai/src/api/openai-completions/tools.ts";
import { convertResponsesTools } from "../../../ai/src/api/openai-responses-shared/tools.ts";
import { validateToolArguments } from "../../../ai/src/utils/validation.ts";
import { agentModes } from "../../src/octocode/native/tools/agent/tool.ts";
import { withNativePermissionOwners } from "../../src/octocode/permission/native-tools.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";

/** Each mode with fields of its own; external's `text` and coordinate's `id` take their public names. */
const registrations = [
	["agent", "task", { task: Type.String({ description: "brief" }) }],
	["externalAgent", "external", { action: Type.String(), text: Type.Optional(Type.String()) }],
	[
		"coordinate",
		"coordinate",
		{ action: Type.String(), id: Type.Optional(Type.String()), reason: Type.Optional(Type.String()) },
	],
	["sendMessage", "message", { to: Type.String() }],
] as const;

function unified() {
	const modes = agentModes();
	const execute = vi.fn(async (..._args: unknown[]) => ({ content: [], details: {} }));
	for (const [name, , properties] of registrations)
		modes.collect({ name, label: name, description: name, parameters: Type.Object(properties), execute });
	const fake = fakeHost();
	modes.register(withNativePermissionOwners(fake.api));
	return { tool: fake.tools.get("agent")!, execute };
}

const compat = getCompat({
	api: "openai-completions",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 8192,
	id: "test",
	name: "Test",
});

const valid = [
	{ type: "task", task: "do it", reason: "delegate" },
	{ type: "external", externalAction: "prompt", promptText: "hi", reason: "ask the peer" },
	{ type: "coordinate", action: "stop", subagent: "kid", reason: "stop it" },
	{ type: "message", to: "parent", reason: "tell" },
];

describe("flat agent schema", () => {
	it("shares only paths between task and coordinate, marked for each, and still refuses it on another type", async () => {
		const modes = agentModes();
		const execute = vi.fn(async (..._args: unknown[]) => ({ content: [], details: {} }));
		const paths = (description: string) => Type.Optional(Type.Array(Type.String(), { description }));
		const fields = {
			agent: { task: Type.String(), paths: paths("reserved for the child") },
			coordinate: { action: Type.String(), paths: paths("lock these") },
			sendMessage: { to: Type.String() },
		};
		for (const [name, properties] of Object.entries(fields))
			modes.collect({ name, label: name, description: name, parameters: Type.Object(properties), execute });
		const fake = fakeHost();
		modes.register(withNativePermissionOwners(fake.api));
		const tool = fake.tools.get("agent")!;
		const schema = tool.parameters as { properties: Record<string, { description?: string }> };
		expect(schema.properties.paths?.description).toBe("task: reserved for the child; coordinate: lock these");
		const call = (args: Record<string, unknown>) =>
			tool.execute("c", args, undefined, undefined, fakeCtx({ cwd: "/" }));
		await call({ type: "task", task: "t", paths: ["a.ts"], reason: "r" });
		await call({ type: "coordinate", action: "lock", paths: ["a.ts"], reason: "r" });
		expect(execute).toHaveBeenCalledTimes(2);
		await expect(call({ type: "message", to: "x", paths: ["a.ts"], reason: "r" })).rejects.toThrow(
			"agent type message does not take paths (only for task, coordinate).",
		);
		// Any other shared name still fails registration.
		const clash = agentModes();
		const twice = { to: Type.String() };
		clash.collect({ name: "agent", label: "a", description: "a", parameters: Type.Object(twice), execute });
		clash.collect({ name: "sendMessage", label: "m", description: "m", parameters: Type.Object(twice), execute });
		expect(() => clash.register(withNativePermissionOwners(fakeHost().api))).toThrow(
			"agent field to is declared by task and message; rename one.",
		);
	});

	it("declares one flat object: type, each mode's fields marked with their type, and the call reason", () => {
		const { tool } = unified();
		const schema = tool.parameters as { properties: Record<string, { description?: string }> };
		expect(schema).toMatchObject({ type: "object", required: ["type", "reason"], additionalProperties: false });
		expect(schema).not.toHaveProperty("anyOf");
		// The call reason is first (registration moves the tool's own definition there).
		expect(Object.keys(schema.properties)).toEqual([
			"reason",
			"type",
			"task",
			"externalAction",
			"promptText",
			"action",
			"subagent",
			"to",
			"tasks",
			"messages",
		]);
		expect(schema.properties.task.description).toBe("task: brief");
		expect(schema.properties.to.description).toBe("message only");
		expect(schema.properties.subagent.description).toBe("coordinate only");
		expect(JSON.parse(JSON.stringify(schema.properties.reason))).toEqual({ type: "string" });
		expect(JSON.stringify(schema)).not.toContain('"input"');
		for (const args of valid) expect(Check(tool.parameters, args)).toBe(true);
		expect(Check(tool.parameters, { type: "message", input: { to: "parent" }, reason: "old" })).toBe(false);
		expect(Check(tool.parameters, { type: "message", to: "parent" })).toBe(false);
	});

	it("leaves out starter-only interrupt for a session without the task type", () => {
		const build = (names: string[]) => {
			const modes = agentModes();
			for (const [name, , properties] of registrations)
				if (names.includes(name))
					modes.collect({
						name,
						label: name,
						description: name,
						parameters: Type.Object({
							...properties,
							...(name === "sendMessage" ? { interrupt: Type.Optional(Type.Boolean({ description: "stop" })) } : {}),
						}),
						execute: vi.fn(),
					});
			const fake = fakeHost();
			modes.register(fake.api);
			return fake.tools.get("agent")!;
		};
		const main = build(["agent", "coordinate", "sendMessage"]);
		const child = build(["coordinate", "sendMessage"]);
		const fields = (tool: { parameters: unknown }) =>
			Object.keys((tool.parameters as { properties: object }).properties);
		expect(fields(main)).toContain("interrupt");
		expect(fields(child)).not.toContain("interrupt");
	});

	it("fails registration when two modes would share a public field", () => {
		const modes = agentModes();
		for (const name of ["agent", "sendMessage"])
			modes.collect({
				name,
				label: name,
				description: name,
				parameters: Type.Object({ to: Type.String() }),
				execute: vi.fn(),
			});
		expect(() => modes.register(fakeHost().api)).toThrow("agent field to is declared by task and message");
	});

	it("keeps the same flat object in every provider projection", async () => {
		const { tool } = unified();
		const responses = convertResponsesTools([tool])[0];
		const completions = completionTools([tool], compat)[0];
		const bedrock = (await bedrockPayload({
			messages: [{ role: "user", content: "go", timestamp: 0 }],
			tools: [tool],
		})) as { toolConfig: { tools: { toolSpec: { inputSchema: { json: unknown } } }[] } };
		if (responses.type !== "function" || completions.type !== "function") throw new Error("not a function tool");
		const schemas = [
			responses.parameters,
			completions.function.parameters,
			(await googleTools([tool]))![0].functionDeclarations[0].parametersJsonSchema,
			anthropicToolSchema(tool, false).schema,
			bedrock.toolConfig.tools[0].toolSpec.inputSchema.json,
		] as TSchema[];
		for (const schema of schemas) {
			for (const keyword of ["anyOf", "oneOf", "allOf"]) expect(schema).not.toHaveProperty(keyword);
			for (const args of valid) expect(Check(schema, args)).toBe(true);
		}
	});

	it("refuses another type's fields and the old envelope before any mode runs", async () => {
		const { tool, execute } = unified();
		const ctx = fakeCtx({ cwd: process.cwd() });
		const cases: [Record<string, unknown>, string][] = [
			[{ type: "message", to: "parent", task: "x" }, "agent type message does not take task (only for task)"],
			[{ type: "external", action: "list" }, "agent type external does not take action (only for coordinate)"],
			[{ type: "message", input: { to: "parent" } }, "no input envelope"],
			[{ type: "models" }, "Unknown agent type models"],
			[{ type: "task" }, "Invalid agent task call"],
		];
		for (const [args, error] of cases)
			await expect(tool.execute("c", args, undefined, undefined, ctx)).rejects.toThrow(error);
		const envelope = { type: "message", input: {}, reason: "r" };
		expect(() =>
			validateToolArguments(tool, { type: "toolCall", id: "c", name: "agent", arguments: envelope }),
		).toThrow();
		expect(execute).not.toHaveBeenCalled();
	});

	it("hands each mode its own argument names, and coordinate the call reason as its lock note", async () => {
		const { tool, execute } = unified();
		const ctx = fakeCtx({ cwd: process.cwd() });
		const seen = async (args: Record<string, unknown>) => {
			const result = await tool.execute("c", args, undefined, undefined, ctx);
			return { input: execute.mock.lastCall?.[1], type: (result.details as { agentType: string }).agentType };
		};
		expect(await seen(valid[0])).toEqual({ input: { task: "do it" }, type: "task" });
		expect(await seen(valid[1])).toEqual({ input: { action: "prompt", text: "hi" }, type: "external" });
		expect(await seen(valid[2])).toEqual({
			input: { action: "stop", id: "kid", reason: "stop it" },
			type: "coordinate",
		});
		expect(await seen(valid[3])).toEqual({ input: { to: "parent" }, type: "message" });
	});
});

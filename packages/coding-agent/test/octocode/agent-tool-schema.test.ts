import { Type, type TSchema } from "typebox";
import { Check } from "typebox/value";
import { describe, expect, it, vi } from "vitest";
import { convertTools as anthropicTools } from "../../../ai/src/api/anthropic-messages/tools.ts";
import { convertToolConfig } from "../../../ai/src/api/bedrock-converse-stream/convert.ts";
import { resolveJsonSchemaStrictSampling } from "../../../ai/src/api/constrained-sampling.ts";
import { convertTools as googleTools } from "../../../ai/src/api/google-shared/tools.ts";
import { getCompat } from "../../../ai/src/api/openai-completions/compat.ts";
import { convertTools as completionTools } from "../../../ai/src/api/openai-completions/tools.ts";
import { convertResponsesTools } from "../../../ai/src/api/openai-responses-shared/tools.ts";
import { validateToolArguments } from "../../../ai/src/utils/validation.ts";
import { agentModes } from "../../src/octocode/agent-tool.ts";
import { withReason } from "../../src/octocode/shared/reason.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";

const registrations = [
	["agent", "task"],
	["agentModels", "models"],
	["externalAgent", "external"],
	["coordinate", "coordinate"],
	["sendMessage", "message"],
] as const;

function unified(count: number = registrations.length) {
	const modes = agentModes();
	const execute = vi.fn(async () => ({ content: [], details: {} }));
	for (const [name, mode] of registrations.slice(0, count)) {
		modes.collect({
			name,
			label: name,
			description: name,
			parameters: Type.Object({ [mode]: Type.String() }, { additionalProperties: false }),
			execute,
		});
	}
	const fake = fakeHost();
	modes.register(fake.api);
	return { tool: fake.tools.get("agent")!, execute };
}

const mismatched = { type: "task", input: { message: "evidence" } };
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

describe("unified agent schema", () => {
	it.each([1, registrations.length])("binds each mode to its input with %i registered modes", (count) => {
		const { tool } = unified(count);
		for (const [, type] of registrations.slice(0, count)) {
			for (const [, inputMode] of registrations.slice(0, count)) {
				expect(Check(tool.parameters, { type, input: { [inputMode]: "value" } })).toBe(type === inputMode);
			}
		}
		for (const invalid of [{}, { type: "task" }, { input: { task: "value" } }, { type: "unknown", input: {} }]) {
			expect(Check(tool.parameters, invalid)).toBe(false);
		}
		expect(Check(tool.parameters, { type: "task", input: { task: "value" }, extra: true })).toBe(false);
	});

	it("rejects mismatched input before dispatch while retaining direct execution validation", async () => {
		const { tool, execute } = unified();
		expect(() =>
			validateToolArguments(tool, { type: "toolCall", id: "call", name: "agent", arguments: mismatched }),
		).toThrow();
		await expect(
			tool.execute("call", mismatched, undefined, undefined, fakeCtx({ cwd: process.cwd() })),
		).rejects.toThrow("Invalid agent task input");
		expect(execute).not.toHaveBeenCalled();
	});

	it("retains every mode in OpenAI, Moonshot and Gemini JSON-schema payloads", () => {
		const { tool } = unified();
		const responses = convertResponsesTools([tool])[0];
		const completions = completionTools([tool], compat)[0];
		const moonshot = completionTools([tool], { ...compat, toolSchemaFlavor: "moonshot" })[0];
		expect(responses.type).toBe("function");
		expect(completions.type).toBe("function");
		expect(moonshot.type).toBe("function");
		if (responses.type !== "function" || completions.type !== "function" || moonshot.type !== "function") return;
		const schemas = [
			responses.parameters,
			completions.function.parameters,
			moonshot.function.parameters,
			googleTools([tool])![0].functionDeclarations[0].parametersJsonSchema,
		] as TSchema[];
		for (const schema of schemas) {
			expect(schema).toHaveProperty("type", "object");
			for (const [, type] of registrations) expect(Check(schema, { type, input: { [type]: "value" } })).toBe(true);
			expect(Check(schema, mismatched)).toBe(false);
		}
		expect(responses.strict).toBe(false);
		expect(completions.function.strict).not.toBe(true);
	});

	it("requires a native reason in every branch and provider projection", () => {
		const { tool } = unified();
		const reasoned = { ...tool, parameters: withReason(tool.parameters) };
		const schemas = [
			reasoned.parameters,
			anthropicTools([reasoned], false, false, false)[0].input_schema,
			convertToolConfig([reasoned], "auto", false)!.tools![0].toolSpec!.inputSchema!.json,
			googleTools([reasoned], true, false)![0].functionDeclarations[0].parameters,
		] as TSchema[];
		for (const schema of schemas) {
			for (const [, type] of registrations) {
				const args = { type, input: { [type]: "value" } };
				expect(Check(schema, args)).toBe(false);
				expect(Check(schema, { ...args, reason: "make progress" })).toBe(true);
				expect(Check(schema, { ...args, reason: "make progress", extra: true })).toBe(false);
			}
		}
	});

	it("keeps Claude-compatible projections usable while runtime rejects their lossy cross-mode pairs", async () => {
		const { tool, execute } = unified();
		const schemas = [
			anthropicTools([tool], false, false, false)[0].input_schema,
			convertToolConfig([tool], "auto", false)!.tools![0].toolSpec!.inputSchema!.json,
			googleTools([tool], true, false)![0].functionDeclarations[0].parameters,
		] as TSchema[];
		for (const schema of schemas) {
			expect(schema).toMatchObject({ type: "object", required: ["type", "input"], additionalProperties: false });
			for (const keyword of ["anyOf", "oneOf", "allOf"]) expect(schema).not.toHaveProperty(keyword);
			for (const [, type] of registrations) expect(Check(schema, { type, input: { [type]: "value" } })).toBe(true);
			expect(Check(schema, mismatched)).toBe(true);
		}
		await expect(
			tool.execute("call", mismatched, undefined, undefined, fakeCtx({ cwd: process.cwd() })),
		).rejects.toThrow("Invalid agent task input");
		expect(execute).not.toHaveBeenCalled();
	});

	it("does not pretend object unions support strict sampling", () => {
		const { tool } = unified();
		expect(
			resolveJsonSchemaStrictSampling(
				{ ...tool, constrainedSampling: { type: "json_schema", strict: "prefer" } },
				true,
			),
		).toBeUndefined();
		expect(() =>
			resolveJsonSchemaStrictSampling(
				{ ...tool, constrainedSampling: { type: "json_schema", strict: "require" } },
				true,
			),
		).toThrow("object and array unions are unsupported");
	});
});

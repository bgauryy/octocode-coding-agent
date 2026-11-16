import { describe, expect, it } from "vitest";
import { supportsGoogleStrictToolSampling } from "../src/api/ai-sdk/google-capabilities.ts";
import { googleToolWire, googleContext, googleModel } from "./google-fetch-fixture.ts";
import { stream } from "../src/api/google-generative-ai.ts";
import { normalizeContext } from "../src/utils/transcript.ts";
import type { Tool } from "../src/types.ts";

function makeTool(parameters: Record<string, unknown>): Tool {
	return { name: "test_tool", description: "A test tool", parameters };
}
describe("Google SDK tool declarations", () => {
	it("does not mutate the original Tool.parameters object", async () => {
		const originalParameters = {
			$schema: "http://json-schema.org/draft-07/schema#",
			type: "object",
			properties: { command: { type: "string" } },
			required: ["command"],
		};
		await googleToolWire([makeTool(originalParameters)]);
		expect(originalParameters).toEqual({
			$schema: "http://json-schema.org/draft-07/schema#",
			type: "object",
			properties: { command: { type: "string" } },
			required: ["command"],
		});
	});
	it("preserves $schema in parametersJsonSchema when useParameters=false", async () => {
		const result = await googleToolWire([
			makeTool({
				$schema: "http://json-schema.org/draft-07/schema#",
				type: "object",
				properties: { command: { type: "string" } },
				required: ["command"],
			}),
		]);
		const decl = result?.[0]?.functionDeclarations?.[0];
		expect(decl).toBeDefined();
		expect(decl?.parametersJsonSchema).toEqual({
			$schema: "http://json-schema.org/draft-07/schema#",
			type: "object",
			properties: { command: { type: "string" } },
			required: ["command"],
		});
	});
	it("handles tools without $schema gracefully", async () => {
		const result = await googleToolWire([
			makeTool({ type: "object", properties: { path: { type: "string" } }, required: ["path"] }),
		]);
		const decl = result?.[0]?.functionDeclarations?.[0];
		expect(decl).toBeDefined();
		expect(decl?.parametersJsonSchema).toEqual({
			type: "object",
			properties: { path: { type: "string" } },
			required: ["path"],
		});
	});
	it("uses validated function calling for strict tools on Gemini 3", async () => {
		const tool = makeTool({ type: "object", properties: {} });
		tool.constrainedSampling = { type: "json_schema", strict: "require" };
		expect(supportsGoogleStrictToolSampling("gemini-3.1-pro-preview")).toBe(true);
		expect(supportsGoogleStrictToolSampling("gemini-2.5-pro")).toBe(false);
		let mode: unknown;
		await stream(
			{ ...googleModel, id: "gemini-3.1-pro-preview" },
			normalizeContext({
				messages: [{ role: "system", content: "", toolsAdded: [tool], timestamp: 0 }, ...googleContext.messages],
			}),
			{
				apiKey: "test-key",
				onPayload: (body) => {
					mode = (body as { toolConfig: { functionCallingConfig: { mode: unknown } } }).toolConfig.functionCallingConfig
						.mode;
					throw new Error("request captured");
				},
			},
		).result();
		expect(mode).toBe("VALIDATED");
		expect(() =>
			stream(
				googleModel,
				normalizeContext({
					messages: [{ role: "system", content: "", toolsAdded: [tool], timestamp: 0 }, ...googleContext.messages],
				}),
			),
		).toThrow('Tool "test_tool" requires JSON-schema constrained sampling');
	});
	it("returns undefined for empty tool list", async () => {
		expect(await googleToolWire([])).toBeUndefined();
		expect(await googleToolWire([], "gemini-2.5-pro")).toBeUndefined();
	});
});

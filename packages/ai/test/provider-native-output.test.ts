import { expect, it } from "vitest";
import { anthropicFrames } from "./anthropic-fetch-fixture.ts";
import { anthropicNativeOutput } from "../src/api/anthropic-messages/rich-content.ts";
import { stream as streamBedrock } from "../src/api/bedrock-converse-stream.ts";
import { bedrockModel, bedrockContext, bedrockResponse } from "./bedrock-fixtures.ts";
import { googleArtifact } from "../src/api/ai-sdk/google-rich-content.ts";
import { responseArtifact } from "../src/api/openai-responses-shared/rich-content.ts";
import type { Api, AssistantContent, Model } from "../src/types.ts";

function model<T extends Api>(api: T): Model<T> {
	return {
		api,
		provider: "fixture",
		id: "fixture",
		name: "Fixture",
		baseUrl: "https://example.invalid",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 100000,
		maxTokens: 4096,
	};
}

function visibleJson(block: AssistantContent | undefined): unknown {
	expect(block?.type).toBe("text");
	if (block?.type !== "text") throw new Error("Expected native output text");
	return JSON.parse(block.text.slice(block.text.indexOf("```json\n") + 8, block.text.lastIndexOf("\n```")));
}

it("retains Responses native execution logs, source URLs, and status without configuration or continuation data", () => {
	expect(
		visibleJson(
			responseArtifact({
				type: "code_interpreter_call",
				id: "code1",
				container_id: "opaque-container",
				status: "completed",
				code: "print(42)",
				outputs: [
					{ type: "logs", logs: "42\n" },
					{ type: "image", url: "https://example.invalid/chart.png" },
				],
			}),
		),
	).toEqual({
		code: "print(42)",
		outputs: [
			{ type: "logs", logs: "42\n" },
			{ type: "image", url: "https://example.invalid/chart.png" },
		],
		status: "completed",
	});
	expect(
		visibleJson(
			responseArtifact({
				type: "web_search_call",
				id: "search1",
				status: "completed",
				action: {
					type: "search",

					query: "fixture source",
					sources: [{ type: "url", url: "https://example.invalid/source" }],
				},
			}),
		),
	).toEqual({
		action: {
			type: "search",
			query: "fixture source",
			sources: [{ type: "url", url: "https://example.invalid/source" }],
		},
		status: "completed",
	});
	expect(
		visibleJson(
			responseArtifact({
				type: "local_shell_call",
				id: "shell1",
				call_id: "call1",
				status: "completed",
				action: { type: "exec", command: ["pwd"], env: { PRIVATE_KEY: "secret-env" } },
			}),
		),
	).toEqual({ action: { type: "exec", command: ["pwd"] }, status: "completed" });
	expect(
		visibleJson(
			responseArtifact({
				type: "mcp_call",
				id: "mcp1",
				name: "lookup",
				server_label: "fixture",
				arguments: '{"query":"fixture","thoughtSignature":"opaque-signature"}',
				output: '{"answer":42,"encrypted_content":"opaque-result","nested":{"continuation_token":"opaque-token"}}',
				approval_request_id: "opaque-approval",
			}),
		),
	).toEqual({
		name: "lookup",
		server_label: "fixture",
		arguments: { query: "fixture" },
		output: { answer: 42, nested: {} },
	});
	expect(responseArtifact({ type: "compaction", id: "comp1", encrypted_content: "opaque-compaction" })).toMatchObject({
		type: "unsupported",
		providerType: "compaction",
	});
});

it("retains Gemini tool arguments, structured results and resource references without part signatures", () => {
	expect(
		visibleJson(
			googleArtifact({
				toolCall: { id: "call1", args: { query: "fixture", thoughtSignature: "opaque-args" } },
				thoughtSignature: "opaque-part",
			}),
		),
	).toEqual({ id: "call1", args: { query: "fixture" } });
	expect(
		visibleJson(
			googleArtifact({
				toolResponse: {
					id: "call1",
					response: {
						text: "answer",
						sources: [{ url: "https://example.invalid/source" }],
						context: { token: "opaque-context" },
					},
				},
			}),
		),
	).toEqual({ id: "call1", response: { text: "answer", sources: [{ url: "https://example.invalid/source" }] } });
	expect(
		visibleJson(
			googleArtifact({
				functionResponse: {
					name: "lookup",
					response: { answer: 42 },
					parts: [{ fileData: { fileUri: "gs://fixture/file", mimeType: "text/plain" } }],
				},
			}),
		),
	).toEqual({
		name: "lookup",
		response: { answer: 42 },
		parts: [{ fileData: { fileUri: "gs://fixture/file", mimeType: "text/plain" } }],
	});
});

it("retains Anthropic native search and execution results without encrypted source or advisor data", () => {
	expect(
		visibleJson(
			anthropicNativeOutput({
				type: "web_search_tool_result",
				tool_use_id: "search1",
				content: [
					{
						type: "web_search_result",
						title: "Source",
						url: "https://example.invalid/source",
						page_age: null,
						encrypted_content: "opaque-source",
					},
				],
			}),
		),
	).toEqual({
		tool_use_id: "search1",
		content: [{ type: "web_search_result", title: "Source", url: "https://example.invalid/source", page_age: null }],
	});
	expect(
		visibleJson(
			anthropicNativeOutput({
				type: "bash_code_execution_tool_result",
				tool_use_id: "exec1",
				content: {
					type: "bash_code_execution_result",
					stdout: "42\n",
					stderr: "",
					return_code: 0,
					content: [{ type: "bash_code_execution_output", file_id: "file1" }],
				},
			}),
		),
	).toMatchObject({ content: { stdout: "42\n", return_code: 0, content: [{ file_id: "file1" }] } });
	expect(
		visibleJson(
			anthropicNativeOutput({
				type: "advisor_tool_result",
				tool_use_id: "advisor1",
				content: { type: "advisor_redacted_result", encrypted_content: "opaque-advisor", stop_reason: "end_turn" },
			}),
		),
	).toEqual({ tool_use_id: "advisor1", content: { type: "advisor_redacted_result", stop_reason: "end_turn" } });
});

it("assembles native Anthropic tool input deltas in order and keeps scratch buffers out of history", async () => {
	const selected = model("anthropic-messages");
	const events = [
		{
			type: "content_block_start",
			index: 0,
			content_block: { type: "server_tool_use", id: "server1", name: "web_search", input: {} },
		},
		{ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"query":"fixture",' } },
		{
			type: "content_block_delta",
			index: 0,
			delta: { type: "input_json_delta", partial_json: '"signature":"opaque-input"}' },
		},
		{ type: "content_block_stop", index: 0 },
	];
	const output = await anthropicFrames(selected, events).result();
	expect(visibleJson(output.content[0])).toEqual({ id: "server1", name: "web_search", input: { query: "fixture" } });
	expect(output.stopReason).toBe("stop");
	expect(JSON.stringify(output)).not.toMatch(/opaque-input|partialJson|nativeToolInputs/);
	expect(output.content[0]).not.toHaveProperty("index");
});

it("retains streamed Bedrock native tool text and JSON results through finalization", async () => {
	const output = await streamBedrock(bedrockModel, bedrockContext, {
		apiKey: "test",
		env: {},
		fetch: async () =>
			bedrockResponse([
				{ messageStart: { role: "assistant" } },
				{
					contentBlockStart: { contentBlockIndex: 0, start: { toolResult: { toolUseId: "tool1", status: "success" } } },
				},
				{
					contentBlockDelta: {
						contentBlockIndex: 0,
						delta: { toolResult: [{ text: "line 1\n" }, { json: { result: 42, thoughtSignature: "opaque-result" } }] },
					},
				},
				{ contentBlockDelta: { contentBlockIndex: 0, delta: { toolResult: [{ text: "line 2\n" }] } } },
				{ contentBlockStop: { contentBlockIndex: 0 } },
				{ messageStop: { stopReason: "end_turn" } },
			]),
	}).result();
	expect(output.content).toHaveLength(1);
	expect(output.stopReason).toBe("stop");
	expect(output.content[0]).toMatchObject({ type: "text", text: expect.stringContaining('"result": 42') });
	expect(JSON.stringify(output)).toContain("line 1");
	expect(JSON.stringify(output)).toContain("line 2");
	expect(JSON.stringify(output)).not.toContain("opaque-result");
	expect(output.content[0]).not.toHaveProperty("index");
});

it("retains visible Anthropic compaction deltas without encrypted compaction metadata", async () => {
	const selected = model("anthropic-messages");
	const output = await anthropicFrames(selected, [
		{
			type: "content_block_start",
			index: 0,
			content_block: { type: "compaction", content: null, encrypted_content: null },
		},
		{
			type: "content_block_delta",
			index: 0,
			delta: { type: "compaction_delta", content: "Visible ", encrypted_content: "opaque-first" },
		},
		{
			type: "content_block_delta",
			index: 0,
			delta: { type: "compaction_delta", content: "summary", encrypted_content: "opaque-second" },
		},
		{ type: "content_block_stop", index: 0 },
	]).result();
	expect(output.content).toEqual([{ type: "text", text: "Provider compaction:\nVisible summary" }]);
});

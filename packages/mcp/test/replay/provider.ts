import { stream as bedrock } from "../../../ai/src/api/bedrock-converse-stream.ts";
import { stream as completions } from "../../../ai/src/api/openai-completions.ts";
import { getBuiltinModel } from "../../../ai/src/providers/all.ts";
import type { Message, Tool } from "../../../ai/src/types.ts";
import { createPendingAssistantMessage } from "../../../ai/src/utils/assistant-message.ts";
import { charsToTokens } from "../../../ai/src/utils/estimate.ts";
import { normalizeContext } from "../../../ai/src/utils/transcript.ts";
import { bedrockModel, bedrockResponse } from "../../../ai/test/bedrock-fixtures.ts";
import { completionsResponse } from "../../../ai/test/completions-fetch-fixture.ts";

const openaiModel = { ...getBuiltinModel("openai", "gpt-4o-mini"), api: "openai-completions" as const };
export type Route = "bedrock" | "completions";
const system = "Use the requested tool.";
type Guidance = { loaded: string; name: string } | { restored: string } | undefined;

function priorMessages(route: Route, guidance: Guidance): Message[] {
	if (!guidance) return [];
	if ("restored" in guidance) return [{ role: "user", content: guidance.restored, timestamp: 0 }];
	const assistant = createPendingAssistantMessage(route === "bedrock" ? bedrockModel : openaiModel);
	assistant.content = [
		{
			type: "toolCall",
			id: "load",
			name: "mcp",
			arguments: { intent: "tools", server: "replay", tool: guidance.name },
		},
	];
	assistant.stopReason = "toolUse";
	return [
		{ role: "user", content: "Load the tool contract.", timestamp: 0 },
		assistant,
		{
			role: "toolResult",
			toolName: "mcp",
			toolCallId: "load",
			content: [{ type: "text", text: guidance.loaded }],
			isError: false,
			timestamp: 0,
		},
	];
}

function scriptedResponse(route: Route, name: string, parts: string[]) {
	if (route === "bedrock")
		return bedrockResponse([
			{ messageStart: { role: "assistant" } },
			{ contentBlockStart: { contentBlockIndex: 0, start: { toolUse: { toolUseId: "call", name } } } },
			...parts.map((input) => ({ contentBlockDelta: { contentBlockIndex: 0, delta: { toolUse: { input } } } })),
			{ contentBlockStop: { contentBlockIndex: 0 } },
			{ messageStop: { stopReason: "tool_use" } },
		]);
	const chunk = (delta: unknown, finish_reason: string | null = null) => ({
		choices: [{ index: 0, delta, finish_reason }],
	});
	return completionsResponse([
		chunk({
			role: "assistant",
			tool_calls: [{ index: 0, id: "call", type: "function", function: { name, arguments: "" } }],
		}),
		...parts.map((part) => chunk({ tool_calls: [{ index: 0, function: { arguments: part } }] })),
		chunk({}, "tool_calls"),
	]);
}

/** Both real adapters use an injected fetch. The received provider chunks are observed before adapter parsing. */
export async function scriptedCall(route: Route, tool: Tool, prompt: string, emitted: unknown, guidance: Guidance) {
	const model = route === "bedrock" ? bedrockModel : openaiModel;
	const text = JSON.stringify(emitted);
	const split = Math.ceil(text.length / 2);
	const history = priorMessages(route, guidance);
	const context = normalizeContext({
		systemPrompt: system,
		tools: [tool],
		messages: [...history, { role: "user", content: prompt, timestamp: 0 }],
	});
	const rawDeltas: string[] = [];
	let declarationTokens: number | undefined;
	const options = {
		maxTokens: 128,
		env: {},
		apiKey: "scripted",
		fetch: async (_url: unknown, init?: RequestInit) => {
			if (typeof init?.body !== "string") throw new Error("Missing provider request body");
			const body = JSON.parse(init.body);
			const declarations: unknown = body.toolConfig?.tools ?? body.tools;
			if (!Array.isArray(declarations)) throw new Error("Missing wire tool declarations");
			declarationTokens = charsToTokens(JSON.stringify(declarations).length, model);
			return scriptedResponse(route, tool.name, [text.slice(0, split), text.slice(split)]);
		},
		onProviderStreamEvent: (event: unknown) => {
			const chunk = event as {
				choices?: { delta: { tool_calls?: { function: { arguments?: string } }[] } }[];
				contentBlockDelta?: { delta: { toolUse?: { input: string } } };
			};
			const part =
				chunk.contentBlockDelta?.delta.toolUse?.input ?? chunk.choices?.[0]?.delta.tool_calls?.[0]?.function.arguments;
			if (typeof part === "string") rawDeltas.push(part);
		},
	};
	const assistant = await (
		route === "bedrock" ? bedrock(bedrockModel, context, options) : completions(openaiModel, context, options)
	).result();
	if (assistant.stopReason !== "toolUse")
		throw new Error(assistant.errorMessage ?? `Unexpected stop: ${assistant.stopReason}`);
	const [call] = assistant.content;
	if (assistant.content.length !== 1 || call?.type !== "toolCall" || call.name !== tool.name)
		throw new Error("Missing scripted tool call");
	return {
		assistant,
		call,
		rawDeltas,
		estimatedTokens: {
			declaration: declarationTokens,
			system: charsToTokens(system.length, model),
			guidance: charsToTokens(
				guidance ? ("restored" in guidance ? guidance.restored.length : guidance.loaded.length) : 0,
				model,
			),
		},
	};
}

import { jsonSchema, tool, type ModelMessage, type ToolSet } from "ai";
import { openai } from "@ai-sdk/openai";
import type { TranscriptContext, Message } from "../../types.ts";
import type { ResponsesModel } from "./responses-model.ts";
import { getSystemMessageText, renderSystemMessageUpdate } from "../../utils/text.ts";
import { resolveTranscriptTools } from "../../utils/transcript.ts";
import {
	convertResponsesTools,
	getResponsesToolSupport,
	renderIncrementalToolsNotice,
	renderToolRemovalNotice,
} from "../openai-responses-shared/tools.ts";
import { getCompat, getConfigurationUpdateEffort } from "../openai-responses/compat.ts";
import type { OpenAIResponsesOptions } from "../openai-responses/types.ts";
import { transformMessages } from "../transform-messages.ts";
import { fastHash } from "../../utils/hash.ts";
import { responsesToolCallIdNormalizer } from "../openai-responses-shared/tool-call-ids.ts";
import { parseTextSignature } from "../openai-responses-shared/text-signature.ts";

export function responsesReplayMessages(model: ResponsesModel, context: TranscriptContext) {
	return transformMessages(context.messages, model, responsesToolCallIdNormalizer(model, context.messages));
}

function replayMessage(
	model: ResponsesModel,
	message: Exclude<Message, { role: "system" }>,
	grammarProperties: Map<string, string>,
): ModelMessage {
	if (message.role === "user")
		return {
			role: "user",
			content:
				typeof message.content === "string"
					? message.content
					: message.content.map((block) =>
							block.type === "text"
								? { type: "text" as const, text: block.text }
								: { type: "image" as const, image: block.data, mediaType: block.mimeType },
						),
		};
	if (message.role === "assistant")
		return {
			role: "assistant",
			content: message.content.flatMap(
				(block): Exclude<Extract<ModelMessage, { role: "assistant" }>["content"], string> => {
					if (block.type === "text") {
						const signature = parseTextSignature(block.textSignature);
						return [
							{
								type: "text",
								text: block.text,
								providerOptions: signature
									? { openai: { itemId: signature.id, ...(signature.phase ? { phase: signature.phase } : {}) } }
									: undefined,
							},
						];
					}
					if (block.type === "thinking") {
						if (!block.thinkingSignature) return [];
						const signature = JSON.parse(block.thinkingSignature) as { id: string; encrypted_content?: string };
						return [
							{
								type: "reasoning",
								text: block.thinking,
								providerOptions: {
									openai: { itemId: signature.id, reasoningEncryptedContent: signature.encrypted_content ?? null },
								},
							},
						];
					}
					if (block.type === "toolCall") {
						const [toolCallId, itemId] = block.id.split("|");
						const sameModel =
							message.provider === model.provider && message.api === model.api && message.model === model.id;
						return [
							{
								type: "tool-call",
								toolCallId,
								toolName: block.name,
								input: grammarProperties.has(block.name)
									? getGrammarToolInput(block.name, block.arguments, grammarProperties.get(block.name)!)
									: block.arguments,
								providerOptions: {
									openai: {
										...(itemId?.startsWith(grammarProperties.has(block.name) ? "ctc_" : "fc_") &&
										(sameModel || message.provider !== model.provider || message.api !== model.api)
											? { itemId }
											: {}),
										...(sameModel && block.namespace !== undefined ? { namespace: block.namespace } : {}),
									},
								},
							},
						];
					}
					// Generated artifacts are display-only; Responses replay accepts text, reasoning and tool calls.
					if (["image", "media", "resource", "unsupported"].includes(block.type)) return [];
					throw new Error(`Unsupported Responses SDK replay content: ${block.type}`);
				},
			),
		};
	const text = message.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n");
	const images = message.content.filter((block) => block.type === "image");
	return {
		role: "tool",
		content: [
			{
				type: "tool-result",
				toolCallId: message.toolCallId.split("|")[0],
				toolName: message.toolName,
				output:
					images.length && model.input.includes("image")
						? {
								type: "content",
								value: [
									...(text.trim() ? [{ type: "text" as const, text }] : []),
									...images.map((block) => ({
										type: "file" as const,
										mediaType: block.mimeType,
										data: { type: "data" as const, data: block.data },
										providerOptions: { openai: { imageDetail: "auto" } },
									})),
								],
							}
						: { type: "text", value: text.trim() ? text : images.length ? "(see attached image)" : "(no tool output)" },
			},
		],
	};
}
import {
	resolveJsonSchemaStrictSampling,
	resolveGrammarConstrainedSampling,
	getGrammarToolInput,
	getJsonSchemaToolParameters,
} from "../constrained-sampling.ts";

export function responsesMessages(model: ResponsesModel, context: TranscriptContext, options: OpenAIResponsesOptions) {
	const compat = getCompat(model);
	const support = getResponsesToolSupport(compat);
	const plan = resolveTranscriptTools(context.messages, support);
	const tools: ToolSet = Object.fromEntries(
		plan.requestTools.map((definition) => {
			const grammar = resolveGrammarConstrainedSampling(definition, compat.supportsOpenAIGrammarTools);
			return [
				definition.name,
				grammar
					? openai.tools.customTool({
							description: definition.description,
							format: { type: "grammar", syntax: grammar.format, definition: grammar.definition },
						})
					: tool({
							description: definition.description,
							inputSchema: jsonSchema(
								getJsonSchemaToolParameters(
									definition,
									resolveJsonSchemaStrictSampling(definition, compat.supportsStrictMode) === true,
								),
							),
							strict: resolveJsonSchemaStrictSampling(definition, compat.supportsStrictMode) ?? false,
						}),
			];
		}),
	);
	const grammarProperties = new Map<string, string>();
	for (const definition of context.messages.flatMap((message) =>
		message.role === "system" ? (message.toolsAdded ?? []) : [],
	)) {
		const grammar = resolveGrammarConstrainedSampling(definition, compat.supportsOpenAIGrammarTools);
		if (grammar) grammarProperties.set(definition.name, grammar.inputProperty);
	}
	const messages: ModelMessage[] = [];
	let searchName = "__octocode_tool_search";
	while (tools[searchName]) searchName += "_";
	const hasSearchLoads =
		support === "additions" &&
		context.messages
			.filter((message) => message.role === "system")
			.slice(plan.foldedSystemMessages)
			.some((message) => message.toolsAdded?.length);
	if (hasSearchLoads) tools[searchName] = openai.tools.toolSearch({ execution: "client" });
	const unavailable = new Set<string>();
	let declared = false;
	let systemIndex = 0;
	const update = getConfigurationUpdateEffort(model, options, compat);
	const transformed = responsesReplayMessages(model, context);
	for (const [index, message] of transformed.entries()) {
		if (message.role === "system") {
			const anchored = systemIndex++ >= plan.foldedSystemMessages;
			const additions = message.toolsAdded ?? [];
			for (const definition of additions) unavailable.delete(definition.name);
			if (anchored && support === "changes" && additions.length) {
				if (declared) messages.push({ role: "system", content: renderIncrementalToolsNotice(unavailable) });
				messages.push({
					role: "system",
					content: "",
					providerOptions: {
						openai: {
							additionalTools: JSON.parse(
								JSON.stringify(
									convertResponsesTools(additions, {
										supportsStrictMode: compat.supportsStrictMode,
										supportsOpenAIGrammarTools: compat.supportsOpenAIGrammarTools,
									}),
								),
							),
						},
					},
				});
				declared = true;
			}
			if (anchored && support === "additions" && additions.length) {
				const names = additions.map((definition) => definition.name);
				const position = index - (transformed[0]?.role === "system" ? 1 : 0);
				const callId = `octocode_tool_load_${fastHash(`system:${position}:${names.join(",")}`)}`;
				messages.push({
					role: "assistant",
					content: [
						{
							type: "tool-call",
							toolName: searchName,
							toolCallId: callId,
							input: { call_id: callId, arguments: { query: names.join(" "), limit: names.length } },
						},
					],
				});
				messages.push({
					role: "tool",
					content: [
						{
							type: "tool-result",
							toolName: searchName,
							toolCallId: callId,
							output: {
								type: "json",
								value: {
									tools: JSON.parse(
										JSON.stringify(
											convertResponsesTools(additions, {
												supportsStrictMode: compat.supportsStrictMode,
												supportsOpenAIGrammarTools: compat.supportsOpenAIGrammarTools,
												toolSearchResult: true,
											}),
										),
									),
								},
							},
						},
					],
				});
			}
			const parts = [index === 0 ? getSystemMessageText(message) : renderSystemMessageUpdate(message)];
			if (anchored) {
				const added = new Set(additions.map((definition) => definition.name));
				const removed = (message.toolsRemoved ?? [])
					.map((definition) => definition.name)
					.filter((name) => !added.has(name));
				if (removed.length) parts.push(renderToolRemovalNotice(removed));
				for (const name of removed) unavailable.add(name);
			}
			const content = parts.filter(Boolean).join("\n\n");
			if (content) messages.push({ role: "system", content });
			continue;
		}
		if (
			message.role === "assistant" &&
			update !== undefined &&
			message.provider === model.provider &&
			message.api === model.api &&
			message.model === model.id &&
			message.providerThinkingLevel !== undefined
		) {
			messages.push({
				role: "system",
				content: "",
				providerOptions: { openai: { reasoningEffortUpdate: message.providerThinkingLevel } },
			});
		}
		messages.push(replayMessage(model, message, grammarProperties));
	}
	if (update !== undefined)
		messages.push({ role: "system", content: "", providerOptions: { openai: { reasoningEffortUpdate: update } } });
	return {
		messages:
			model.api === "azure-openai-responses" && messages.length === 0
				? [{ role: "user" as const, content: "" }]
				: messages,
		tools,
	};
}

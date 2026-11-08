import { DEFAULT_TOOL_CALL_ID_MAX_LENGTH, fitToolCallId, sanitizeToolCallId } from "../tool-call-id.ts";
import type {
	ResponseConfigurationUpdateItemParam,
	ResponseInput,
	ResponseInputContent,
	ResponseInputImage,
	ResponseInputItem,
	ResponseInputText,
	ResponseOutputItem,
	ResponseOutputMessage,
	ResponseReasoningItem,
	ResponseToolSearchOutputItemParam,
} from "openai/resources/responses/responses.js";
import type {
	Api,
	AssistantMessage,
	ImageContent,
	Model,
	SystemMessage,
	TextContent,
	TranscriptContext,
} from "../../types.ts";
import { fastHash } from "../../utils/hash.ts";
import { sanitizeSurrogates } from "../../utils/sanitize-unicode.ts";
import { splitSystemMessageAtBoundary } from "../../utils/instruction-split.ts";
import { getSystemMessageText, renderSystemMessageUpdate } from "../../utils/text.ts";
import { resolveTranscript, resolveTranscriptTools } from "../../utils/transcript.ts";
import { getGrammarToolInput } from "../constrained-sampling.ts";
import { transformMessages } from "../transform-messages.ts";
import { parseTextSignature } from "./text-signature.ts";
import {
	convertResponsesTools,
	getResponsesToolSupport,
	renderIncrementalToolsNotice,
	renderToolRemovalNotice,
} from "./tools.ts";
import type { ConvertResponsesMessagesOptions } from "./types.ts";

type ToolResultOutputContent = Array<ResponseInputText | ResponseInputImage>;

function convertToolResultOutput<TApi extends Api>(
	model: Model<TApi>,
	content: readonly (TextContent | ImageContent)[],
): string | ToolResultOutputContent {
	const textResult = content
		.filter((c): c is TextContent => c.type === "text")
		.map((c) => c.text)
		.join("\n");
	const images = content.filter((c): c is ImageContent => c.type === "image");
	const hasText = textResult.trim().length > 0;

	if (images.length === 0 || !model.input.includes("image")) {
		return sanitizeSurrogates(hasText ? textResult : images.length > 0 ? "(see attached image)" : "(no tool output)");
	}

	const output: ToolResultOutputContent = [];
	if (hasText) {
		output.push({ type: "input_text", text: sanitizeSurrogates(textResult) });
	}
	for (const image of images) {
		output.push({
			type: "input_image",
			detail: "auto",
			image_url: `data:${image.mimeType};base64,${image.data}`,
		});
	}
	return output;
}

// =============================================================================
// Message conversion
// =============================================================================

/**
 * Providers whose Responses endpoints use OpenAI's `call_…|fc_…` tool-call ids: replayed to one of them, a recorded id
 * keeps its call id and item id instead of being flattened into one.
 */
export const RESPONSES_TOOL_CALL_PROVIDERS: ReadonlySet<string> = new Set([
	"openai",
	"openai-codex",
	"opencode",
	"opencode-go",
]);

export function convertResponsesMessages<TApi extends Api>(
	model: Model<TApi>,
	context: TranscriptContext,
	allowedToolCallProviders: ReadonlySet<string>,
	options?: ConvertResponsesMessagesOptions,
): ResponseInput {
	const normalizedContext = resolveTranscript(context, options?.supportsMidConvoSystemMessages);
	const messages: ResponseInput = [];

	const normalizeIdPart = (part: string): string =>
		sanitizeToolCallId(part, DEFAULT_TOOL_CALL_ID_MAX_LENGTH, { trimTrailingUnderscores: true });

	const buildForeignResponsesItemId = (itemId: string): string => {
		const normalized = `fc_${fastHash(itemId)}`;
		return normalized.length > 64 ? normalized.slice(0, 64) : normalized;
	};

	// GitHub Copilot gives parallel calls one call_id and tells them apart by item id. Item ids are not replayed for
	// another model, so a call_id that more than one call carries is made unique with a hash of the whole id.
	const callIdOwners = new Map<string, Set<string>>();
	for (const message of normalizedContext.messages) {
		if (message.role !== "assistant") continue;
		for (const block of message.content) {
			if (block.type !== "toolCall" || !block.id.includes("|")) continue;
			const callId = block.id.split("|")[0];
			callIdOwners.set(callId, (callIdOwners.get(callId) ?? new Set()).add(block.id));
		}
	}
	const uniqueCallId = (normalizedCallId: string, callId: string, id: string): string => {
		if ((callIdOwners.get(callId)?.size ?? 0) < 2) return normalizedCallId;
		const hash = fastHash(id);
		return `${normalizedCallId.slice(0, DEFAULT_TOOL_CALL_ID_MAX_LENGTH - hash.length - 1)}_${hash}`;
	};

	const normalizeToolCallId = (id: string, _targetModel: Model<TApi>, source: AssistantMessage): string => {
		// A whole foreign id keeps a hash of itself when cut to the limit, so distinct calls keep distinct ids.
		if (!allowedToolCallProviders.has(model.provider) || !id.includes("|")) return fitToolCallId(id).replace(/_+$/, "");
		const [callId, itemId] = id.split("|");
		const normalizedCallId = uniqueCallId(normalizeIdPart(callId), callId, id);
		const isForeignToolCall = source.provider !== model.provider || source.api !== model.api;
		let normalizedItemId = isForeignToolCall ? buildForeignResponsesItemId(itemId) : normalizeIdPart(itemId);
		// OpenAI Responses API requires item id to start with "fc"
		if (!normalizedItemId.startsWith("fc_")) {
			normalizedItemId = normalizeIdPart(`fc_${normalizedItemId}`);
		}
		return `${normalizedCallId}|${normalizedItemId}`;
	};

	const transformedMessages = transformMessages(normalizedContext.messages, model, normalizeToolCallId);
	const toolSupport = getResponsesToolSupport(options ?? {});
	const transcriptTools = resolveTranscriptTools(normalizedContext.messages, toolSupport);
	let declaredAdditionalTools = false;
	/** Tools announced as removed and not declared again since. */
	const unavailableTools = new Set<string>();
	const appendSystemToolAdditions = (message: SystemMessage, seed: string): void => {
		const tools = message.toolsAdded ?? [];
		for (const tool of tools) unavailableTools.delete(tool.name);
		if (tools.length === 0) return;
		if (toolSupport === "changes") {
			if (declaredAdditionalTools) {
				messages.push({ role: instructionRole, content: renderIncrementalToolsNotice(unavailableTools) });
			}
			declaredAdditionalTools = true;
			messages.push({
				type: "additional_tools",
				role: "developer",
				tools: convertResponsesTools(tools, options?.toolOptions),
			} satisfies ResponseInputItem);
			return;
		}
		if (toolSupport !== "additions") return;
		const names = tools.map((tool) => tool.name);
		const callId = `pi_tool_load_${fastHash(`${seed}:${names.join(",")}`)}`;
		messages.push({
			type: "tool_search_call",
			call_id: callId,
			execution: "client",
			status: "completed",
			arguments: { query: names.join(" "), limit: names.length },
		} satisfies ResponseInputItem);
		messages.push({
			type: "tool_search_output",
			call_id: callId,
			execution: "client",
			status: "completed",
			tools: convertResponsesTools(tools, { ...options?.toolOptions, toolSearchResult: true }),
		} satisfies ResponseToolSearchOutputItemParam);
	};
	const includeInitialSystemMessage = options?.includeSystemPrompt ?? true;
	const pushConfigurationUpdate = (effort: string): void => {
		messages.push({
			type: "configuration_update",
			reasoning: { effort: effort as NonNullable<ResponseConfigurationUpdateItemParam.Reasoning["effort"]> },
		} satisfies ResponseConfigurationUpdateItemParam);
	};
	const compat = model.compat as { supportsDeveloperRole?: boolean } | undefined;
	const instructionRole = model.reasoning && compat?.supportsDeveloperRole !== false ? "developer" : "system";

	let msgIndex = 0;
	let sourceIndex = 0;
	let systemIndex = 0;
	for (const msg of transformedMessages) {
		const isLeadingSystemMessage = sourceIndex++ === 0 && msg.role === "system";
		if (msg.role === "system") {
			// transformMessages keeps system messages in order, so their position matches the transcript.
			const anchorsToolChanges = systemIndex++ >= transcriptTools.foldedSystemMessages;
			if (anchorsToolChanges) appendSystemToolAdditions(msg, `system:${msgIndex}`);
			if (!isLeadingSystemMessage || includeInitialSystemMessage) {
				const parts = [isLeadingSystemMessage ? getSystemMessageText(msg) : renderSystemMessageUpdate(msg)];
				if (anchorsToolChanges) {
					// A redefinition is a removal plus an addition of the same name; only true removals are announced.
					const added = new Set((msg.toolsAdded ?? []).map((tool) => tool.name));
					const removed = (msg.toolsRemoved ?? []).map((tool) => tool.name).filter((name) => !added.has(name));
					if (removed.length > 0) parts.push(renderToolRemovalNotice(removed));
					// Recorded after this message's additions, whose notice precedes this removal notice.
					for (const name of removed) unavailableTools.add(name);
				}
				const text = parts.filter((part) => part.length > 0).join("\n\n");
				if (text.length > 0) {
					const ttl = options?.instructionCacheTtl;
					const breakpoint = options?.omitBreakpointTtl
						? { mode: "explicit" as const }
						: { mode: "explicit" as const, ttl };
					const block = (blockText: string) => ({
						type: "input_text" as const,
						text: sanitizeSurrogates(blockText),
						prompt_cache_breakpoint: breakpoint,
					});
					// A named section starts a second block with its own breakpoint; the blocks join to the same text.
					const fullText = getSystemMessageText(msg);
					const split =
						isLeadingSystemMessage && ttl && text.startsWith(fullText)
							? splitSystemMessageAtBoundary(msg, options?.instructionCacheBoundary)
							: undefined;
					messages.push({
						role: instructionRole,
						content: split
							? [block(split[0]), block(`${split[1]}${text.slice(fullText.length)}`)]
							: isLeadingSystemMessage && ttl
								? [block(text)]
								: sanitizeSurrogates(text),
					});
				}
			}
		} else if (msg.role === "user") {
			if (typeof msg.content === "string") {
				messages.push({
					role: "user",
					content: [{ type: "input_text", text: sanitizeSurrogates(msg.content) }],
				});
			} else {
				const content: ResponseInputContent[] = msg.content.map((item): ResponseInputContent => {
					if (item.type === "text") {
						return {
							type: "input_text",
							text: sanitizeSurrogates(item.text),
						} satisfies ResponseInputText;
					}
					return {
						type: "input_image",
						detail: "auto",
						image_url: `data:${item.mimeType};base64,${item.data}`,
					} satisfies ResponseInputImage;
				});
				if (content.length === 0) continue;
				messages.push({
					role: "user",
					content,
				});
			}
		} else if (msg.role === "assistant") {
			const output: ResponseInput = [];
			const assistantMsg = msg;
			const isSameProviderAndApi = assistantMsg.provider === model.provider && assistantMsg.api === model.api;
			const isSameModel = isSameProviderAndApi && assistantMsg.model === model.id;
			const isDifferentModel = isSameProviderAndApi && assistantMsg.model !== model.id;
			let textBlockIndex = 0;

			for (const block of msg.content) {
				if (block.type === "thinking") {
					if (block.thinkingSignature) {
						const reasoningItem = JSON.parse(block.thinkingSignature) as ResponseReasoningItem;
						output.push(reasoningItem);
					}
				} else if (block.type === "text") {
					const textBlock = block;
					const parsedSignature = parseTextSignature(textBlock.textSignature);
					const fallbackMessageId =
						textBlockIndex === 0 ? `msg_pi_${msgIndex}` : `msg_pi_${msgIndex}_${textBlockIndex}`;
					textBlockIndex++;
					// OpenAI requires id to be max 64 characters
					let msgId = parsedSignature?.id;
					if (!msgId) {
						msgId = fallbackMessageId;
					} else if (msgId.length > 64) {
						msgId = `msg_${fastHash(msgId)}`;
					}
					output.push({
						type: "message",
						role: "assistant",
						content: [{ type: "output_text", text: sanitizeSurrogates(textBlock.text), annotations: [] }],
						status: "completed",
						id: msgId,
						phase: parsedSignature?.phase,
					} satisfies ResponseOutputMessage);
				} else if (block.type === "toolCall") {
					const toolCall = block;
					const [callId, itemIdRaw] = toolCall.id.split("|");
					const customInputProperty = options?.grammarToolInputProperties?.get(toolCall.name);
					let itemId: string | undefined = itemIdRaw;

					// For different-model messages, set id to undefined to avoid pairing validation.
					// OpenAI tracks which item IDs were paired with rs_xxx reasoning items.
					// By omitting the id, we avoid triggering that validation (like cross-provider does).
					// Also drop ids that do not match the replayed item type: function_call ids must be fc_*
					// and custom_tool_call ids must be ctc_*. Foreign tool call ids are normalized to fc_*, and
					// a call can switch between the two types when grammar tool support differs.
					const itemIdPrefix = customInputProperty === undefined ? "fc_" : "ctc_";
					if (isDifferentModel || !itemId?.startsWith(itemIdPrefix)) {
						itemId = undefined;
					}

					if (customInputProperty !== undefined) {
						output.push({
							type: "custom_tool_call",
							id: itemId,
							call_id: callId,
							name: toolCall.name,
							input: sanitizeSurrogates(getGrammarToolInput(toolCall.name, toolCall.arguments, customInputProperty)),
							...(isSameModel && toolCall.namespace !== undefined ? { namespace: toolCall.namespace } : {}),
						} satisfies ResponseOutputItem);
					} else {
						output.push({
							type: "function_call",
							id: itemId,
							call_id: callId,
							name: toolCall.name,
							arguments: JSON.stringify(toolCall.arguments),
							...(isSameModel && toolCall.namespace !== undefined ? { namespace: toolCall.namespace } : {}),
						});
					}
				}
			}
			if (output.length === 0) continue;
			if (options?.configurationUpdateEffort !== undefined && isSameModel && msg.providerThinkingLevel !== undefined) {
				pushConfigurationUpdate(msg.providerThinkingLevel);
			}
			messages.push(...output);
		} else if (msg.role === "toolResult") {
			const [callId] = msg.toolCallId.split("|");
			const output = convertToolResultOutput(model, msg.content);

			if (options?.grammarToolInputProperties?.has(msg.toolName)) {
				messages.push({
					type: "custom_tool_call_output",
					call_id: callId,
					output,
				});
			} else {
				messages.push({
					type: "function_call_output",
					call_id: callId,
					output,
				});
			}
		}
		if (!isLeadingSystemMessage) msgIndex++;
	}
	if (options?.configurationUpdateEffort !== undefined) pushConfigurationUpdate(options.configurationUpdateEffort);

	return messages;
}

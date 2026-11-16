import { jsonSchema, tool, type ModelMessage } from "ai";
import type { Model, TranscriptContext, Usage } from "../../types.ts";
import { calculateCost } from "../../models/model-helpers.ts";
import { createUsage, sumUsageTokens } from "../../utils/assistant-message.ts";
import { collapseSystemMessages, getInitialSystemMessage, getCurrentTools } from "../../utils/transcript.ts";
import { keepsToolBreakpoint, splitSystemMessageIntoBlocks } from "../../utils/instruction-split.ts";
import { resolveLayeredCacheRetention } from "../../utils/cache-policy.ts";
import { charsToTokens, ESTIMATED_IMAGE_TOKENS } from "../../utils/estimate.ts";
import type { BedrockOptions } from "../bedrock-converse-stream/types.ts";
import { REDACTED_THINKING_PLACEHOLDER } from "../bedrock-converse-stream/types.ts";
import { buildAdditionalModelRequestFields } from "../bedrock-converse-stream/request-fields.ts";
import {
	supportsPromptCaching,
	supportsToolCachePoint,
	isNovaExplicitCacheModel,
	isAnthropicClaudeModel,
} from "../bedrock-converse-stream/model-match.ts";
import { longCacheTtl, supportsThinkingSignature } from "../bedrock-converse-stream/model-support.ts";
import { transformMessages } from "../transform-messages.ts";
import { fitToolCallId } from "../tool-call-id.ts";
import { normalizeBedrockMessages } from "./bedrock-normalize.ts";
import { sdkMessages } from "./messages.ts";
import { bedrockRichEvents } from "../bedrock-converse-stream/sdk-rich-events.ts";
import { anthropicSdkTools } from "./anthropic-map.ts";
import { sdkUsage } from "./events.ts";
import { bedrockNetworkFetch, bedrockSdkModel } from "./bedrock-provider.ts";
import { appendBedrockFailureDiagnostic, formatBedrockError } from "../bedrock-converse-stream/errors.ts";
import { parseRetryAfterMs } from "../../utils/retry.ts";
import type { SdkMapping } from "./stream.ts";

export function bedrockSdkMapping(
	model: Model<"bedrock-converse-stream">,
	context: TranscriptContext,
	options: BedrockOptions,
): SdkMapping {
	const normalized = collapseSystemMessages({
		...context,
		messages: normalizeBedrockMessages(
			transformMessages(context.messages, model, (id) => fitToolCallId(id)),
			{
				splitErrorImages: isAnthropicClaudeModel(model),
				signedThinking: supportsThinkingSignature(model),
			},
		),
	});
	const messages = sdkMessages(model, normalized).filter(
		(message) => message.role !== "system" || message.content.trim().length > 0,
	);
	const emptyMessages = messages.length === 0;
	if (emptyMessages) messages.push({ role: "user", content: "<empty>" });
	const assistants = normalized.messages.filter((m) => m.role === "assistant");
	let assistantIndex = 0;
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		const original = assistants[assistantIndex++];
		if (typeof message.content === "string") continue;
		let reasoningIndex = 0;
		const reasoning = original.content.filter((b) => b.type === "thinking");
		for (const part of message.content) {
			if (part.type !== "reasoning") continue;
			const block = reasoning[reasoningIndex++];
			if (block?.thinkingSignature)
				part.providerOptions = {
					bedrock: block.redacted
						? { redactedContent: block.thinkingSignature }
						: { signature: block.thinkingSignature },
				};
			if (block?.redacted) part.text = "";
		}
	}
	const tools =
		options.toolChoice === "none"
			? {}
			: anthropicSdkTools(getCurrentTools(normalized.messages), model.compat?.supportsStrictMode ?? false);
	const syntheticTools = Object.keys(tools).length === 0;
	if (syntheticTools) {
		for (const message of messages) {
			if (!Array.isArray(message.content)) continue;
			for (const part of message.content) {
				if (part.type === "tool-call" || part.type === "tool-result")
					tools[part.toolName] = tool({ inputSchema: jsonSchema({ type: "object", properties: {} }) });
			}
		}
	}
	const retention = resolveLayeredCacheRetention(options);
	const shortInstructions = retention.instructions !== "none" && !longCacheTtl(model, retention.instructions).ttl;
	const history = shortInstructions && longCacheTtl(model, retention.history).ttl ? "short" : retention.history;
	const point = (value: typeof retention.history) =>
		value !== "none" && supportsPromptCaching(model, options.env)
			? { bedrock: { cachePoint: { type: "default", ...longCacheTtl(model, value) } } }
			: undefined;
	const initial = getInitialSystemMessage(normalized.messages);
	const split = initial
		? splitSystemMessageIntoBlocks(initial, options.instructionCacheBoundary, options.instructionVolatileBoundary)
		: undefined;
	const systemIndex = messages.findIndex((m) => m.role === "system");
	if (systemIndex >= 0 && split) {
		const system: ModelMessage[] = split.cached.map((content) => ({
			role: "system",
			content,
			providerOptions: point(retention.instructions),
		}));
		if (split.volatile !== undefined) system.push({ role: "system", content: split.volatile });
		messages.splice(systemIndex, 1, ...system);
	} else if (systemIndex >= 0) messages[systemIndex].providerOptions = point(retention.instructions);
	const toolCachePoint =
		!syntheticTools && Object.keys(tools).length && keepsToolBreakpoint(split) && supportsToolCachePoint(model)
			? point(retention.instructions)?.bedrock.cachePoint
			: undefined;
	const last = messages.at(-1);
	if (last?.role === "user" || last?.role === "tool") {
		last.providerOptions = point(history);
		const assistant = messages.findLastIndex((m) => m.role === "assistant");
		const previous = messages[assistant - 1];
		const used = messages.filter((m) => m.providerOptions?.bedrock?.cachePoint).length + (toolCachePoint ? 1 : 0);
		if (previous && (previous.role === "user" || previous.role === "tool") && used < 4)
			previous.providerOptions = point(history);
	}
	if (isNovaExplicitCacheModel(model)) {
		let prefix = charsToTokens(JSON.stringify(syntheticTools ? {} : tools).length);
		for (const message of messages) {
			prefix += charsToTokens(JSON.stringify(message.content).length);
			if (Array.isArray(message.content))
				prefix += message.content.filter((p) => p.type === "image").length * ESTIMATED_IMAGE_TOKENS;
			if (prefix >= 20_000) delete message.providerOptions;
		}
	}
	const rich = bedrockRichEvents();
	let rawUsage: Usage | undefined;
	let redactedChunks: Uint8Array[] = [];
	let redactedIndex: number | undefined;
	const redactedSignature = () => Buffer.concat(redactedChunks).toString("base64");
	let requestId: string | undefined;
	let responseRetryAfterMs: number | undefined;
	return {
		messages,
		tools,
		model: (fetch) => bedrockSdkModel(model, options, fetch),
		networkFetch: bedrockNetworkFetch(model, options, (response) => {
			requestId = response.headers.get("x-amzn-requestid") ?? undefined;
			responseRetryAfterMs = parseRetryAfterMs(response.headers);
		}),
		augmentRequest(body) {
			if (Array.isArray(body.system) && body.system.length === 0) delete body.system;
			if (emptyMessages) body.messages = [];
			if (syntheticTools) delete body.toolConfig;
			const wireMessages = body.messages as {
				content: { toolResult?: { toolUseId: string; status?: string; content: unknown[] } }[];
			}[];
			for (const message of wireMessages)
				for (const block of message.content) {
					const result = block.toolResult;
					if (!result) continue;
					const original = normalized.messages.find(
						(m) => m.role === "toolResult" && m.toolCallId === result.toolUseId,
					);
					if (original?.role !== "toolResult") continue;
					result.status = original.isError ? "error" : "success";
					if (original.content.every((part) => part.type === "text"))
						result.content = original.content.map((part) => ({ text: part.text }));
				}
			const wireTools = (
				body.toolConfig as
					| { tools?: { toolSpec?: { strict?: boolean; inputSchema?: { json?: { required?: unknown[] } } } }[] }
					| undefined
			)?.tools;
			for (const entry of wireTools ?? []) {
				const schema = entry.toolSpec?.inputSchema?.json;
				if (!entry.toolSpec?.strict && schema?.required?.length === 0) delete schema.required;
			}
			const config = body.toolConfig as { tools?: unknown[] } | undefined;
			if (toolCachePoint && config?.tools?.length) config.tools.push({ cachePoint: toolCachePoint });
		},
		toolChoice:
			options.toolChoice === "any"
				? "required"
				: typeof options.toolChoice === "object"
					? { type: "tool", toolName: options.toolChoice.name }
					: options.toolChoice,
		includeRawChunks: true,
		providerOptions: {
			bedrock: {
				additionalModelRequestFields: buildAdditionalModelRequestFields(model, options),
				requestMetadata: options.requestMetadata,
			},
		},
		usage: (usage) => {
			const result = rawUsage ?? sdkUsage(usage);
			calculateCost(model, result);
			return result;
		},
		onPart(part, output, stream) {
			if (part.type === "finish" && part.rawFinishReason === "model_context_window_exceeded")
				part.finishReason = "length";
			if (part.type === "error" && rich.handledError(part.error)) return true;
			if (
				(part.type === "text-start" || part.type === "text-delta" || part.type === "text-end") &&
				rich.isNative(part.id)
			)
				return true;
			if (part.type === "finish-step") requestId = part.response.id;
			if (part.type === "error") {
				appendBedrockFailureDiagnostic(output, part.error, requestId);
				// Stream errors carry the exception in `type`; an HTTP error response names it in `x-amzn-errortype`
				// ("ValidationException:http://...").
				const error = part.error as Error & { type?: unknown; responseHeaders?: Record<string, string> };
				const type =
					typeof error?.type === "string" ? error.type : error?.responseHeaders?.["x-amzn-errortype"]?.split(":")[0];
				if (part.error instanceof Error && type?.endsWith("Exception")) {
					const name = type[0].toUpperCase() + type.slice(1);
					part.error.message = formatBedrockError(Object.assign(new Error(part.error.message), { name }));
					if (responseRetryAfterMs !== undefined) output.retryAfterMs = responseRetryAfterMs;
				}
			}
			if (options.thinkingBudgetReduction) output.thinkingBudget = options.thinkingBudgetReduction;
			if (part.type === "raw") {
				rich.accept(part.rawValue, output, stream);
				const event = part.rawValue as {
					contentBlockDelta?: {
						contentBlockIndex?: number;
						delta?: { reasoningContent?: { redactedContent?: string } };
					};
					contentBlockStart?: unknown;
					messageStop?: unknown;
					metadata?: {
						usage?: {
							inputTokens?: number;
							outputTokens?: number;
							totalTokens?: number;
							cacheReadInputTokens?: number;
							cacheWriteInputTokens?: number;
							cacheDetails?: { ttl?: string; inputTokens?: number }[];
						};
					};
				};
				if (event.contentBlockStart) redactedChunks = [];
				const encrypted = event.contentBlockDelta?.delta?.reasoningContent?.redactedContent;
				if (encrypted) {
					if (redactedIndex !== event.contentBlockDelta?.contentBlockIndex) redactedChunks = [];
					redactedIndex = event.contentBlockDelta?.contentBlockIndex;
					redactedChunks.push(Buffer.from(encrypted, "base64"));
				}
				if (event.messageStop && redactedChunks.length) {
					const thinking = output.content.findLast((block) => block.type === "thinking");
					if (thinking?.type === "thinking") {
						thinking.redacted = true;
						thinking.thinkingSignature = redactedSignature();
						thinking.thinking = REDACTED_THINKING_PLACEHOLDER;
					}
				}
				const usage = event.metadata?.usage;
				if (usage) {
					rawUsage = createUsage({
						input: usage.inputTokens ?? 0,
						output: usage.outputTokens ?? 0,
						cacheRead: usage.cacheReadInputTokens ?? 0,
						cacheWrite: usage.cacheWriteInputTokens ?? 0,
					});
					rawUsage.cacheWrite1h = usage.cacheDetails?.reduce(
						(total, d) => total + (d.ttl === "1h" ? (d.inputTokens ?? 0) : 0),
						0,
					);
					rawUsage.totalTokens = sumUsageTokens(rawUsage, usage.totalTokens);
					output.usage = rawUsage;
					calculateCost(model, output.usage);
				}
			}
			if (part.type === "reasoning-end" || part.type === "reasoning-delta") {
				const meta = part.providerMetadata?.bedrock ?? part.providerMetadata?.amazonBedrock;
				const block = output.content.findLast((b) => b.type === "thinking");
				if (block?.type === "thinking") {
					if (typeof meta?.signature === "string")
						block.thinkingSignature = (block.thinkingSignature ?? "") + meta.signature;
					if (typeof meta?.redactedContent === "string" || redactedChunks.length > 0) {
						block.redacted = true;
						block.thinkingSignature = redactedChunks.length
							? redactedSignature()
							: typeof meta?.redactedContent === "string"
								? meta.redactedContent
								: undefined;
						block.thinking = REDACTED_THINKING_PLACEHOLDER;
					}
				}
			}
			return false;
		},
	};
}

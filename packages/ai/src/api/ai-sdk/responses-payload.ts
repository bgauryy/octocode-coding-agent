import type { TranscriptContext } from "../../types.ts";
import type { ResponsesModel } from "./responses-model.ts";
import { azureInstructionCacheTtl } from "../azure-openai-config.ts";
import { splitSystemMessageIntoBlocks } from "../../utils/instruction-split.ts";
import { resolveOpenAIResponsesCacheFields } from "../openai-prompt-cache.ts";
import { getCompat, isChatGPTSignIn } from "../openai-responses/compat.ts";
import type { OpenAIResponsesOptions } from "../openai-responses/types.ts";
import { resolveSamplingParams } from "../simple-options.ts";
import { responsesReplayMessages } from "./responses-messages.ts";
import { parseTextSignature } from "../openai-responses-shared/text-signature.ts";
import { fastHash } from "../../utils/hash.ts";
import { getResponsesToolSupport } from "../openai-responses-shared/tools.ts";

export function responsesPayload(model: ResponsesModel, context: TranscriptContext, options: OpenAIResponsesOptions) {
	return (body: Record<string, unknown>): void => {
		const signIn = isChatGPTSignIn(model, options.apiKey);
		// The SDK requires a registered search tool for replay, but loading past tools does not expose a new callable tool.
		if (getResponsesToolSupport(getCompat(model)) === "additions" && Array.isArray(body.tools))
			body.tools = body.tools.filter((tool) => tool.type !== "tool_search");
		if (options.temperature !== undefined && getCompat(model).supportsTemperature && !signIn)
			body.temperature = options.temperature;
		if (options.toolChoice !== undefined) body.tool_choice = options.toolChoice;
		if (signIn) {
			delete body.temperature;
			delete body.max_output_tokens;
		}
		const azure = model.api === "azure-openai-responses";
		const cache = resolveOpenAIResponsesCacheFields(getCompat(model), options, signIn, !azure);
		if (azure && context.messages.length === 0) body.input = [];
		if (azure && Array.isArray(body.tools)) {
			for (const tool of body.tools) if (tool.strict === false) delete tool.strict;
		}
		const instructionTtl = cache.instructionCacheTtl ?? (azure ? azureInstructionCacheTtl(model, options) : undefined);
		if (azure && cache.instructionCacheTtl === "12h")
			body.prompt_cache_options = { ...cache.prompt_cache_options, ttl: "12h" };
		const initial = context.messages[0];
		if (instructionTtl && initial?.role === "system" && Array.isArray(body.input)) {
			const item = body.input.find(
				(value) => value && value.content !== undefined && ["system", "developer"].includes(value.role),
			);
			if (item) {
				const blocks = splitSystemMessageIntoBlocks(
					initial,
					options.instructionCacheBoundary,
					options.instructionVolatileBoundary,
				);
				const cached = (text: string) => ({
					type: "input_text",
					text,
					prompt_cache_breakpoint: azure ? { mode: "explicit" } : { mode: "explicit", ttl: instructionTtl },
				});
				const text =
					typeof item.content === "string"
						? item.content
						: item.content.map((part: { text?: string }) => part.text ?? "").join("");
				item.content = blocks
					? [
							...blocks.cached.map(cached),
							...(blocks.volatile === undefined ? [] : [{ type: "input_text", text: blocks.volatile }]),
						]
					: [cached(text)];
			}
		}
		// With store:false the SDK omits replay item IDs and serializes assistant text as a string.
		// Restore the stable message envelope used by cached transcript prefixes.
		if (Array.isArray(body.input)) {
			const texts: { id: string }[] = [];
			const calls: { id?: string }[] = [];
			const replay = responsesReplayMessages(model, context);
			for (const [index, message] of replay.entries()) {
				if (message.role !== "assistant") continue;
				let textIndex = 0;
				for (const block of message.content) {
					if (block.type === "text") {
						const signature = parseTextSignature(block.textSignature);
						const position = index - (replay[0]?.role === "system" ? 1 : 0);
						const fallback = `msg_pi_${position}${textIndex === 0 ? "" : `_${textIndex}`}`;
						const id = signature?.id ?? fallback;
						texts.push({ id: id.length > 64 ? `msg_${fastHash(id)}` : id });
						textIndex++;
					} else if (block.type === "toolCall") {
						const itemId = block.id.split("|")[1];
						const differentModel =
							message.provider === model.provider && message.api === model.api && message.model !== model.id;
						calls.push({
							id: !differentModel && (itemId?.startsWith("fc_") || itemId?.startsWith("ctc_")) ? itemId : undefined,
						});
					}
				}
			}
			let textIndex = 0;
			let callIndex = 0;
			for (const item of body.input) {
				if (item.role === "assistant" && typeof item.content === "string") {
					const metadata = texts[textIndex++];
					item.type = "message";
					item.status = "completed";
					if (metadata) item.id = metadata.id;
					item.content = [{ type: "output_text", text: item.content, annotations: [] }];
				} else if (item.type === "function_call" || item.type === "custom_tool_call") {
					const metadata = calls[callIndex++];
					if (metadata?.id !== undefined) item.id = metadata.id;
				}
			}
		}
		const effort = options.reasoningEffort ?? (options.reasoningSummary ? "medium" : "off");
		Object.assign(body, resolveSamplingParams(model, effort, options.samplingParams));
	};
}

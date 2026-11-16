import { jsonSchema, tool, type ToolChoice, type ToolSet, type TextStreamPart, type LanguageModelUsage } from "ai";
import type { GoogleChunk as GenerateContentResponse } from "./google-shapes.ts";
import type { AssistantMessageEventStream } from "../../utils/event-stream.ts";
import { applyGoogleAnnotations } from "./google-rich-content.ts";
import type { AssistantMessage, Model, TranscriptContext } from "../../types.ts";
import { collapseSystemMessages, getCurrentTools } from "../../utils/transcript.ts";
import { getJsonSchemaToolParameters, resolveJsonSchemaStrictSampling } from "../constrained-sampling.ts";
import type { GoogleBaseOptions } from "./google-options.ts";
import { supportsGoogleStrictToolSampling } from "./google-capabilities.ts";
import { googleSdkMessages } from "./google-messages.ts";
import { googleTextParts } from "./google-text.ts";
import { googleRequestIds } from "./google-ids.ts";
import { normalizeGoogleUsage, type GoogleUsageMetadata } from "./google-usage.ts";
import { sdkUsage } from "./events.ts";
import { calculateCost } from "../../models/model-helpers.ts";

export function googleSdkMapping(
	model: Model<"google-generative-ai" | "google-vertex">,
	context: TranscriptContext,
	options?: GoogleBaseOptions,
) {
	const supportsStrict = supportsGoogleStrictToolSampling(model.id);
	const text = googleTextParts();
	let rawUsage: GoogleUsageMetadata | undefined;
	const tools: ToolSet = Object.fromEntries(
		getCurrentTools(context.messages).map((definition) => {
			const strict = resolveJsonSchemaStrictSampling(definition, supportsStrict);
			return [
				definition.name,
				tool({
					description: definition.description,
					inputSchema: jsonSchema(getJsonSchemaToolParameters(definition, strict)),
					strict,
				}),
			];
		}),
	);
	const toolChoice: ToolChoice<ToolSet> | undefined = options?.toolChoice === "any" ? "required" : options?.toolChoice;
	let pendingCandidate: NonNullable<GenerateContentResponse["candidates"]>[number] | undefined;
	const onPart = (
		part: TextStreamPart<ToolSet>,
		output: AssistantMessage,
		stream: AssistantMessageEventStream,
	): boolean => {
		text.drain(output, stream);
		if (part.type === "tool-call") text.tool();
		if (
			["text-start", "text-delta", "text-end", "reasoning-start", "reasoning-delta", "reasoning-end"].includes(
				part.type,
			)
		)
			return true;
		if (part.type === "raw") {
			if (pendingCandidate) applyGoogleAnnotations(output, pendingCandidate, stream);
			const chunk = part.rawValue as GenerateContentResponse;
			if (chunk.usageMetadata) {
				rawUsage = chunk.usageMetadata;
				output.usage = { ...normalizeGoogleUsage(rawUsage), lowerBound: true };
				calculateCost(model, output.usage);
			}
			const candidate = chunk.candidates?.[0];
			pendingCandidate = candidate;
			text.append(candidate?.content?.parts ?? []);
			text.drain(output, stream);
			return true;
		}
		if (part.type === "file" || part.type === "reasoning-file") {
			return true;
		}
		if (part.type === "finish-step") {
			text.end(output, stream);
			if (pendingCandidate) applyGoogleAnnotations(output, pendingCandidate, stream);
			pendingCandidate = undefined;
		}
		return (
			part.type === "source" ||
			part.type === "tool-result" ||
			(part.type === "tool-error" && part.providerExecuted === true)
		);
	};
	const messages = googleSdkMessages(model, collapseSystemMessages(context));
	return {
		messages,
		usage: (usage: LanguageModelUsage) => {
			const result = rawUsage ? normalizeGoogleUsage(rawUsage) : sdkUsage(usage);
			calculateCost(model, result);
			return result;
		},
		augmentRequest: googleRequestIds(model.id, messages),
		tools,
		toolChoice,
		includeRawChunks: true,
		onPart,
	};
}

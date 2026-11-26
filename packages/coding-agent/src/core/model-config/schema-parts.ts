/** Schema pieces shared by the models.json provider, model and override entries. */

import { Type } from "typebox";

const SamplingParamsSchema = Type.Record(Type.String(), Type.Unknown());
export const SamplingParamsByThinkingLevelSchema = Type.Object(
	{
		off: Type.Optional(SamplingParamsSchema),
		minimal: Type.Optional(SamplingParamsSchema),
		low: Type.Optional(SamplingParamsSchema),
		medium: Type.Optional(SamplingParamsSchema),
		high: Type.Optional(SamplingParamsSchema),
		xhigh: Type.Optional(SamplingParamsSchema),
		max: Type.Optional(SamplingParamsSchema),
	},
	{ description: "samplingParams per thinking level, merged over samplingParams." },
);

export const SamplingParamsFieldSchema = Type.Record(Type.String(), Type.Unknown(), {
	description: "Fields merged into every request body. Applies only to OpenAI-compatible APIs.",
});
export const HeadersSchema = Type.Record(Type.String(), Type.String(), {
	description: "Request headers. Values resolve like apiKey.",
});

export const RequestsPerMinuteSchema = Type.Integer({
	minimum: 0,
	description:
		"Most requests a session sends to this provider per minute (sliding 60 s window). 0 turns the limit off. A model's value wins over its provider's, which wins over the requestsPerMinute setting.",
});

export const TokensPerMinuteSchema = Type.Integer({
	minimum: 1,
	description:
		"Most tokens a model may use per minute across all sessions on this machine: uncached input plus output (cache reads are not counted; a Bedrock model that burns output down counts it at that rate). A request over the budget waits for room. A model's value wins over its provider's; for Bedrock Kimi the OCTOCODE_BEDROCK_KIMI_TPM environment variable wins over both.",
});

/** Model fields shared by models entries and modelOverrides entries. Defaults apply only to models entries. */
export const ModelFieldDescriptions = {
	name: "Display name, also matched by --model patterns.",
	reasoning: "Whether the model supports thinking.",
	contextWindow: "Context window in tokens.",
	maxTokens: "Maximum output tokens.",
	input: 'Accepted input modalities. Include "image" only when this model and endpoint accept image attachments.',
} as const;

import { ProviderCompatSchema } from "@octocodeai/octocode-ai/providers/compat-schema";
import {
	ModelCostSchema,
	ModelInputLimitsSchema,
	ModelInputModalitySchema,
	ModelPromptCacheSchema,
	ThinkingLevelMapSchema,
} from "@octocodeai/octocode-ai/providers/model-schema";
import { isRecord } from "@octocodeai/octocode-contracts/guards";
import { Type } from "typebox";
import { compileLazily } from "../utils/compile-lazily.ts";

const positiveTokens = Type.Number({ exclusiveMinimum: 0 });
const base = {
	id: Type.String({ minLength: 1 }),
	name: Type.String(),
	api: Type.String({ minLength: 1 }),
	provider: Type.String({ minLength: 1 }),
	baseUrl: Type.String({ minLength: 1 }),
	input: Type.Array(ModelInputModalitySchema),
	inputLimits: Type.Optional(ModelInputLimitsSchema),
	cost: ModelCostSchema,
	headers: Type.Optional(Type.Record(Type.String(), Type.String())),
};
const validateBase = compileLazily(Type.Object(base));
const validateKnown = compileLazily(
	Type.Union([
		Type.Object({
			...base,
			type: Type.Optional(Type.Literal("chat")),
			reasoning: Type.Boolean(),
			contextWindow: positiveTokens,
			maxTokens: positiveTokens,
			thinkingLevelMap: Type.Optional(ThinkingLevelMapSchema),
			promptCache: Type.Optional(ModelPromptCacheSchema),
			compat: Type.Optional(ProviderCompatSchema),
		}),
		Type.Object({ ...base, type: Type.Literal("image"), output: Type.Array(ModelInputModalitySchema) }),
		Type.Object({ ...base, type: Type.Literal("classifier"), contextWindow: positiveTokens }),
	]),
);

/** Validate persisted models before typed consumers read them, while retaining future model types for their filter. */
export function isStoredModel(value: unknown): boolean {
	if (!isRecord(value)) return false;
	if (value.type !== undefined && !["chat", "image", "classifier"].includes(value.type as string)) {
		return typeof value.type === "string" && validateBase().Check(value);
	}
	return validateKnown().Check(value);
}

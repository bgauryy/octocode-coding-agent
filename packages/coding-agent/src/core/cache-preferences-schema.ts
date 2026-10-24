import { CACHE_RETENTIONS } from "@octocodeai/octocode-ai/providers/model-schema";
import { Type } from "typebox";

const retention = (description: string) =>
	Type.Union(
		[Type.Literal(CACHE_RETENTIONS[0]), Type.Literal(CACHE_RETENTIONS[1]), Type.Literal(CACHE_RETENTIONS[2])],
		{ description },
	);

export const CachePreferenceProperties = {
	cacheRetention: Type.Optional(
		retention("Conversation cache retention. Without a separate instruction preference, applies to both layers."),
	),
	instructionCacheRetention: Type.Optional(
		retention("Instruction cache retention, limited by endpoint capabilities. Long writes can cost more."),
	),
};

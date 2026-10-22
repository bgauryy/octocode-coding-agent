import { CACHE_RETENTION_VALUES } from "@octocodeai/octocode-ai/utils/cache-policy";
import { Type } from "typebox";

const retention = (description: string) =>
	Type.Union(
		[
			Type.Literal(CACHE_RETENTION_VALUES[0]),
			Type.Literal(CACHE_RETENTION_VALUES[1]),
			Type.Literal(CACHE_RETENTION_VALUES[2]),
		],
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

import { Type } from "typebox";
import { SETTINGS_DEFAULTS } from "../settings-defaults.ts";

/** The `cacheWarming` setting of the root schema. */
export const CacheWarmingSchema = Type.Union([Type.Literal("off"), Type.Literal("streaming"), Type.Literal("idle")], {
	description:
		'Cache-warming profile. "idle" also warms between agent runs. Global only because each refresh costs money.',
	default: SETTINGS_DEFAULTS.cacheWarming,
});

import type { CacheWarmingMode } from "../settings-schema.ts";

/** Cache-warming profile. "idle" also warms between agent runs. */
export const CACHE_WARMING_MODES = ["off", "streaming", "idle"] as const satisfies readonly CacheWarmingMode[];

/** Octocode's palettes, chosen by the terminal's appearance (`light/dark` setting form). `system` stays selectable. */
export const DEFAULT_THEME_SETTING = "octocode-light/octocode-dark";

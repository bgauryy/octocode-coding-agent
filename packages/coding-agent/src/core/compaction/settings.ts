import { SETTINGS_DEFAULTS } from "../settings-defaults.ts";

export function builtInCompactionSettings(model?: { contextWindow?: number }) {
	const defaults = SETTINGS_DEFAULTS.compaction;
	const window = model?.contextWindow;
	if (window === undefined || !Number.isFinite(window) || window <= 0) return { ...defaults };
	return {
		enabled: true,
		reserveTokens: Math.min(defaults.reserveTokens, Math.max(1, Math.floor(window / 8))),
		keepRecentTokens: Math.min(defaults.keepRecentTokens, Math.max(1, Math.floor(window / 4))),
	};
}

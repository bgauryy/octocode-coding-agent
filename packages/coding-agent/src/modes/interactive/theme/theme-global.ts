import type { Theme } from "./theme-class.ts";

// ============================================================================
// Global Theme Instance
// ============================================================================

// Use globalThis to share theme across module loaders (node + jiti in dev mode)
const THEME_KEY = Symbol.for("@octocodeai/octocodecode:theme");

// Export theme as a getter that reads from globalThis
// This ensures all module instances (node, jiti) see the same theme
export const theme: Theme = new Proxy({} as Theme, {
	get(_target, prop) {
		const t = (globalThis as Record<symbol, Theme>)[THEME_KEY];
		if (!t) throw new Error("Theme not initialized. Call initTheme() first.");
		return (t as unknown as Record<string | symbol, unknown>)[prop];
	},
});

export function setGlobalTheme(t: Theme): void {
	(globalThis as Record<symbol, Theme>)[THEME_KEY] = t;
}

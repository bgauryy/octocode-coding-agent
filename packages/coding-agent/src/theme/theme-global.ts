import type { Theme } from "./theme-class.ts";

// Use globalThis so every module instance of this file sees the same theme
const THEME_KEY = Symbol.for("@octocodeai/octocode-agent:theme");

// Export theme as a getter that reads from globalThis
// This ensures all module instances see the same theme
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

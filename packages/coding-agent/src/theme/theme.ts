import * as fs from "node:fs";
import * as path from "node:path";
import { colorToHex, indexedColor, parseColor } from "@octocodeai/octocode-tui";
import { getCustomThemesDir } from "../config.ts";
import { closeWatcher, watchWithErrorHandler } from "../utils/fs-watch.ts";
import { SYSTEM_THEME_NAME } from "./system-theme.ts";
import { resolveVarRefs, type Theme } from "./theme-class.ts";
import { setGlobalTheme } from "./theme-global.ts";
import { getBuiltinThemes, loadTheme, loadThemeFromPath, loadThemeJson, registeredThemes } from "./theme-loader.ts";
import type { ThemeColorValue } from "./theme-schema.ts";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";

// ============================================================================
// Types & Schema
// ============================================================================

export type { ThemeAppearance, ThemeBg, ThemeColor, ThemeToken } from "./theme-types.ts";
export { Theme, type ThemeStyle } from "./theme-class.ts";
export { theme } from "./theme-global.ts";
export {
	getAvailableThemes,
	getAvailableThemesWithPaths,
	getThemeByName,
	loadThemeFromPath,
	setRegisteredThemes,
	setThemeJsonValidator,
} from "./theme-loader.ts";
export {
	detectColorFgBgTheme,
	detectTerminalTheme,
	getTerminalTheme,
	markTerminalColorsPending,
	parseAutoThemeSetting,
	resolveThemeSetting,
	setTerminalColorScheme,
	setTerminalColors,
} from "./theme-terminal.ts";
export {
	getEditorTheme,
	getLanguageFromPath,
	getMarkdownTheme,
	getSelectListTheme,
	getSettingsListTheme,
	highlightCode,
} from "./theme-tui-helpers.ts";

// ============================================================================
// Global Theme Instance
// ============================================================================

let currentThemeName: string | undefined;
let themeWatcher: fs.FSWatcher | undefined;
let themeReloadTimer: NodeJS.Timeout | undefined;
let onThemeChangeCallback: (() => void) | undefined;

export function initTheme(themeName?: string, enableWatcher: boolean = false): void {
	const name = themeName ?? SYSTEM_THEME_NAME;
	currentThemeName = name;
	try {
		setGlobalTheme(loadTheme(name));
		if (enableWatcher) {
			startThemeWatcher();
		}
	} catch (_error) {
		// Theme is invalid - fall back to the system theme silently
		currentThemeName = SYSTEM_THEME_NAME;
		setGlobalTheme(loadTheme(SYSTEM_THEME_NAME));
		// Don't start watcher for fallback theme
	}
}

export function setTheme(name: string, enableWatcher: boolean = false): { success: boolean; error?: string } {
	currentThemeName = name;
	try {
		setGlobalTheme(loadTheme(name));
		if (enableWatcher) {
			startThemeWatcher();
		}
		if (onThemeChangeCallback) {
			onThemeChangeCallback();
		}
		return { success: true };
	} catch (error) {
		// Theme is invalid - fall back to the system theme
		currentThemeName = SYSTEM_THEME_NAME;
		setGlobalTheme(loadTheme(SYSTEM_THEME_NAME));
		// Don't start watcher for fallback theme
		return {
			success: false,
			error: errorMessage(error),
		};
	}
}

export function setThemeInstance(themeInstance: Theme): void {
	setGlobalTheme(themeInstance);
	currentThemeName = "<in-memory>";
	stopThemeWatcher(); // Can't watch a direct instance
	if (onThemeChangeCallback) {
		onThemeChangeCallback();
	}
}

export function onThemeChange(callback: () => void): void {
	onThemeChangeCallback = callback;
}

function startThemeWatcher(): void {
	stopThemeWatcher();

	// Only watch if it's a custom theme (not built-in)
	if (
		!currentThemeName ||
		Object.hasOwn(getBuiltinThemes(), currentThemeName) ||
		currentThemeName === SYSTEM_THEME_NAME
	) {
		return;
	}

	const customThemesDir = getCustomThemesDir();
	const watchedThemeName = currentThemeName;
	const watchedFileName = `${watchedThemeName}.json`;
	const themeFile = path.join(customThemesDir, watchedFileName);

	// Only watch if the file exists
	if (!fs.existsSync(themeFile)) {
		return;
	}

	const scheduleReload = () => {
		if (themeReloadTimer) {
			clearTimeout(themeReloadTimer);
		}
		themeReloadTimer = setTimeout(() => {
			themeReloadTimer = undefined;

			// Ignore stale timers after switching themes or stopping the watcher
			if (currentThemeName !== watchedThemeName) {
				return;
			}

			// Keep the last successfully loaded theme active if the file is temporarily missing
			if (!fs.existsSync(themeFile)) {
				return;
			}

			try {
				// Reload the theme from disk and refresh the registry cache
				const reloadedTheme = loadThemeFromPath(themeFile);
				registeredThemes.set(watchedThemeName, reloadedTheme);
				setGlobalTheme(reloadedTheme);
				// Notify callback (to invalidate UI)
				if (onThemeChangeCallback) {
					onThemeChangeCallback();
				}
			} catch (_error) {
				// Ignore errors (file might be in invalid state while being edited)
			}
		}, 100);
	};

	themeWatcher =
		watchWithErrorHandler(
			customThemesDir,
			(_eventType, filename) => {
				if (currentThemeName !== watchedThemeName) {
					return;
				}
				if (!filename) {
					scheduleReload();
					return;
				}
				if (filename !== watchedFileName) {
					return;
				}
				scheduleReload();
			},
			() => {
				closeWatcher(themeWatcher);
				themeWatcher = undefined;
			},
		) ?? undefined;
}

export function stopThemeWatcher(): void {
	if (themeReloadTimer) {
		clearTimeout(themeReloadTimer);
		themeReloadTimer = undefined;
	}
	closeWatcher(themeWatcher);
	themeWatcher = undefined;
}

// ============================================================================
// HTML Export Helpers
// ============================================================================

/**
 * Get resolved theme colors as CSS-compatible hex strings.
 * Used by HTML export to generate CSS custom properties.
 */
export function getResolvedThemeColors(themeName?: string): Record<string, string> {
	const colors = loadTheme(themeName ?? currentThemeName ?? SYSTEM_THEME_NAME).colors;
	return Object.fromEntries(Object.entries(colors).map(([token, color]) => [token, colorToHex(color)]));
}

/**
 * Get explicit export colors from theme JSON, if specified.
 * Returns undefined for each color that isn't explicitly set.
 */
export function getThemeExportColors(themeName?: string): {
	pageBg?: string;
	cardBg?: string;
	infoBg?: string;
} {
	const name = themeName ?? currentThemeName ?? SYSTEM_THEME_NAME;
	if (name === SYSTEM_THEME_NAME) return {};
	try {
		const themeJson = loadThemeJson(name);
		const exportSection = themeJson.export;
		if (!exportSection) return {};

		const vars = themeJson.vars ?? {};
		// Export colors end up in CSS, which understands hex and oklch() values directly but not okhsl().
		const resolve = (value: ThemeColorValue | undefined): string | undefined => {
			if (value === undefined) return undefined;
			const resolved = resolveVarRefs(value, vars);
			if (typeof resolved === "number") return colorToHex(indexedColor(resolved));
			if (resolved === "") return undefined;
			if (/^okhsl\(/i.test(resolved)) return colorToHex(parseColor(resolved));
			return resolved;
		};

		return {
			pageBg: resolve(exportSection.pageBg),
			cardBg: resolve(exportSection.cardBg),
			infoBg: resolve(exportSection.infoBg),
		};
	} catch {
		return {};
	}
}

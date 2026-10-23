import * as fs from "node:fs";
import * as path from "node:path";
import { getTerminalColorMode, type TerminalColorMode } from "@octocodeai/octocode-tui";
import { getCustomThemesDir, getThemesDir } from "../../../config.ts";
import { stripBom } from "../../../utils/text.ts";
import { generateSystemThemeColors, SYSTEM_THEME_NAME } from "./system-theme.ts";
import { resolveThemeColors, splitThemeColors, Theme, withThemeTokenFallbacks } from "./theme-class.ts";
import type { ValidatedThemeJson as ThemeJson } from "./theme-schema.ts";
import { areTerminalColorsPending, getTerminalColors, getTerminalTheme } from "./theme-terminal.ts";

export type ThemeJsonValidator = (label: string, json: unknown) => ThemeJson;

let themeJsonValidator: ThemeJsonValidator | undefined;

/**
 * Install full theme validation. Without it, documents are accepted as-is, which is what built-in
 * themes already do: validating user-authored JSON needs typebox, and a presentation that only uses
 * built-in themes should not pay ~17 MB of module graph for it.
 */
export function setThemeJsonValidator(validator: ThemeJsonValidator): void {
	themeJsonValidator = validator;
}

/** Themes registered by the resource loader, by name. The theme watcher replaces entries it reloads. */
export const registeredThemes = new Map<string, Theme>();

export function setRegisteredThemes(themes: Theme[]): void {
	registeredThemes.clear();
	for (const theme of themes) {
		if (theme.name) {
			assertThemeNameIsValid(theme.name);
			registeredThemes.set(theme.name, theme);
		}
	}
}

// ============================================================================
// Theme Loading
// ============================================================================

let BUILTIN_THEMES: Record<string, ThemeJson> | undefined;

export function getBuiltinThemes(): Record<string, ThemeJson> {
	if (!BUILTIN_THEMES) {
		const themesDir = getThemesDir();
		BUILTIN_THEMES = Object.fromEntries(
			fs
				.readdirSync(themesDir, { withFileTypes: true })
				.filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
				.map((entry) => [
					path.basename(entry.name, ".json"),
					JSON.parse(stripBom(fs.readFileSync(path.join(themesDir, entry.name), "utf-8"))) as ThemeJson,
				]),
		);
	}
	return BUILTIN_THEMES;
}

export function getAvailableThemes(): string[] {
	return getAvailableThemesWithPaths().map(({ name }) => name);
}

export interface ThemeInfo {
	name: string;
	path: string | undefined;
}

export function getAvailableThemesWithPaths(): ThemeInfo[] {
	const themesDir = getThemesDir();
	const result: ThemeInfo[] = [];
	const seen = new Set<string>();
	const addTheme = (themeInfo: ThemeInfo) => {
		if (seen.has(themeInfo.name)) {
			return;
		}
		seen.add(themeInfo.name);
		result.push(themeInfo);
	};

	// Built-in themes. The system theme is generated, so it has no file.
	addTheme({ name: SYSTEM_THEME_NAME, path: undefined });
	for (const name of Object.keys(getBuiltinThemes())) {
		addTheme({ name, path: path.join(themesDir, `${name}.json`) });
	}

	// Custom themes
	for (const themeInfo of getCustomThemeInfos()) {
		addTheme(themeInfo);
	}

	for (const [name, theme] of registeredThemes.entries()) {
		addTheme({ name, path: theme.sourcePath });
	}

	// The system theme comes first: it is the default and adapts to every terminal.
	return result.sort((a, b) =>
		a.name === SYSTEM_THEME_NAME ? -1 : b.name === SYSTEM_THEME_NAME ? 1 : a.name.localeCompare(b.name),
	);
}

function getCustomThemeInfos(): ThemeInfo[] {
	const customThemesDir = getCustomThemesDir();
	const result: ThemeInfo[] = [];
	if (!fs.existsSync(customThemesDir)) {
		return result;
	}

	for (const file of fs.readdirSync(customThemesDir)) {
		if (!file.endsWith(".json")) {
			continue;
		}
		const themePath = path.join(customThemesDir, file);
		try {
			const customTheme = loadThemeFromPath(themePath);
			if (customTheme.name) {
				result.push({ name: customTheme.name, path: themePath });
			}
		} catch {
			// Invalid themes are ignored here; the resource loader reports them
			// during normal startup/reload.
		}
	}
	return result;
}

function assertThemeNameIsValid(name: string): void {
	if (name.includes("/")) {
		throw new Error(
			`Invalid theme name "${name}": theme names cannot contain "/" because it is reserved for automatic light/dark theme settings.`,
		);
	}
}

function parseThemeJson(label: string, json: unknown): ThemeJson {
	if (themeJsonValidator) return themeJsonValidator(label, json);
	if (typeof json !== "object" || json === null || !("colors" in json)) {
		throw new Error(`Invalid theme "${label}": expected an object with a "colors" map.`);
	}
	return json as ThemeJson;
}

function parseThemeJsonContent(label: string, content: string): ThemeJson {
	let json: unknown;
	try {
		json = JSON.parse(stripBom(content));
	} catch (error) {
		throw new Error(`Failed to parse theme ${label}: ${String(error)}`);
	}
	return parseThemeJson(label, json);
}

export function loadThemeJson(name: string): ThemeJson {
	const builtinThemes = getBuiltinThemes();
	if (name in builtinThemes) {
		return builtinThemes[name];
	}
	const registeredTheme = registeredThemes.get(name);
	if (registeredTheme?.sourcePath) {
		const content = fs.readFileSync(registeredTheme.sourcePath, "utf-8");
		return parseThemeJsonContent(registeredTheme.sourcePath, content);
	}
	if (registeredTheme) {
		throw new Error(`Theme "${name}" does not have a source path for export`);
	}
	const customThemesDir = getCustomThemesDir();
	const themePath = path.join(customThemesDir, `${name}.json`);
	if (!fs.existsSync(themePath)) {
		throw new Error(`Theme not found: ${name}`);
	}
	const content = fs.readFileSync(themePath, "utf-8");
	return parseThemeJsonContent(name, content);
}

function createTheme(themeJson: ThemeJson, mode?: TerminalColorMode, sourcePath?: string): Theme {
	const colorMode = mode ?? getTerminalColorMode();
	const resolvedColors = withThemeTokenFallbacks(resolveThemeColors(themeJson.colors, themeJson.vars));
	const { fgColors, bgColors } = splitThemeColors(resolvedColors);
	return new Theme(fgColors, bgColors, colorMode, {
		name: themeJson.name,
		sourcePath,
		appearance: themeJson.appearance,
	});
}

/** Generate the system theme from the terminal's reported colors (grayscale while they are pending). */
function createSystemTheme(mode?: TerminalColorMode): Theme {
	const generated = generateSystemThemeColors({
		...getTerminalColors(),
		saturation: areTerminalColorsPending() ? 0 : 1,
		appearanceHint: getTerminalTheme(),
	});
	const { fgColors, bgColors } = splitThemeColors(withThemeTokenFallbacks(generated.colors));
	return new Theme(fgColors, bgColors, mode ?? getTerminalColorMode(), {
		name: SYSTEM_THEME_NAME,
		appearance: generated.appearance,
		dim: generated.dim,
	});
}

export function loadThemeFromPath(themePath: string, mode?: TerminalColorMode): Theme {
	const content = fs.readFileSync(themePath, "utf-8");
	const themeJson = parseThemeJsonContent(themePath, content);
	return createTheme(themeJson, mode, themePath);
}

export function loadTheme(name: string, mode?: TerminalColorMode): Theme {
	// The system theme name is reserved: it takes precedence over custom themes of the same name.
	if (name === SYSTEM_THEME_NAME) return createSystemTheme(mode);
	const registeredTheme = registeredThemes.get(name);
	if (registeredTheme) {
		return registeredTheme;
	}
	const themeJson = loadThemeJson(name);
	return createTheme(themeJson, mode);
}

export function getThemeByName(name: string): Theme | undefined {
	try {
		return loadTheme(name);
	} catch {
		return undefined;
	}
}

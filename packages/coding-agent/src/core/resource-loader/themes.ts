import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { TerminalColorMode } from "@octocodeai/octocode-tui";
import { CONFIG_DIR_NAME } from "../../config.ts";
import type { Theme } from "../../theme/theme-class.ts";
import { loadThemeFromPath } from "../../theme/theme-loader.ts";
import type { ResourceDiagnostic } from "../diagnostics.ts";
import type { PromptTemplate } from "../prompt-templates.ts";
import { resolveResourcePath } from "./paths.ts";
import type { ResourceRoots } from "./source-info.ts";

export function loadThemes(
	roots: ResourceRoots,
	paths: string[],
	includeDefaults: boolean,
	colorMode: TerminalColorMode,
): {
	themes: Theme[];
	diagnostics: ResourceDiagnostic[];
} {
	const themes: Theme[] = [];
	const diagnostics: ResourceDiagnostic[] = [];
	if (includeDefaults) {
		const defaultDirs = [join(roots.agentDir, "themes"), join(roots.cwd, CONFIG_DIR_NAME, "themes")];

		for (const dir of defaultDirs) {
			loadThemesFromDir(dir, themes, diagnostics, colorMode);
		}
	}

	for (const p of paths) {
		const resolved = resolveResourcePath(roots.cwd, p);
		if (!existsSync(resolved)) {
			diagnostics.push({
				type: "warning",
				message: "theme path does not exist",
				path: resolved,
			});
			continue;
		}

		try {
			const stats = statSync(resolved);
			if (stats.isDirectory()) {
				loadThemesFromDir(resolved, themes, diagnostics, colorMode);
			} else if (stats.isFile() && resolved.endsWith(".json")) {
				loadThemeFromFile(resolved, themes, diagnostics, colorMode);
			} else {
				diagnostics.push({
					type: "warning",
					message: "theme path is not a json file",
					path: resolved,
				});
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : "failed to read theme path";
			diagnostics.push({ type: "warning", message, path: resolved });
		}
	}

	return { themes, diagnostics };
}

function loadThemesFromDir(
	dir: string,
	themes: Theme[],
	diagnostics: ResourceDiagnostic[],
	colorMode: TerminalColorMode,
): void {
	if (!existsSync(dir)) {
		return;
	}

	try {
		const entries = readdirSync(dir, { withFileTypes: true });
		for (const entry of entries) {
			let isFile = entry.isFile();
			if (entry.isSymbolicLink()) {
				try {
					isFile = statSync(join(dir, entry.name)).isFile();
				} catch {
					continue;
				}
			}
			if (!isFile) {
				continue;
			}
			if (!entry.name.endsWith(".json")) {
				continue;
			}
			loadThemeFromFile(join(dir, entry.name), themes, diagnostics, colorMode);
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : "failed to read theme directory";
		diagnostics.push({ type: "warning", message, path: dir });
	}
}

function loadThemeFromFile(
	filePath: string,
	themes: Theme[],
	diagnostics: ResourceDiagnostic[],
	colorMode: TerminalColorMode,
): void {
	try {
		themes.push(loadThemeFromPath(filePath, colorMode));
	} catch (error) {
		const message = error instanceof Error ? error.message : "failed to load theme";
		diagnostics.push({ type: "warning", message, path: filePath });
	}
}

export function dedupePrompts(prompts: PromptTemplate[]): {
	prompts: PromptTemplate[];
	diagnostics: ResourceDiagnostic[];
} {
	const seen = new Map<string, PromptTemplate>();
	const diagnostics: ResourceDiagnostic[] = [];

	for (const prompt of prompts) {
		const existing = seen.get(prompt.name);
		if (existing) {
			diagnostics.push({
				type: "collision",
				message: `name "/${prompt.name}" collision`,
				path: prompt.filePath,
				collision: {
					resourceType: "prompt",
					name: prompt.name,
					winnerPath: existing.filePath,
					loserPath: prompt.filePath,
				},
			});
		} else {
			seen.set(prompt.name, prompt);
		}
	}

	return { prompts: Array.from(seen.values()), diagnostics };
}

export function dedupeThemes(themes: Theme[]): {
	themes: Theme[];
	diagnostics: ResourceDiagnostic[];
} {
	const seen = new Map<string, Theme>();
	const diagnostics: ResourceDiagnostic[] = [];

	for (const t of themes) {
		const name = t.name ?? "unnamed";
		const existing = seen.get(name);
		if (existing) {
			diagnostics.push({
				type: "collision",
				message: `name "${name}" collision`,
				path: t.sourcePath,
				collision: {
					resourceType: "theme",
					name,
					winnerPath: existing.sourcePath ?? "<builtin>",
					loserPath: t.sourcePath ?? "<builtin>",
				},
			});
		} else {
			seen.set(name, t);
		}
	}

	return { themes: Array.from(seen.values()), diagnostics };
}

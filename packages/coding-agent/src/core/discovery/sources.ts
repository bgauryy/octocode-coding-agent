import { existsSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { collectAutoPromptEntries, collectAutoThemeEntries } from "../package-manager/auto-entries.ts";
import {
	collectAncestorAgentsSkillDirs,
	collectAncestorProjectSkillDirs,
	collectSkillEntries,
} from "../package-manager/discovery.ts";
import { discoverExtensionsInDir } from "../package-manager/extension-discovery.ts";
import { type ConfigRoot, configRoots, makeItem, skillName, themeName } from "./roots.ts";
import type { ConfigItem, ConfigKind, DiscoverInput } from "./types.ts";

/** Context files a directory may hold, in the order the first one found is used. */
export const CONTEXT_FILE_CANDIDATES = ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];

/** The context file a directory holds, if any. */
function findContextFile(dir: string): string | undefined {
	return CONTEXT_FILE_CANDIDATES.map((name) => join(dir, name)).find((path) => {
		try {
			return statSync(path).isFile();
		} catch {
			return false;
		}
	});
}

/** Skills: each root's `skills/`, then the shared `.agents/skills` folders. */
function skillItems(input: DiscoverInput): ConfigItem[] {
	const items: ConfigItem[] = [];
	const add = (root: Pick<ConfigRoot, "product" | "scope" | "origin">, dir: string, mode: "octocode" | "agents") => {
		for (const file of collectSkillEntries(dir, mode)) {
			items.push(makeItem("skill", skillName(file), root, file, input, { baseDir: dirname(dir) }));
		}
	};
	const roots = configRoots(input);
	const project = (product: "octocode" | "pi") =>
		roots.find((root) => root.scope === "project" && root.product === product);
	const octocodeProject = project("octocode");
	if (octocodeProject) {
		add(octocodeProject, join(octocodeProject.dir, "skills"), "octocode");
		// From a subdirectory, the repository root's folder holds project skills too.
		for (const dir of collectAncestorProjectSkillDirs(input.cwd)) add(octocodeProject, dir, "octocode");
	}
	if (input.projectTrusted || input.includeUntrusted) {
		const userAgents = join(input.home, ".agents", "skills");
		for (const dir of collectAncestorAgentsSkillDirs(input.cwd)) {
			if (resolve(dir) !== resolve(userAgents))
				add({ product: "octocode", scope: "project", origin: "agents" }, dir, "agents");
		}
	}
	const piProject = project("pi");
	if (piProject) add(piProject, join(piProject.dir, "skills"), "octocode");
	for (const root of roots) if (root.scope === "global") add(root, join(root.dir, "skills"), "octocode");
	add({ product: "octocode", scope: "global", origin: "agents" }, join(input.home, ".agents", "skills"), "agents");
	return items;
}

function directoryItems(
	kind: "prompt" | "theme",
	subdir: string,
	collect: (dir: string) => string[],
	name: (file: string) => string,
	input: DiscoverInput,
): ConfigItem[] {
	return configRoots(input).flatMap((root) =>
		collect(join(root.dir, subdir)).map((file) => makeItem(kind, name(file), root, file, input, { baseDir: root.dir })),
	);
}

/** User code Octocode does not run, found in `<root>/<subdir>` of every root that has one. */
function ignoredCodeItems(
	kind: "extension" | "hook",
	subdir: string,
	piOnly: boolean,
	input: DiscoverInput,
): ConfigItem[] {
	return configRoots(input)
		.filter((root) => !piOnly || root.product === "pi")
		.flatMap((root) =>
			discoverExtensionsInDir(join(root.dir, subdir)).map((file) =>
				makeItem(kind, basename(file), root, file, input, { baseDir: root.dir, notLoaded: "ignored-code" }),
			),
		);
}

/** The global context file of each product; project context files are loaded by `loadProjectContextFiles`. */
function contextItems(input: DiscoverInput): ConfigItem[] {
	return configRoots(input).flatMap((root) => {
		const file = root.scope === "global" ? findContextFile(root.dir) : undefined;
		return file ? [makeItem("context", "global", root, file, input)] : [];
	});
}

function namedFileItems(kind: ConfigKind, file: string, scopes: readonly string[], input: DiscoverInput): ConfigItem[] {
	return configRoots(input).flatMap((root) => {
		const path = join(root.dir, file);
		return scopes.includes(root.scope) && existsSync(path) ? [makeItem(kind, file, root, path, input)] : [];
	});
}

const promptName = (file: string): string => basename(file).replace(/\.md$/, "");

/** The file-based sources core owns. */
export const CORE_SOURCES: ReadonlyArray<{ kind: ConfigKind; discover(input: DiscoverInput): ConfigItem[] }> = [
	{ kind: "skill", discover: skillItems },
	{
		kind: "prompt",
		discover: (input) => directoryItems("prompt", "prompts", collectAutoPromptEntries, promptName, input),
	},
	{ kind: "theme", discover: (input) => directoryItems("theme", "themes", collectAutoThemeEntries, themeName, input) },
	{ kind: "extension", discover: (input) => ignoredCodeItems("extension", "extensions", false, input) },
	// Pi's `hooks/` held TypeScript hooks until Pi 0.35 merged them into extensions; Octocode's hooks are JSON files.
	{ kind: "hook", discover: (input) => ignoredCodeItems("hook", "hooks", true, input) },
	{ kind: "context", discover: contextItems },
	{
		kind: "systemPrompt",
		discover: (input) => namedFileItems("systemPrompt", "SYSTEM.md", ["project", "global"], input),
	},
	{
		kind: "appendSystemPrompt",
		discover: (input) => namedFileItems("appendSystemPrompt", "APPEND_SYSTEM.md", ["project", "global"], input),
	},
	{ kind: "keybinding", discover: (input) => namedFileItems("keybinding", "keybindings.json", ["global"], input) },
	// Both are layered files: every one that exists is read, Octocode's over Pi's and project over global within a product.
	{ kind: "model", discover: (input) => namedFileItems("model", "models.json", ["global"], input) },
	{ kind: "setting", discover: (input) => namedFileItems("setting", "settings.json", ["project", "global"], input) },
];

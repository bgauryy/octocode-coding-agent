import { basename, join, resolve } from "node:path";
import { globalPaths } from "../../../storage/state-paths.ts";
import { repoKey } from "../../../utils/git-repository.ts";
import { collectAutoPromptEntries, collectAutoThemeEntries } from "../../package-manager/auto-entries.ts";
import { collectAncestorProjectSkillDirs } from "../../package-manager/discovery.ts";
import { hostPluginStore } from "../../extensibility/host-plugins.ts";
import { insideProject } from "../../extensibility/toggles.ts";
import { inspectPluginHooks } from "../../plugin-hooks.ts";
import { resolveConfiguredPlugin } from "../../plugin-manifest.ts";
import { configuredPlugins } from "../../plugin-settings.ts";
import { makeItem, themeName } from "../roots.ts";
import {
	contextItems,
	directoryItems,
	externalSkillsEnabled,
	hookFileItems,
	listsProject,
	namedFileItems,
	productRoots,
	promptName,
	skillItemsIn,
} from "../sources.ts";
import type { ConfigItem, DiscoverInput } from "../types.ts";
import { mcpSource } from "./mcp-items.ts";
import { vendorDefaultOn } from "./switch.ts";
import type { Vendor } from "./types.ts";

const roots = (input: DiscoverInput) => productRoots(input, "octocode");

/**
 * `.octocode/skills` (and the repository root's from a subdirectory), the global directory's, Octocode's home, then the
 * Octocode skill collection, which ranks below them and above the user copies other tools install.
 */
function skills(input: DiscoverInput): ConfigItem[] {
	const project = roots(input).find((root) => root.scope === "project");
	const global = { product: "octocode", scope: "global", origin: "octocode" } as const;
	const globalDirs = [join(input.agentDir, "skills")];
	const env = input.env ?? process.env;
	const home = globalPaths(env, input.home).skills;
	if (externalSkillsEnabled(env) && resolve(home) !== resolve(globalDirs[0])) globalDirs.push(home);
	return [
		...(project
			? skillItemsIn([join(project.dir, "skills"), ...collectAncestorProjectSkillDirs(input.cwd)], project, input)
			: []),
		...skillItemsIn(globalDirs, global, input),
		...(input.builtinSkillsDir
			? skillItemsIn([input.builtinSkillsDir], { product: "octocode", scope: "builtin", origin: "bundled" }, input)
			: []),
	];
}

/** `<home>/hooks.json`, the project's `.octocode/hooks.json`, then the hook files of the configured plugins. */
function hooks(input: DiscoverInput): ConfigItem[] {
	const items = [
		...hookFileItems([globalPaths(input.env ?? process.env, input.home).hooks], "octocode", "global", input),
		...(listsProject(input)
			? hookFileItems([join(repoKey(input.cwd).root, ".octocode", "hooks.json")], "octocode", "project", input)
			: []),
	];
	for (const entry of configuredPlugins(input.plugins, () => undefined)) {
		for (const definition of inspectPluginHooks(entry).definitions) {
			const scope = insideProject(entry.path, input.cwd) ? "project" : "global";
			const root = { product: "octocode", scope, origin: "plugin" } as const;
			const item = makeItem("hook", basename(definition.source), root, definition.source, input);
			items.push(entry.enabled === false ? { ...item, loaded: false, diagnostics: ["plugin is off"] } : item);
		}
	}
	return items;
}

/**
 * The plugins in `input.plugins` (the `plugins` settings in effect): name from the manifest, a switched-off plugin not
 * loaded. One that Claude Code or Codex installed is the user's choice once named there, so it loads whatever that
 * harness's switch says; `hostPlugin` only records where it came from.
 */
function plugins(input: DiscoverInput): ConfigItem[] {
	return configuredPlugins(input.plugins, () => undefined).map((entry) => {
		const { manifest, failure, errors } = resolveConfiguredPlugin(entry);
		const scope = insideProject(entry.path, input.cwd) ? "project" : "global";
		const name = manifest?.name ?? basename(entry.path);
		const hostPlugin = hostPluginStore(entry.path, input.home, input.env ?? process.env);
		const root = { product: "octocode", scope, origin: "plugin" } as const;
		const item = makeItem("plugin", name, root, entry.path, input, hostPlugin ? { hostPlugin } : {});
		const diagnostics = [...(manifest ? [] : [failure ?? "plugin manifest not found"]), ...errors];
		const off = entry.enabled === false;
		return {
			...item,
			loaded: item.loaded && !off && !!manifest,
			diagnostics: off ? ["plugin is off", ...diagnostics] : diagnostics,
		};
	});
}

/** Octocode's own folders: `.octocode/` in the project and the global directory. Always on. */
export const octocodeVendor: Vendor = {
	id: "octocode",
	label: "Octocode",
	defaultOn: vendorDefaultOn("octocode"),
	switchable: false,
	sources: [
		{ kind: "skill", discover: skills },
		{
			kind: "prompt",
			discover: (input) =>
				directoryItems("prompt", "prompts", collectAutoPromptEntries, promptName, roots(input), input),
		},
		{
			kind: "theme",
			discover: (input) => directoryItems("theme", "themes", collectAutoThemeEntries, themeName, roots(input), input),
		},
		{ kind: "context", discover: (input) => contextItems(roots(input), input) },
		{
			kind: "systemPrompt",
			discover: (input) => namedFileItems("systemPrompt", "SYSTEM.md", ["project", "global"], roots(input), input),
		},
		{
			kind: "appendSystemPrompt",
			discover: (input) =>
				namedFileItems("appendSystemPrompt", "APPEND_SYSTEM.md", ["project", "global"], roots(input), input),
		},
		{
			kind: "keybinding",
			discover: (input) => namedFileItems("keybinding", "keybindings.json", ["global"], roots(input), input),
		},
		// Layered files: every one that exists is read, Octocode's over Pi's and project over global within a product.
		{ kind: "model", discover: (input) => namedFileItems("model", "models.json", ["global"], roots(input), input) },
		{
			kind: "setting",
			discover: (input) => namedFileItems("setting", "settings.json", ["project", "global"], roots(input), input),
		},
		{ kind: "hook", discover: hooks },
		{ kind: "plugin", discover: plugins },
		mcpSource("octocode"),
	],
};

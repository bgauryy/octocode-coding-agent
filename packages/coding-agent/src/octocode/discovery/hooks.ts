import path from "node:path";
import { makeItem } from "../../core/discovery/roots.ts";
import type { ConfigItem, DiscoverInput } from "../../core/discovery/types.ts";
import { inspectPluginHooks } from "../../core/plugin-hooks.ts";
import { configuredPlugins } from "../../core/plugin-settings.ts";
import { insideProject } from "../../core/extensibility/toggles.ts";
import { hookSources } from "./hook-files.ts";

/**
 * Hook files: Claude-format `settings.json`, Codex `hooks.json` and `config.toml` and Octocode's `hooks.json` (global, and
 * project files of a trusted folder), then the hook files of the configured plugins. The origin names the dialect.
 */
export function hookItems(input: DiscoverInput): ConfigItem[] {
	const env = input.env ?? process.env;
	const items = hookSources(input.cwd, input.projectTrusted || !!input.includeUntrusted, input.home, env).map(
		(source) =>
			makeItem(
				"hook",
				path.basename(source.path),
				{ product: "octocode", scope: source.scope === "user" ? "global" : "project", origin: source.dialect },
				source.path,
				input,
			),
	);
	for (const entry of configuredPlugins(input.plugins, () => undefined)) {
		for (const definition of inspectPluginHooks(entry).definitions) {
			const scope = insideProject(entry.path, input.cwd) ? "project" : "global";
			const item = makeItem(
				"hook",
				path.basename(definition.source),
				{ product: "octocode", scope, origin: "plugin" },
				definition.source,
				input,
			);
			if (entry.enabled === false) items.push({ ...item, loaded: false, diagnostics: ["plugin is off"] });
			else items.push(item);
		}
	}
	return items;
}

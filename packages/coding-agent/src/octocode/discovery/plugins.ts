import path from "node:path";
import { insideProject } from "../../core/extensibility/toggles.ts";
import { makeItem } from "../../core/discovery/roots.ts";
import type { ConfigItem, DiscoverInput } from "../../core/discovery/types.ts";
import { resolveConfiguredPlugin } from "../../core/plugin-manifest.ts";
import { configuredPlugins } from "../../core/plugin-settings.ts";

/** The plugins in `input.plugins` (the `plugins` settings in effect): name from the manifest, a switched-off plugin not loaded. */
export function pluginItems(input: DiscoverInput): ConfigItem[] {
	return configuredPlugins(input.plugins, () => undefined).map((entry) => {
		const { manifest, failure, errors } = resolveConfiguredPlugin(entry);
		const scope = insideProject(entry.path, input.cwd) ? "project" : "global";
		const item = makeItem(
			"plugin",
			manifest?.name ?? path.basename(entry.path),
			{ product: "octocode", scope, origin: "plugin" },
			entry.path,
			input,
		);
		const diagnostics = [...(manifest ? [] : [failure ?? "plugin manifest not found"]), ...errors];
		const off = entry.enabled === false;
		return {
			...item,
			loaded: item.loaded && !off && !!manifest,
			diagnostics: off ? ["plugin is off", ...diagnostics] : diagnostics,
		};
	});
}

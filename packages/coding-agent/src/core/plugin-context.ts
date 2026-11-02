import { realpathSync } from "node:fs";
import path from "node:path";
import { sha256 } from "../../../common/src/atomic-file.ts";
import { globalPaths } from "../octocode/shared/home.ts";
import type { PluginManifest } from "./plugin-manifest.ts";

export interface PluginContext {
	id: string;
	root: string;
	data: string;
}

/**
 * `<marketplace>/<plugin>` when `root` is an installed marketplace copy (`<home>/plugins/cache/<marketplace>/<plugin>/<sha>`).
 * Its identity and data folder are keyed by that pair, not by the commit folder, so an update keeps the plugin's data.
 */
function marketplaceKey(root: string, home?: string): string | undefined {
	const base = path.join(globalPaths(process.env, home).home, "plugins", "cache");
	try {
		const parts = path.relative(realpathSync(base), root).split(path.sep);
		return parts.length === 3 && !parts.includes("..") && parts.every(Boolean) ? `${parts[0]}/${parts[1]}` : undefined;
	} catch {
		return undefined;
	}
}

/** One local plugin identity across instruction resources and executable hooks. */
export function pluginContext(
	manifest: Pick<PluginManifest, "protocol" | "name" | "root">,
	home?: string,
): PluginContext {
	const installed = marketplaceKey(manifest.root, home);
	const id = `${manifest.protocol}:${manifest.name}:${installed ? `marketplace:${installed}` : manifest.root}`;
	return {
		id,
		root: manifest.root,
		data: path.join(path.dirname(globalPaths(process.env, home).hooks), "plugins", "data", sha256(id)),
	};
}
